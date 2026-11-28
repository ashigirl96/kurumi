import { fileURLToPath } from 'node:url'

// drizzle-kit は設定を Node で読むので、Bun だけの import.meta.dir は使えない。
export const agentRuntimeMigrations = {
  migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  migrationsTable: '__drizzle_migrations_agent_runtime',
}
