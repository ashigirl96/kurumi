import { Effect } from "effect";
import type { Db } from "./db";
import { inboundMessages } from "@k/inbox/schema";
declare const db: Db;
const ins = db.insert(inboundMessages).values({ platformMessageId: "x", body: "x" });
type InsE = Effect.Error<typeof ins>;
const showIns: "show" = null as unknown as InsE;
const tx = db.transaction((t) => t.insert(inboundMessages).values({ platformMessageId: "x", body: "x" }).pipe(Effect.andThen(Effect.fail("domain" as const))));
const showTx: "show" = null as unknown as Effect.Error<typeof tx>;
