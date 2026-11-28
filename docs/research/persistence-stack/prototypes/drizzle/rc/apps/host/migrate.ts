import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { makeDb, sqliteLayer } from "./db";
const file = process.argv[2]!;
await Effect.runPromise(Effect.scoped(makeDb()).pipe(Effect.provide(sqliteLayer(file))));
const c = new Database(file);
console.log("applied:", JSON.stringify(c.query("select id, name, substr(hash,1,8) h from __drizzle_migrations").all().map((r: any) => [r.id, r.name, r.h])));
console.log("turns cols:", c.query("select name from pragma_table_info('turns')").all().map((r: any) => r.name).join(","));
