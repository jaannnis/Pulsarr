import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import type {
  SonarrAddOptions,
  SonarrPost,
  SonarrSeries,
  SonarrItem as Item,
  SonarrConfiguration,
  PagedResult,
  RootFolder,
  QualityProfile,
  SonarrInstance,
  ConnectionTestResult,
  PingResponse,
  WebhookNotification,
} from '@root/types/sonarr.types.js'

export class SonarrService {
  private config: SonarrConfiguration | null = null
  private webhookInitialized = false
  private instanceId?: number // The current instance ID (set during initialization)
  private tagsCache: Map<number, Array<{ id: number; label: string }>> =
    new Map()
  private tagsCacheExpiry: Map<number, number> = new Map()
  private TAG_CACHE_TTL = 30000 // 30 seconds in milliseconds

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly appBaseUrl: string,
    private readonly port: number,
    private readonly fastify: FastifyInstance,
  ) {}

  private get sonarrConfig(): SonarrConfiguration {
    if (!this.config) {
      throw new Error('Sonarr service not initialized')
    }
    return this.config
  }

  private constructWebhookUrl(): string {
    let url: URL

    try {
      // Try to parse as a complete URL
      url = new URL(this.appBaseUrl)
    } catch (error) {
      // If parsing fails, assume it's a hostname without protocol
      url = new URL(`http://${this.appBaseUrl}`)
    }

    // If there's no explicit port in the URL already
    if (!url.port) {
      // For HTTPS protocol, don't add a port (use default 443)
      if (url.protocol === 'https:') {
        // Leave port empty
      } else {
        // For all other protocols (including HTTP), add the configured port
        url.port = this.port.toString()
      }
    }

    // Set the webhook path
    url.pathname = '/v1/notifications/webhook'

    // Add instance identifier for tracking
    const urlIdentifier = this.sonarrConfig.sonarrBaseUrl
      .replace(/https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]/g, '')

    url.searchParams.append('instanceId', urlIdentifier)

    return url.toString()
  }

  private async setupWebhook(): Promise<void> {
    if (this.webhookInitialized) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      const expectedWebhookUrl = this.constructWebhookUrl()
      this.log.info(
        `Credentials verified, attempting to setup webhook with URL for Sonarr: ${expectedWebhookUrl}`,
      )

      const existingWebhooks =
        await this.getFromSonarr<WebhookNotification[]>('notification')
      const existingPulsarrWebhook = existingWebhooks.find(
        (hook) => hook.name === 'Pulsarr',
      )

      if (existingPulsarrWebhook) {
        const currentWebhookUrl = existingPulsarrWebhook.fields.find(
          (field) => field.name === 'url',
        )?.value

        if (currentWebhookUrl === expectedWebhookUrl) {
          this.log.info('Pulsarr Sonarr webhook exists with correct URL')
          return
        }

        this.log.info(
          'Pulsarr webhook URL mismatch, recreating webhook for Sonarr',
        )
        await this.deleteNotification(existingPulsarrWebhook.id)
      }

      const webhookConfig = {
        onGrab: false,
        onDownload: true,
        onUpgrade: true,
        onImportComplete: true,
        onRename: false,
        onSeriesAdd: false,
        onSeriesDelete: false,
        onEpisodeFileDelete: false,
        onEpisodeFileDeleteForUpgrade: false,
        onHealthIssue: false,
        includeHealthWarnings: false,
        onHealthRestored: false,
        onApplicationUpdate: false,
        onManualInteractionRequired: false,
        supportsOnGrab: true,
        supportsOnDownload: true,
        supportsOnUpgrade: true,
        supportsOnImportComplete: true,
        supportsOnRename: true,
        supportsOnSeriesAdd: true,
        supportsOnSeriesDelete: true,
        supportsOnEpisodeFileDelete: true,
        supportsOnEpisodeFileDeleteForUpgrade: true,
        supportsOnHealthIssue: true,
        supportsOnHealthRestored: true,
        supportsOnApplicationUpdate: true,
        supportsOnManualInteractionRequired: true,
        name: 'Pulsarr',
        fields: [
          {
            order: 0,
            name: 'url',
            label: 'Webhook URL',
            value: expectedWebhookUrl,
            type: 'url',
            advanced: false,
          },
          {
            order: 1,
            name: 'method',
            label: 'Method',
            value: 1,
            type: 'select',
            advanced: false,
          },
        ],
        implementationName: 'Webhook',
        implementation: 'Webhook',
        configContract: 'WebhookSettings',
        infoLink: 'https://wiki.servarr.com/sonarr/supported#webhook',
        tags: [],
      }

      try {
        const response = await this.postToSonarr('notification', webhookConfig)
        this.log.info(
          `Successfully created Pulsarr webhook with URL for Sonarr: ${expectedWebhookUrl}`,
        )
        this.log.debug('Webhook creation response:', response)
      } catch (createError) {
        this.log.error(
          'Error creating webhook for Sonarr. Full config:',
          webhookConfig,
        )
        this.log.error('Creation error details for Sonarr:', createError)
        throw createError
      }
      this.webhookInitialized = true
    } catch (error) {
      this.log.error('Failed to setup webhook for Sonarr:', error)
      throw error
    }
  }

  async removeWebhook(): Promise<void> {
    try {
      const existingWebhooks =
        await this.getFromSonarr<WebhookNotification[]>('notification')
      const pulsarrWebhook = existingWebhooks.find(
        (hook) => hook.name === 'Pulsarr',
      )

      if (pulsarrWebhook) {
        await this.deleteNotification(pulsarrWebhook.id)
        this.log.info('Successfully removed Pulsarr webhook for Sonarr')
      }
    } catch (error) {
      this.log.error('Failed to remove webhook for Sonarr:', error)
      throw error
    }
  }

  private async deleteNotification(notificationId: number): Promise<void> {
    const config = this.sonarrConfig
    const url = new URL(
      `${config.sonarrBaseUrl}/api/v3/notification/${notificationId}`,
    )

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: {
        'X-Api-Key': config.sonarrApiKey,
      },
    })

    if (!response.ok) {
      throw new Error(`Sonarr API error: ${response.statusText}`)
    }
  }

  async initialize(instance: SonarrInstance): Promise<void> {
    try {
      if (!instance.baseUrl || !instance.apiKey) {
        throw new Error(
          'Invalid Sonarr configuration: baseUrl and apiKey are required',
        )
      }

      // Store the instance ID for caching purposes
      this.instanceId = instance.id

      // Skip webhook setup for placeholder credentials
      if (instance.apiKey === 'placeholder') {
        this.log.info(
          `Basic initialization only for ${instance.name} (placeholder credentials)`,
        )
        this.config = {
          sonarrBaseUrl: instance.baseUrl,
          sonarrApiKey: instance.apiKey,
          sonarrQualityProfileId: instance.qualityProfile || null,
          sonarrLanguageProfileId: 1,
          sonarrRootFolder: instance.rootFolder || null,
          sonarrTagIds: instance.tags,
          sonarrSeasonMonitoring: instance.seasonMonitoring,
          sonarrMonitorNewItems: instance.monitorNewItems || 'all',
          sonarrSeriesType: instance.seriesType || 'standard',
        }
        return
      }

      this.config = {
        sonarrBaseUrl: instance.baseUrl,
        sonarrApiKey: instance.apiKey,
        sonarrQualityProfileId: instance.qualityProfile || null,
        sonarrLanguageProfileId: 1,
        sonarrRootFolder: instance.rootFolder || null,
        sonarrTagIds: instance.tags,
        sonarrSeasonMonitoring: instance.seasonMonitoring,
        sonarrMonitorNewItems: instance.monitorNewItems || 'all',
        searchOnAdd:
          instance.searchOnAdd !== undefined ? instance.searchOnAdd : true,
        sonarrSeriesType: instance.seriesType || 'standard',
      }

      this.log.info(
        `Successfully initialized base Sonarr service for ${instance.name}`,
      )

      if (this.fastify.server.listening) {
        await this.setupWebhook()
      } else {
        this.fastify.server.prependOnceListener('listening', async () => {
          try {
            await this.setupWebhook()
          } catch (error) {
            this.log.error(
              `Failed to setup webhook for instance ${instance.name} after server start for Sonarr:`,
              error,
            )
          }
        })
      }
    } catch (error) {
      this.log.error(
        `Failed to initialize Sonarr service for instance ${instance.name}:`,
        error,
      )
      throw error
    }
  }

  async testConnection(
    baseUrl: string,
    apiKey: string,
  ): Promise<ConnectionTestResult> {
    try {
      if (!baseUrl || !apiKey) {
        return {
          success: false,
          message: 'Base URL and API key are required',
        }
      }

      // Use system/status API endpoint for basic connectivity
      const statusUrl = new URL(`${baseUrl}/api/v3/system/status`)
      const response = await fetch(statusUrl.toString(), {
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        return {
          success: false,
          message: `Connection failed: ${response.statusText}`,
        }
      }

      // Validate we're connecting to a Servarr application
      try {
        const statusResponse = await response.json() as Record<string, unknown>
        
        // Check for valid object
        if (!statusResponse || typeof statusResponse !== 'object') {
          return {
            success: false,
            message: 'Invalid response from server',
          }
        }
        
        // Validate this is a Servarr application by checking appName
        if (
          !('appName' in statusResponse) || 
          typeof statusResponse.appName !== 'string' || 
          !statusResponse.appName.toLowerCase().includes('arr')
        ) {
          return {
            success: false,
            message: 'Connected service does not appear to be a valid Servarr application',
          }
        }
      } catch (parseError) {
        return {
          success: false,
          message: 'Failed to parse response from server',
        }
      }

      // Now check if we can access the notifications API to verify webhook capabilities
      // This tests permission levels and API completeness
      try {
        // Create a helper function to make a GET request without modifying service state
        const rawGet = async <T>(endpoint: string): Promise<T> => {
          const url = new URL(`${baseUrl}/api/v3/${endpoint}`)
          const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
              'X-Api-Key': apiKey,
              Accept: 'application/json',
            },
          })

          if (!response.ok) {
            throw new Error(`Sonarr API error: ${response.statusText}`)
          }

          return response.json() as Promise<T>
        }

        // Test notifications API access with dedicated helper function
        try {
          await rawGet<WebhookNotification[]>('notification')

          // If we got here, API access for notifications works
          return {
            success: true,
            message: 'Connection successful and webhook API accessible',
          }
        } catch (notificationError) {
          return {
            success: false,
            message:
              'Connected to Sonarr but cannot access notification API. Check API key permissions.',
          }
        }
      } catch (error) {
        // If something else went wrong in the notification check
        return {
          success: false,
          message:
            'Connected to Sonarr but webhook testing failed. Please check API key and permissions.',
        }
      }
    } catch (error) {
      this.log.error('Connection test error:', error)
      return {
        success: false,
        message:
          error instanceof Error ? error.message : 'Unknown connection error',
      }
    }
  }

  private async verifyConnection(instance: SonarrInstance): Promise<unknown> {
    const url = new URL(`${instance.baseUrl}/api/v3/system/status`)
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Api-Key': instance.apiKey,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Connection verification failed: ${response.statusText}`)
    }

    return response.json()
  }

  private toItem(series: SonarrSeries): Item {
    const hasEpisodes =
      series.seasons?.some(
        (season) =>
          season.statistics?.episodeFileCount &&
          season.statistics.episodeFileCount > 0,
      ) ?? false
    return {
      title: series.title,
      guids: [
        series.imdbId,
        series.tvdbId ? `tvdb:${series.tvdbId}` : undefined,
        `sonarr:${series.id}`,
      ].filter((x): x is string => !!x),
      type: 'show',
      ended: series.ended,
      added: series.added,
      status: hasEpisodes ? 'grabbed' : 'requested',
      series_status: series.ended ? 'ended' : 'continuing',
    }
  }

  async fetchQualityProfiles(): Promise<QualityProfile[]> {
    try {
      const profiles =
        await this.getFromSonarr<QualityProfile[]>('qualityprofile')
      return profiles
    } catch (err) {
      this.log.error(`Error fetching quality profiles: ${err}`)
      throw err
    }
  }

  async fetchRootFolders(): Promise<RootFolder[]> {
    try {
      const rootFolders = await this.getFromSonarr<RootFolder[]>('rootfolder')
      return rootFolders
    } catch (err) {
      this.log.error(`Error fetching root folders: ${err}`)
      throw err
    }
  }

  async fetchSeries(bypass = false): Promise<Set<Item>> {
    try {
      const shows = await this.getFromSonarr<SonarrSeries[]>('series')

      let exclusions: Set<Item> = new Set()
      if (!bypass) {
        exclusions = await this.fetchExclusions()
      }

      const showItems = shows.map((show) => this.toItem(show))
      return new Set([...showItems, ...exclusions])
    } catch (err) {
      this.log.error(`Error fetching series: ${err}`)
      throw err
    }
  }

  async fetchExclusions(pageSize = 1000): Promise<Set<Item>> {
    const config = this.sonarrConfig
    try {
      let currentPage = 1
      let totalRecords = 0
      const allExclusions: SonarrSeries[] = []

      do {
        const url = new URL(
          `${config.sonarrBaseUrl}/api/v3/importlistexclusion/paged`,
        )
        url.searchParams.append('page', currentPage.toString())
        url.searchParams.append('pageSize', pageSize.toString())
        url.searchParams.append('sortDirection', 'ascending')
        url.searchParams.append('sortKey', 'title')

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'X-Api-Key': config.sonarrApiKey,
            Accept: 'application/json',
          },
        })

        if (!response.ok) {
          throw new Error(`Sonarr API error: ${response.statusText}`)
        }

        const pagedResult = (await response.json()) as PagedResult<SonarrSeries>
        totalRecords = pagedResult.totalRecords
        allExclusions.push(...pagedResult.records)

        this.log.debug(
          `Fetched page ${currentPage} of exclusions (${pagedResult.records.length} records)`,
        )
        currentPage++
      } while (allExclusions.length < totalRecords)

      this.log.info(`Fetched all show ${allExclusions.length} exclusions`)
      return new Set(allExclusions.map((show) => this.toItem(show)))
    } catch (err) {
      this.log.error(`Error fetching exclusions: ${err}`)
      throw err
    }
  }

  private isNumericQualityProfile(
    value: string | number | null,
  ): value is number {
    if (value === null) return false
    if (typeof value === 'number') return true
    return /^\d+$/.test(value)
  }

  private async resolveRootFolder(
    overrideRootFolder?: string,
  ): Promise<string> {
    const rootFolderPath =
      overrideRootFolder || this.sonarrConfig.sonarrRootFolder
    if (rootFolderPath) return rootFolderPath

    const rootFolders = await this.fetchRootFolders()
    if (rootFolders.length === 0) {
      throw new Error('No root folders configured in Sonarr')
    }

    const defaultPath = rootFolders[0].path
    this.log.info(`Using root folder: ${defaultPath}`)
    return defaultPath
  }

  private async resolveQualityProfileId(
    profiles: QualityProfile[],
  ): Promise<number> {
    const configProfile = this.sonarrConfig.sonarrQualityProfileId

    if (profiles.length === 0) {
      throw new Error('No quality profiles configured in Sonarr')
    }

    if (configProfile === null) {
      const defaultId = profiles[0].id
      this.log.info(
        `Using default quality profile: ${profiles[0].name} (ID: ${defaultId})`,
      )
      return defaultId
    }

    if (this.isNumericQualityProfile(configProfile)) {
      return Number(configProfile)
    }

    const matchingProfile = profiles.find(
      (profile) =>
        profile.name.toLowerCase() === configProfile.toString().toLowerCase(),
    )

    if (matchingProfile) {
      this.log.info(
        `Using matched quality profile: ${matchingProfile.name} (ID: ${matchingProfile.id})`,
      )
      return matchingProfile.id
    }

    this.log.warn(
      `Could not find quality profile "${configProfile}". Available profiles: ${profiles.map((p) => p.name).join(', ')}`,
    )
    const fallbackId = profiles[0].id
    this.log.info(
      `Falling back to first quality profile: ${profiles[0].name} (ID: ${fallbackId})`,
    )
    return fallbackId
  }

  async addToSonarr(
    item: Item,
    overrideRootFolder?: string,
    overrideQualityProfileId?: number | string | null,
    overrideTags?: string[],
    overrideSearchOnAdd?: boolean | null,
    overrideSeasonMonitoring?: string | null,
    overrideSeriesType?: 'standard' | 'anime' | 'daily' | null,
  ): Promise<void> {
    const config = this.sonarrConfig
    try {
      // Check if searchOnAdd parameter or property exists and use it, otherwise default to true
      const shouldSearch =
        overrideSearchOnAdd !== undefined && overrideSearchOnAdd !== null
          ? overrideSearchOnAdd
          : config.searchOnAdd !== undefined
            ? config.searchOnAdd
            : true

      // Season monitoring strategy - prefer override, then config, then default to 'all'
      const monitorStrategy =
        overrideSeasonMonitoring && overrideSeasonMonitoring !== null
          ? overrideSeasonMonitoring
          : config.sonarrSeasonMonitoring || 'all'

      const addOptions: SonarrAddOptions = {
        monitor: monitorStrategy,
        searchForCutoffUnmetEpisodes: shouldSearch,
        searchForMissingEpisodes: shouldSearch,
      }

      const tvdbId = item.guids
        .find((guid) => guid.startsWith('tvdb:'))
        ?.replace('tvdb:', '')

      const rootFolderPath = await this.resolveRootFolder(overrideRootFolder)

      const qualityProfiles = await this.fetchQualityProfiles()
      const qualityProfileId =
        overrideQualityProfileId !== undefined
          ? overrideQualityProfileId
          : await this.resolveQualityProfileId(qualityProfiles)

      // Collection for valid tag IDs (using Set to avoid duplicates)
      const tagIdsSet = new Set<string>()

      // Process override tags if provided
      if (overrideTags && overrideTags.length > 0) {
        // Get all existing tags from Sonarr
        const existingTags = await this.getTags()

        // Process each tag from the override
        for (const tagInput of overrideTags) {
          // Handle numeric tag IDs
          if (/^\d+$/.test(tagInput)) {
            const tagId = tagInput.toString()
            // Only use the tag ID if it exists in Sonarr
            const tagExists = existingTags.some(
              (t) => t.id.toString() === tagId,
            )

            if (tagExists) {
              this.log.debug(`Using existing tag ID: ${tagId}`)
              tagIdsSet.add(tagId)
              continue
            }

            this.log.warn(
              `Tag ID ${tagId} not found in Sonarr - skipping this tag`,
            )
            continue
          }

          // Handle tag names
          const tag = existingTags.find((t) => t.label === tagInput)

          if (!tag) {
            this.log.warn(
              `Tag "${tagInput}" not found in Sonarr - skipping this tag`,
            )
            continue
          }

          tagIdsSet.add(tag.id.toString())
        }
      } else if (config.sonarrTagIds) {
        // Use default tags from config, but still validate they exist
        if (
          Array.isArray(config.sonarrTagIds) &&
          config.sonarrTagIds.length > 0
        ) {
          const existingTags = await this.getTags()

          for (const tagId of config.sonarrTagIds) {
            const stringTagId = tagId.toString()
            const tagExists = existingTags.some(
              (t) => t.id.toString() === stringTagId,
            )

            if (tagExists) {
              tagIdsSet.add(stringTagId)
            } else {
              this.log.warn(
                `Config tag ID ${stringTagId} not found in Sonarr - skipping this tag`,
              )
            }
          }
        }
      }

      // Convert Set back to array for the API
      const tags = Array.from(tagIdsSet)

      // Series type - prefer override, then config, then default to 'standard'
      const seriesType =
        overrideSeriesType && overrideSeriesType !== null
          ? overrideSeriesType
          : config.sonarrSeriesType || 'standard'

      const show: SonarrPost = {
        title: item.title,
        tvdbId: tvdbId ? Number.parseInt(tvdbId, 10) : 0,
        qualityProfileId,
        rootFolderPath,
        addOptions,
        languageProfileId: null,
        monitored: true,
        monitorNewItems: config.sonarrMonitorNewItems || 'all',
        tags,
        seriesType,
      }

      await this.postToSonarr<void>('series', show)
      this.log.info(
        `Sent ${item.title} to Sonarr (Quality Profile: ${qualityProfileId}, Root Folder: ${rootFolderPath}, Tags: ${tags.length > 0 ? tags.join(', ') : 'none'}, Series Type: ${seriesType})`,
      )
    } catch (err) {
      this.log.debug(
        `Received warning for sending ${item.title} to Sonarr: ${err}`,
      )
      throw err
    }
  }

  async deleteFromSonarr(item: Item, deleteFiles: boolean): Promise<void> {
    const config = this.sonarrConfig
    try {
      const sonarrGuid = item.guids.find((guid) => guid.startsWith('sonarr:'))
      const tvdbGuid = item.guids.find((guid) => guid.startsWith('tvdb:'))

      if (!sonarrGuid && !tvdbGuid) {
        this.log.warn(
          `Unable to extract ID from show to delete: ${JSON.stringify(item)}`,
        )
        return
      }

      let sonarrId: number | undefined

      if (sonarrGuid) {
        sonarrId = Number.parseInt(sonarrGuid.replace('sonarr:', ''), 10)
      } else if (tvdbGuid) {
        const tvdbId = tvdbGuid.replace('tvdb:', '')
        const allSeries = await this.fetchSeries(true)
        const matchingSeries = [...allSeries].find((show) =>
          show.guids.some(
            (guid) =>
              guid.startsWith('tvdb:') && guid.replace('tvdb:', '') === tvdbId,
          ),
        )
        if (!matchingSeries) {
          throw new Error(`Could not find show with TVDB ID: ${tvdbId}`)
        }
        const matchingSonarrGuid = matchingSeries.guids.find((guid) =>
          guid.startsWith('sonarr:'),
        )
        if (!matchingSonarrGuid) {
          throw new Error('Could not find Sonarr ID for show')
        }
        sonarrId = Number.parseInt(
          matchingSonarrGuid.replace('sonarr:', ''),
          10,
        )
      }

      if (sonarrId === undefined || Number.isNaN(sonarrId)) {
        throw new Error('Failed to obtain valid Sonarr ID')
      }

      await this.deleteFromSonarrById(sonarrId, deleteFiles)
      this.log.info(`Deleted ${item.title} from Sonarr`)
    } catch (err) {
      this.log.error(`Error deleting from Sonarr: ${err}`)
      throw err
    }
  }

  async getFromSonarr<T>(endpoint: string): Promise<T> {
    const config = this.sonarrConfig
    const url = new URL(`${config.sonarrBaseUrl}/api/v3/${endpoint}`)
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Api-Key': config.sonarrApiKey,
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Sonarr API error: ${response.statusText}`)
    }

    return response.json() as Promise<T>
  }

  private async postToSonarr<T>(
    endpoint: string,
    payload: unknown,
  ): Promise<T> {
    const config = this.sonarrConfig
    const url = new URL(`${config.sonarrBaseUrl}/api/v3/${endpoint}`)
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'X-Api-Key': config.sonarrApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`Sonarr API error: ${response.statusText}`)
    }

    return response.json() as Promise<T>
  }

  private async deleteFromSonarrById(
    id: number,
    deleteFiles: boolean,
  ): Promise<void> {
    const config = this.sonarrConfig
    const url = new URL(`${config.sonarrBaseUrl}/api/v3/series/${id}`)
    url.searchParams.append('deleteFiles', deleteFiles.toString())
    url.searchParams.append('addImportListExclusion', 'false')

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: {
        'X-Api-Key': config.sonarrApiKey,
      },
    })

    if (!response.ok) {
      throw new Error(`Sonarr API error: ${response.statusText}`)
    }
  }

  async configurePlexNotification(
    plexToken: string,
    plexHost: string,
    plexPort: number,
    useSsl: boolean,
  ): Promise<void> {
    try {
      // First, check if Plex server connection already exists
      const existingNotifications =
        await this.getFromSonarr<WebhookNotification[]>('notification')
      const existingPlexNotification = existingNotifications.find(
        (n) => n.implementation === 'PlexServer',
      )

      if (existingPlexNotification) {
        // Update existing notification
        await this.deleteNotification(existingPlexNotification.id)
      }

      // Create notification configuration
      const plexConfig = {
        onGrab: false,
        onDownload: true,
        onUpgrade: true,
        onRename: true,
        onSeriesDelete: true,
        onEpisodeFileDelete: true,
        onEpisodeFileDeleteForUpgrade: true,
        onHealthIssue: false,
        onApplicationUpdate: false,
        supportsOnGrab: false,
        supportsOnDownload: true,
        supportsOnUpgrade: true,
        supportsOnRename: true,
        supportsOnSeriesDelete: true,
        supportsOnEpisodeFileDelete: true,
        supportsOnEpisodeFileDeleteForUpgrade: true,
        supportsOnHealthIssue: false,
        supportsOnApplicationUpdate: false,
        includeHealthWarnings: false,
        name: 'Plex Media Server',
        fields: [
          {
            name: 'host',
            value: plexHost,
          },
          {
            name: 'port',
            value: plexPort,
          },
          {
            name: 'useSsl',
            value: useSsl,
          },
          {
            name: 'authToken',
            value: plexToken,
          },
          {
            name: 'updateLibrary',
            value: true,
          },
        ],
        implementationName: 'Plex Media Server',
        implementation: 'PlexServer',
        configContract: 'PlexServerSettings',
        infoLink: 'https://wiki.servarr.com/sonarr/supported#plexserver',
        tags: [],
      }

      // Add the notification to Sonarr
      await this.postToSonarr('notification', plexConfig)
      this.log.info('Successfully configured Plex notification for Sonarr')
    } catch (error) {
      this.log.error('Error configuring Plex notification for Sonarr:', error)
      throw error
    }
  }

  async removePlexNotification(): Promise<void> {
    try {
      // Find Plex server notification
      const existingNotifications =
        await this.getFromSonarr<WebhookNotification[]>('notification')
      const existingPlexNotification = existingNotifications.find(
        (n) => n.implementation === 'PlexServer',
      )

      if (existingPlexNotification) {
        // Delete the notification
        await this.deleteNotification(existingPlexNotification.id)
        this.log.info('Successfully removed Plex notification from Sonarr')
      } else {
        this.log.info('No Plex notification found to remove from Sonarr')
      }
    } catch (error) {
      this.log.error('Error removing Plex notification from Sonarr:', error)
      throw error
    }
  }

  /**
   * Get all tags from Sonarr with caching
   *
   * @returns Promise resolving to an array of tags
   */
  async getTags(): Promise<Array<{ id: number; label: string }>> {
    // Skip cache if service not properly initialized or no instance ID
    if (!this.instanceId) {
      return this.getTagsWithoutCache()
    }

    const now = Date.now()
    const cacheExpiry = this.tagsCacheExpiry.get(this.instanceId)

    // Return cached data if valid
    if (
      cacheExpiry &&
      now < cacheExpiry &&
      this.tagsCache.has(this.instanceId)
    ) {
      this.log.debug(`Using cached tags for Sonarr instance ${this.instanceId}`)
      const cachedTags = this.tagsCache.get(this.instanceId)
      return cachedTags || []
    }

    return this.refreshTagsCache(this.instanceId)
  }

  /**
   * Get tags directly from Sonarr without using cache
   *
   * @private
   * @returns Promise resolving to array of tags
   */
  private async getTagsWithoutCache(): Promise<
    Array<{ id: number; label: string }>
  > {
    return await this.getFromSonarr<Array<{ id: number; label: string }>>('tag')
  }

  /**
   * Refresh the tags cache for this instance
   *
   * @private
   * @param instanceId The instance ID to refresh cache for
   * @returns Promise resolving to array of tags
   */
  private async refreshTagsCache(
    instanceId: number,
  ): Promise<Array<{ id: number; label: string }>> {
    try {
      const tags = await this.getTagsWithoutCache()

      // Update cache with fresh data
      this.tagsCache.set(instanceId, tags)
      this.tagsCacheExpiry.set(instanceId, Date.now() + this.TAG_CACHE_TTL)

      return tags
    } catch (error) {
      this.log.error(
        `Failed to refresh tags cache for Sonarr instance ${instanceId}:`,
        error,
      )

      // If cache refresh fails but we have stale data, return that
      if (this.tagsCache.has(instanceId)) {
        this.log.warn(
          `Using stale tags cache for Sonarr instance ${instanceId}`,
        )
        const cachedTags = this.tagsCache.get(instanceId)
        return cachedTags || []
      }

      throw error
    }
  }

  /**
   * Invalidate the tags cache for this instance
   * Should be called whenever tags are created or deleted
   */
  public invalidateTagsCache(): void {
    if (this.instanceId) {
      this.tagsCache.delete(this.instanceId)
      this.tagsCacheExpiry.delete(this.instanceId)
      this.log.debug(
        `Invalidated tags cache for Sonarr instance ${this.instanceId}`,
      )
    }
  }

  /**
   * Create a new tag in Sonarr
   *
   * @param label Tag label
   * @returns Promise resolving to the created tag
   */
  async createTag(label: string): Promise<{ id: number; label: string }> {
    try {
      const result = await this.postToSonarr<{ id: number; label: string }>(
        'tag',
        {
          label,
        },
      )

      // Invalidate the tags cache since we've added a new tag
      this.invalidateTagsCache()

      return result
    } catch (err) {
      if (
        err instanceof Error &&
        /409/.test(err.message) // Sonarr returns 409 Conflict if the tag exists
      ) {
        this.log.debug(
          `Tag "${label}" already exists in Sonarr – skipping creation`,
        )
        // Fetch the existing tag so we can return its id
        const existing = (await this.getTags()).find((t) => t.label === label)
        if (existing) return existing
      }
      throw err
    }
  }

  /**
   * Update the tags for a specific series
   *
   * @param seriesId The Sonarr series ID
   * @param tagIds Array of tag IDs to apply
   * @returns Promise resolving when the update is complete
   */
  async updateSeriesTags(seriesId: number, tagIds: number[]): Promise<void> {
    try {
      // First get the current series to preserve all fields
      const series = await this.getFromSonarr<
        SonarrSeries & { tags: number[] }
      >(`series/${seriesId}`)

      // Use Set to deduplicate tags
      series.tags = [...new Set(tagIds)]

      // Send the update
      await this.putToSonarr(`series/${seriesId}`, series)

      this.log.debug(`Updated tags for series ID ${seriesId}`, { tagIds })
    } catch (error) {
      this.log.error(`Failed to update tags for series ${seriesId}:`, error)
      throw error
    }
  }

  /**
   * Update a resource in Sonarr using PUT
   *
   * @param endpoint API endpoint
   * @param payload The data to send
   * @returns Promise resolving to the response or void for 204 responses
   */
  async putToSonarr<T>(
    endpoint: string,
    payload: unknown,
  ): Promise<T | undefined> {
    const config = this.sonarrConfig
    const url = new URL(`${config.sonarrBaseUrl}/api/v3/${endpoint}`)
    const response = await fetch(url.toString(), {
      method: 'PUT',
      headers: {
        'X-Api-Key': config.sonarrApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      throw new Error(`Sonarr API error: ${response.statusText}`)
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return undefined
    }

    return response.json() as Promise<T>
  }

  /**
   * Delete a tag from Sonarr
   *
   * @param tagId The ID of the tag to delete
   * @returns Promise resolving when the delete operation is complete
   */
  async deleteTag(tagId: number): Promise<void> {
    const config = this.sonarrConfig
    const url = new URL(`${config.sonarrBaseUrl}/api/v3/tag/${tagId}`)

    const response = await fetch(url.toString(), {
      method: 'DELETE',
      headers: {
        'X-Api-Key': config.sonarrApiKey,
      },
    })

    if (!response.ok) {
      throw new Error(`Sonarr API error: ${response.statusText}`)
    }

    // Invalidate the tags cache since we've deleted a tag
    this.invalidateTagsCache()
  }
}
