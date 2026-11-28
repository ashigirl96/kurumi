import { beforeEach, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { makeDb, sqliteLayer, type Db } from "./db";
import { turns } from "@k/turn/schema";
import { inboundMessages } from "@k/inbox/schema";

// Each test runs its program against a fresh migrated :memory: db.
const run = <A, E>(f: (db: Db) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeDb(), f)).pipe(Effect.provide(sqliteLayer(":memory:"))));

let t0 = 0;
beforeEach(() => { t0 = performance.now(); });
const done = (name: string) => console.log(`  ${name}: ${(performance.now() - t0).toFixed(2)}ms incl. fresh migrated db`);

for (let i = 0; i < 5; i++) {
  test(`receipt is idempotent #${i}`, async () => {
    const rows = await run((db) => Effect.gen(function* () {
      yield* db.insert(inboundMessages).values({ platformMessageId: "m", body: "b" }).onConflictDoNothing();
      yield* db.insert(inboundMessages).values({ platformMessageId: "m", body: "b" }).onConflictDoNothing();
      return yield* db.select().from(inboundMessages);
    }));
    expect(rows).toHaveLength(1);
    done(`idempotent #${i}`);
  });
}
test("assign is atomic", async () => {
  const [exit, n] = await run((db) => Effect.gen(function* () {
    yield* db.insert(inboundMessages).values({ platformMessageId: "a", body: "a" });
    const exit = yield* Effect.exit(db.transaction((tx) => Effect.gen(function* () {
      const [t] = yield* tx.insert(turns).values({ sessionId: "s", state: "queued" }).returning();
      yield* tx.update(inboundMessages).set({ turnId: t!.id });
      return yield* Effect.fail("x");
    })));
    return [exit, (yield* db.select().from(turns)).length] as const;
  }));
  expect(Exit.isFailure(exit)).toBe(true);
  expect(n).toBe(0);
  done("atomic");
});
