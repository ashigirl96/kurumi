import { beforeEach, expect, test } from "bun:test";
import { openDb } from "./db";
import { turns } from "@k/turn/schema";
import { inboundMessages } from "@k/inbox/schema";

let db: ReturnType<typeof openDb>;
let t0 = 0;
beforeEach(() => { t0 = performance.now(); db = openDb(":memory:"); });
const done = (name: string) => console.log(`  ${name}: ${(performance.now() - t0).toFixed(2)}ms incl. fresh migrated db`);

for (let i = 0; i < 5; i++) {
  test(`receipt is idempotent #${i}`, () => {
    db.insert(inboundMessages).values({ platformMessageId: "m", body: "b" }).onConflictDoNothing().run();
    db.insert(inboundMessages).values({ platformMessageId: "m", body: "b" }).onConflictDoNothing().run();
    expect(db.select().from(inboundMessages).all()).toHaveLength(1);
    done(`idempotent #${i}`);
  });
}
test("assign is atomic", () => {
  db.insert(inboundMessages).values({ platformMessageId: "a", body: "a" }).run();
  expect(() => db.transaction((tx) => {
    const t = tx.insert(turns).values({ sessionId: "s", state: "queued" }).returning().get();
    tx.update(inboundMessages).set({ turnId: t.id }).run();
    throw new Error("x");
  })).toThrow("x");
  expect(db.select().from(turns).all()).toHaveLength(0);
  done("atomic");
});
