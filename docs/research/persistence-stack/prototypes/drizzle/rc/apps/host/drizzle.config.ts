import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: ["../../packages/*/src/schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: "./kurumi.db" },
});
