import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as turn from "@k/turn/schema";
import * as inbox from "@k/inbox/schema";

export const schema = { ...turn, ...inbox };

export function openDb(filename: string, { fk = true } = {}) {
  const client = new Database(filename, { strict: true });
  if (fk) client.run("PRAGMA foreign_keys = ON");
  const db = drizzle({ client, schema });
  migrate(db, { migrationsFolder: `${import.meta.dir}/drizzle` });
  return db;
}
