import type { Knex } from 'knex'

/**
 * Applies a migration that adds the `is_primary_token` column to the `users` table, creates a unique index for rows where this flag is true, and sets the first user named "token1" as the primary token user if present.
 *
 * @remark
 * The unique index `idx_unique_primary_token` ensures that only one user can have `is_primary_token` set to true in SQLite databases.
 */
export async function up(knex: Knex): Promise<void> {
  // Add the column first
  await knex.schema.alterTable('users', (table) => {
    // Add a flag to identify the primary token user
    table.boolean('is_primary_token').defaultTo(false)
  })
  
  // For SQLite, create a unique index that only applies when is_primary_token = true
  await knex.raw(`
    CREATE UNIQUE INDEX idx_unique_primary_token ON users (is_primary_token) 
    WHERE is_primary_token = 1
  `)
  
  // Set the first user named "token1" as primary if it exists
  const token1User = await knex('users').where('name', 'token1').first()
  if (token1User) {
    console.log(`Setting existing token1 user (ID: ${token1User.id}) as primary token user`)
    await knex('users')
      .where('id', token1User.id)
      .update({ is_primary_token: true })
  } else {
    console.log('No "token1" user found, skipping primary user setup in migration')
  }
}

/**
 * Reverts the migration by dropping the unique index on `is_primary_token` and removing the column from the `users` table.
 */
export async function down(knex: Knex): Promise<void> {
  // Drop the unique index
  await knex.raw(`DROP INDEX IF EXISTS idx_unique_primary_token`)
  
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('is_primary_token')
  })
}