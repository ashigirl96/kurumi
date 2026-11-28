import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "../../../packages/turn/src/schema.ts", out: "./out-turn", migrations: { table: "__drizzle_migrations_turn" } });
