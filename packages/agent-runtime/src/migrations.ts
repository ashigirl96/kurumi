import { join } from 'node:path'

export const agentRuntimeMigrations = {
  migrationsFolder: join(import.meta.dir, '../migrations'),
  migrationsTable: '__drizzle_migrations_agent_runtime',
}
