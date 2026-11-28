import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
const mode = process.argv[2];
const c = new Database(":memory:"); c.run("PRAGMA foreign_keys=ON");
const db = drizzle({ client: c });
const order = mode === "inbox-first" ? ["inbox", "turn"] : ["turn", "inbox"];
for (const p of order) migrate(db, { migrationsFolder: `${import.meta.dir}/out-${p}`, migrationsTable: mode === "shared-table" ? "__drizzle_migrations" : `__drizzle_migrations_${p}` });
console.log(mode, "tables:", c.query("select name from sqlite_master where type='table' order by name").all().map((r: any) => r.name).join(","));
