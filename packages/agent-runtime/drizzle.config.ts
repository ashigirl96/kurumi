import { defineConfig } from 'drizzle-kit'

import { agentRuntimeMigrations } from './src/migrations.ts'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  migrations: { table: agentRuntimeMigrations.migrationsTable },
})
