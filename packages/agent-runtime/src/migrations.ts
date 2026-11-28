export const agentRuntimeMigrations = {
  migrationsFolder: new URL('../migrations', import.meta.url).pathname,
  migrationsTable: '__drizzle_migrations_agent_runtime',
}
