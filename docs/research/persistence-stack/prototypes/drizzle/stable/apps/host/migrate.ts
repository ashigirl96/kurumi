import { Database } from "bun:sqlite";
import { openDb } from "./db";
const file = process.argv[2]!;
openDb(file);
const c = new Database(file);
console.log("applied:", JSON.stringify(c.query("select id, hash, created_at from __drizzle_migrations").all().map((r: any) => [r.id, r.hash.slice(0, 8), r.created_at])));
console.log("turns cols:", c.query("select name from pragma_table_info('turns')").all().map((r: any) => r.name).join(","));
