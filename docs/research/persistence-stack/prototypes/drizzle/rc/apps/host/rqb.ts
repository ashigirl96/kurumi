import { Effect } from "effect";
import { defineRelations, defineRelationsPart, sql } from "drizzle-orm";
import * as Drizzle from "drizzle-orm/effect-sqlite-bun";
import { migrate } from "drizzle-orm/effect-sqlite-bun/migrator";
import { turns } from "@k/turn/schema";
import { inboundMessages } from "@k/inbox/schema";
import { sqliteLayer } from "./db";
const schema = { turns, inboundMessages };
// base part owned by host; inbox contributes its own part (would live in packages/inbox)
const base = defineRelations(schema);
const inboxPart = defineRelationsPart(schema, (r) => ({
  inboundMessages: { turn: r.one.turns({ from: r.inboundMessages.turnId, to: r.turns.id }) },
  turns: { inbound: r.many.inboundMessages() },
}));
const prog = Effect.gen(function* () {
  const db = yield* Drizzle.makeWithDefaults({ relations: { ...base, ...inboxPart } });
  yield* migrate(db, { migrationsFolder: `${import.meta.dir}/drizzle` });
  const [t] = yield* db.insert(turns).values({ sessionId: "s", state: "queued" }).returning();
  yield* db.insert(inboundMessages).values([{ platformMessageId: "a", body: "a", turnId: t!.id }, { platformMessageId: "b", body: "b", turnId: t!.id }]);
  const r = yield* db.query.turns.findMany({ with: { inbound: { columns: { platformMessageId: true } } }, columns: { id: true, state: true } });
  console.log("rqb v2 via effect driver:", JSON.stringify(r));
});
await Effect.runPromise(Effect.scoped(prog).pipe(Effect.provide(sqliteLayer(":memory:"))));
