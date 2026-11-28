import { openDb } from "./db";
const db = openDb(":memory:");
const r = db.transaction(async (tx) => { await 0; });
const showAsync: "show" = r;
