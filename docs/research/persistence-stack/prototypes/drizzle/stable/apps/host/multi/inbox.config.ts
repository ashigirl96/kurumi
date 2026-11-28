import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "../../../packages/inbox/src/schema.ts", out: "./out-inbox", migrations: { table: "__drizzle_migrations_inbox" } });
