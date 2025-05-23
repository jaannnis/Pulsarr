import type { Knex } from 'knex'

/**
 * Adds `removedTagMode` and `removedTagPrefix` columns to the `configs` table if it exists.
 *
 * Sets `removedTagMode` to `'keep'` for existing config rows where `persistHistoricalTags` is `true`; otherwise, sets it to `'remove'`.
 */
export async function up(knex: Knex): Promise<void> {
  // Check if the table exists before attempting to modify
  const configExists = await knex.schema.hasTable('configs')
  
  if (configExists) {
    // Add the new columns to the schema using the camelCase naming convention 
    // (same as other configs table columns like tagUsersInSonarr)
    await knex.schema.alterTable('configs', (table) => {
      table.string('removedTagMode').defaultTo('remove')
      table.string('removedTagPrefix').defaultTo('pulsarr:removed')
    })
    
    // Get the current config
    const config = await knex('configs').first()
    
    if (config) {
      const updates: Record<string, any> = {}
      
      // Update removedTagMode based on persistHistoricalTags
      if (config.persistHistoricalTags === true) {
        updates.removedTagMode = 'keep'
      } else {
        updates.removedTagMode = 'remove'
      }
      
      // Apply the updates
      if (Object.keys(updates).length > 0) {
        await knex('configs').update(updates)
      }
    }
  }
}

/**
 * Drops the `removedTagMode` and `removedTagPrefix` columns from the `configs` table if it exists.
 *
 * Reverts the schema changes introduced by the `up` migration.
 */
export async function down(knex: Knex): Promise<void> {
  // Check if the table exists before attempting to modify
  const configExists = await knex.schema.hasTable('configs')
  
  if (configExists) {
    // Drop the columns added in the up migration
    await knex.schema.alterTable('configs', (table) => {
      table.dropColumn('removedTagMode')
      table.dropColumn('removedTagPrefix')
    })
  }
}