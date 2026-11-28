import { Cause, Effect, Exit, Fiber } from "effect";
import { eq, sql } from "drizzle-orm";
import { makeDb, sqliteLayer } from "./db";
import { turns } from "@k/turn/schema";
import { inboundMessages } from "@k/inbox/schema";

const log = (...a: unknown[]) => Effect.sync(() => console.log(...a));
const logAt = (f: () => string) => Effect.sync(() => console.log(f()));
const errShape = (e: any): string => {
  if (!e || typeof e !== "object") return String(e);
  const inner = Cause.isCause(e.cause) ? Cause.squash(e.cause) : e.cause;
  const reason = e.reason ? ` reason._tag=${e.reason._tag}` : "";
  return `_tag=${e._tag ?? e.constructor?.name}${reason} msg=${JSON.stringify(String(e.message).slice(0, 110))}${inner ? ` -> cause: ${errShape(inner)}` : ""}`;
};

const program = Effect.gen(function* () {
  const db = yield* makeDb();
  const ids = () => db.select({ s: turns.sessionId }).from(turns).pipe(Effect.map((r) => r.map((x) => x.s)));
  const reset = Effect.all([db.delete(inboundMessages), db.delete(turns)]);

  yield* log("## 2 idempotent receipt (onConflictDoNothing)");
  for (let i = 0; i < 2; i++) {
    const r: any = yield* db.insert(inboundMessages).values({ platformMessageId: "m1", body: "hi" }).onConflictDoNothing();
    yield* log(`  insert #${i + 1} result=${JSON.stringify(r)}`);
  }
  yield* log(`  rows with m1: ${(yield* db.select().from(inboundMessages).where(eq(inboundMessages.platformMessageId, "m1"))).length}`);
  yield* reset;

  yield* log("## 3 cross-domain transaction");
  const seed = db.insert(inboundMessages).values([{ platformMessageId: "a", body: "a" }, { platformMessageId: "b", body: "b" }]);
  const msgs = db.select({ p: inboundMessages.platformMessageId, t: inboundMessages.turnId }).from(inboundMessages);
  yield* seed;
  yield* db.transaction((tx) => Effect.gen(function* () {
    const [t] = yield* tx.insert(turns).values({ sessionId: "s1", state: "queued" }).returning();
    yield* tx.update(inboundMessages).set({ turnId: t!.id }).where(sql`${inboundMessages.platformMessageId} in ('a','b')`);
  }));
  yield* log("  ok path:", JSON.stringify(yield* msgs), "turns=", (yield* ids()).length);
  yield* reset; yield* seed;
  const exit = yield* Effect.exit(db.transaction((tx) => Effect.gen(function* () {
    const [t] = yield* tx.insert(turns).values({ sessionId: "s1", state: "queued" }).returning();
    yield* tx.update(inboundMessages).set({ turnId: t!.id }).where(eq(inboundMessages.platformMessageId, "a"));
    return yield* Effect.fail("forced" as const);
  })));
  yield* log("  forced failure exit:", Exit.isFailure(exit) ? `Failure(${JSON.stringify(Cause.squash(exit.cause))})` : "Success");
  yield* log("  after rollback:", JSON.stringify(yield* msgs), "turns=", (yield* ids()).length);
  yield* reset;

  yield* log("## 4 concurrency on one client");
  let t0 = Date.now();
  const mark = Effect.sync(() => { t0 = Date.now(); });
  const at = () => `${String(Date.now() - t0).padStart(3)}ms`;
  const A = (useOuterDb: boolean) => db.transaction((tx) => Effect.gen(function* () {
    const h = useOuterDb ? db : tx;
    yield* h.insert(turns).values({ sessionId: "A1", state: "queued" });
    yield* logAt(() => `  [${at()}] A: inserted A1, sleeping 50ms inside tx`);
    yield* Effect.sleep("50 millis");
    yield* h.insert(turns).values({ sessionId: "A2", state: "queued" });
    return yield* Effect.fail("A fails" as const);
  })).pipe(Effect.exit, Effect.tap((e) => logAt(() => `  [${at()}] A: exit ${Exit.isFailure(e) ? "Failure" : "Success"}`)));
  const Btx = Effect.sleep("10 millis").pipe(
    Effect.andThen(logAt(() => `  [${at()}] B: starting tx`)),
    Effect.andThen(db.transaction((tx) => tx.insert(turns).values({ sessionId: "B1", state: "queued" }))),
    Effect.andThen(logAt(() => `  [${at()}] B: committed`)));
  const Bplain = Effect.sleep("10 millis").pipe(
    Effect.andThen(logAt(() => `  [${at()}] B: starting plain insert (no tx)`)),
    Effect.andThen(db.insert(turns).values({ sessionId: "B1-plain", state: "queued" })),
    Effect.andThen(logAt(() => `  [${at()}] B: plain insert done`)));

  yield* log("  4a: A tx (insert, sleep 50ms, insert, fail) || B tx insert+commit");
  yield* mark; yield* Effect.all([A(false), Btx], { concurrency: "unbounded" });
  yield* log("  rows:", JSON.stringify(yield* ids()), "(isolated => [B1])");
  yield* reset;

  yield* log("  4b: A tx || B non-transactional insert on the same db");
  yield* mark; yield* Effect.all([A(false), Bplain], { concurrency: "unbounded" });
  yield* log("  rows:", JSON.stringify(yield* ids()));
  yield* reset;

  yield* log("  4c: A uses the outer `db` handle (not tx) inside its transaction callback || B tx");
  yield* mark; yield* Effect.all([A(true), Btx], { concurrency: "unbounded" });
  yield* log("  rows:", JSON.stringify(yield* ids()), "(fiber-scoped tx => outer db joins A's tx, so A1/A2 roll back)");
  yield* reset;

  yield* log("  4d: fiber forked inside A's tx writes via db, A then fails");
  yield* Effect.exit(db.transaction(() => Effect.gen(function* () {
    const f = yield* Effect.forkChild(db.insert(turns).values({ sessionId: "child", state: "queued" }));
    yield* Fiber.join(f);
    return yield* Effect.fail("A fails" as const);
  })));
  yield* log("  rows:", JSON.stringify(yield* ids()));
  yield* reset;

  yield* log("## 7 error shape (typed channel)");
  yield* db.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" });
  const u = yield* Effect.flip(db.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" }));
  yield* log("  unique:", errShape(u));
  const f = yield* Effect.flip(db.insert(inboundMessages).values({ platformMessageId: "fk", body: "x", turnId: 999 }));
  yield* log("  fk:    ", errShape(f));
  const ctx = yield* Effect.flip(db.transaction((tx) => tx.insert(inboundMessages).values({ platformMessageId: "dup", body: "x" })));
  yield* log("  unique inside tx:", errShape(ctx));
});

const fkCheck = Effect.gen(function* () {
  yield* log("## 5 FK enforcement");
  const off = yield* makeDb({ fk: false });
  const r = yield* Effect.exit(off.insert(inboundMessages).values({ platformMessageId: "x", body: "x", turnId: 999 }));
  yield* log(`  PRAGMA foreign_keys untouched (SqliteClient default): ${Exit.isSuccess(r) ? "ACCEPTED turn_id=999" : "rejected"}`);
});

await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(sqliteLayer(":memory:"))));
await Effect.runPromise(Effect.scoped(fkCheck).pipe(Effect.provide(sqliteLayer(":memory:"))));
await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const on = yield* makeDb();
  const r = yield* Effect.exit(on.insert(inboundMessages).values({ platformMessageId: "x", body: "x", turnId: 999 }));
  yield* log(`  PRAGMA foreign_keys = ON: ${Exit.isSuccess(r) ? "ACCEPTED" : "rejected"}`);
})).pipe(Effect.provide(sqliteLayer(":memory:"))));
