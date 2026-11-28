import { SQLiteError } from "bun:sqlite";
import { openDb } from "./db";
import { inboundMessages } from "@k/inbox/schema";
const db = openDb(":memory:");
db.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" }).run();
try { db.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" }).run(); } catch (e: any) { console.log("name=", e.name, "instanceof SQLiteError=", e instanceof SQLiteError, "errno=", e.errno, "keys=", Object.keys(e)); }
