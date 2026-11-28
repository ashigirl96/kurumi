import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { receive } from "@kurumi/inbox"
import { createTurn } from "@kurumi/turn"
import { DbLive } from "../src/db.ts"

// Each runPromise builds the layer anew, so every test gets its own migrated :memory: database.
const runFresh = <A, E>(eff: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.runPromise(Effect.provide(eff, DbLive(":memory:")))

for (let i = 0; i < 20; i++) {
  test(`fresh db #${i}`, async () => {
    const t = performance.now()
    const n = await runFresh(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* createTurn("s")
      expect(yield* receive(`P-${i}`, "x")).toBe(true)
      return (yield* sql<{ n: number }>`SELECT (SELECT count(*) FROM turns) + (SELECT count(*) FROM inbound_messages) n`)[0]!.n
    }))
    expect(n).toBe(2) // fresh: only this test's rows
    console.log(`#${i} ${(performance.now() - t).toFixed(2)}ms`)
  })
}
