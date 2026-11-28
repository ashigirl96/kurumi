import { Effect, Layer } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as Drizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { sql } from "drizzle-orm";

export const makeDb = (opts: { fk?: boolean } = {}) =>
  Effect.gen(function* () {
    const db = yield* Drizzle.makeWithDefaults();
    if (opts.fk !== false) yield* db.run(sql`PRAGMA foreign_keys = ON`);
    yield* migrate(db, { migrationsFolder: `${import.meta.dir}/drizzle` });
    return db;
  });

export type Db = Effect.Success<ReturnType<typeof makeDb>>;
export const sqliteLayer = (filename: string) => SqliteClient.layer({ filename });
