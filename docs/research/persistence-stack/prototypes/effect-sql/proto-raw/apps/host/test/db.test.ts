import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { receive } from "@kurumi/inbox"
import { createTurn } from "@kurumi/turn"
import { migrate } from "../src/db.ts"

for (let i = 0; i < 20; i++) {
  test(`fresh db #${i}`, () => {
    const t = performance.now()
    const db = new Database(":memory:", { strict: true }); db.run("PRAGMA foreign_keys = ON"); migrate(db)
    createTurn(db, "s")
    expect(receive(db, `P-${i}`, "x")).toBe(true)
    expect(db.query<{ n: number }, []>("SELECT (SELECT count(*) FROM turns) + (SELECT count(*) FROM inbound_messages) n").get()!.n).toBe(2)
    db.close()
    console.log(`#${i} ${(performance.now() - t).toFixed(2)}ms`)
  })
}
