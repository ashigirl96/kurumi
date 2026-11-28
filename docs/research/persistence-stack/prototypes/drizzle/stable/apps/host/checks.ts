import { eq, sql } from "drizzle-orm";
import { openDb } from "./db";
import { turns } from "@k/turn/schema";
import { inboundMessages } from "@k/inbox/schema";

const db = openDb(":memory:");
const count = (t: typeof turns | typeof inboundMessages) => db.select({ n: sql<number>`count(*)` }).from(t).get()!.n;
const reset = () => { db.delete(inboundMessages).run(); db.delete(turns).run(); };
const errShape = (e: any) => `${e?.constructor?.name} code=${e?.code ?? e?.cause?.code} msg=${JSON.stringify(String(e?.message).slice(0, 120))} cause=${e?.cause ? `${e.cause.constructor.name}(${e.cause.code})` : "none"}`;

console.log("## 2 idempotent receipt (onConflictDoNothing)");
for (let i = 0; i < 2; i++) {
  const r = db.insert(inboundMessages).values({ platformMessageId: "m1", body: "hi" }).onConflictDoNothing().run();
  console.log(`  insert #${i + 1} changes=${r.changes}`);
}
console.log(`  rows with m1: ${db.select().from(inboundMessages).where(eq(inboundMessages.platformMessageId, "m1")).all().length}`);
reset();

console.log("## 3 cross-domain transaction");
db.insert(inboundMessages).values([{ platformMessageId: "a", body: "a" }, { platformMessageId: "b", body: "b" }]).run();
db.transaction((tx) => {
  const t = tx.insert(turns).values({ sessionId: "s1", state: "queued" }).returning().get();
  tx.update(inboundMessages).set({ turnId: t.id }).where(sql`${inboundMessages.platformMessageId} in ('a','b')`).run();
});
console.log("  ok path:", JSON.stringify(db.select({ p: inboundMessages.platformMessageId, t: inboundMessages.turnId }).from(inboundMessages).all()), "turns=", count(turns));
reset();
db.insert(inboundMessages).values([{ platformMessageId: "a", body: "a" }, { platformMessageId: "b", body: "b" }]).run();
try {
  db.transaction((tx) => {
    const t = tx.insert(turns).values({ sessionId: "s1", state: "queued" }).returning().get();
    tx.update(inboundMessages).set({ turnId: t.id }).where(eq(inboundMessages.platformMessageId, "a")).run();
    throw new Error("forced");
  });
} catch (e) { console.log("  forced failure caught:", (e as Error).message); }
console.log("  after rollback:", JSON.stringify(db.select({ p: inboundMessages.platformMessageId, t: inboundMessages.turnId }).from(inboundMessages).all()), "turns=", count(turns));
reset();

console.log("## 4 concurrency on one connection");
console.log("  4a: async callback with await inside, plus a concurrent committing task");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = (async () => {
  try {
    // drizzle types allow this: transaction<T>(fn: (tx) => T)
    await db.transaction(async (tx) => {
      tx.insert(turns).values({ sessionId: "A1", state: "queued" }).run();
      await sleep(50);
      tx.insert(turns).values({ sessionId: "A2", state: "queued" }).run();
      throw new Error("A fails");
    });
    console.log("  A: transaction promise resolved");
  } catch (e) { console.log("  A: rejected with", (e as Error).message); }
})();
const B = (async () => {
  await sleep(10);
  db.transaction((tx) => { tx.insert(turns).values({ sessionId: "B1", state: "queued" }).run(); });
  console.log("  B: committed");
})();
await Promise.all([A, B]);
console.log("  rows:", JSON.stringify(db.select({ s: turns.sessionId }).from(turns).all().map((r) => r.s)), "(expected [B1] if isolated)");
reset();

console.log("  4b: B is two sync transactions interleaved with A's manual BEGIN..await..ROLLBACK (raw session)");
const A2 = (async () => {
  db.run(sql`BEGIN`);
  db.insert(turns).values({ sessionId: "A1", state: "queued" }).run();
  await sleep(50);
  db.insert(turns).values({ sessionId: "A2", state: "queued" }).run();
  db.run(sql`ROLLBACK`);
  console.log("  A: rolled back");
})();
const B2 = (async () => {
  await sleep(10);
  try { db.transaction((tx) => { tx.insert(turns).values({ sessionId: "B1", state: "queued" }).run(); }); console.log("  B: committed"); }
  catch (e) { console.log("  B: failed:", errShape(e)); db.insert(turns).values({ sessionId: "B1-autocommit", state: "queued" }).run(); console.log("  B: fell back to plain insert (no tx)"); }
})();
await Promise.all([A2, B2]);
console.log("  rows:", JSON.stringify(db.select({ s: turns.sessionId }).from(turns).all().map((r) => r.s)));
reset();

console.log("  4c: sync callbacks only (the supported shape), A fails, B commits");
const A3 = (async () => { await sleep(0); try { db.transaction((tx) => { tx.insert(turns).values({ sessionId: "A1", state: "queued" }).run(); tx.insert(turns).values({ sessionId: "A2", state: "queued" }).run(); throw new Error("A fails"); }); } catch (e) { console.log("  A:", (e as Error).message); } })();
const B3 = (async () => { await sleep(0); db.transaction((tx) => { tx.insert(turns).values({ sessionId: "B1", state: "queued" }).run(); }); console.log("  B: committed"); })();
await Promise.all([A3, B3]);
console.log("  rows:", JSON.stringify(db.select({ s: turns.sessionId }).from(turns).all().map((r) => r.s)));
reset();

console.log("## 5 FK enforcement");
const dbNoFk = openDb(":memory:", { fk: false });
try { dbNoFk.insert(inboundMessages).values({ platformMessageId: "x", body: "x", turnId: 999 }).run(); console.log("  PRAGMA foreign_keys off (bun default): ACCEPTED turn_id=999"); } catch (e) { console.log("  off: rejected", errShape(e)); }
try { db.insert(inboundMessages).values({ platformMessageId: "x", body: "x", turnId: 999 }).run(); console.log("  on: ACCEPTED"); } catch (e) { console.log("  PRAGMA foreign_keys=ON: rejected"); }

console.log("## 7 error shape");
db.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" }).run();
try { db.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" }).run(); } catch (e) { console.log("  unique:", errShape(e)); }
try { db.insert(inboundMessages).values({ platformMessageId: "fk", body: "x", turnId: 999 }).run(); } catch (e) { console.log("  fk:    ", errShape(e)); }
