import { Effect } from "effect";
import * as Drizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { sql } from "drizzle-orm";
const mode = process.argv[2]!;
const prog = Effect.gen(function* () {
  const db = yield* Drizzle.makeWithDefaults();
  for (const p of ["turn", "inbox"]) yield* migrate(db, { migrationsFolder: `${import.meta.dir}/out-${p}`, migrationsTable: mode === "shared-table" ? "__drizzle_migrations" : `__drizzle_migrations_${p}` });
  const rows: any = yield* db.all(sql`select name from sqlite_master where type='table' order by name`);
  console.log(mode, "tables:", rows.map((r: any) => r.name ?? r[0]).join(","));
});
await Effect.runPromise(Effect.scoped(prog).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))));
