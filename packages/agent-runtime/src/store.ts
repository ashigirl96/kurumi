import { defineRelations } from 'drizzle-orm'
import * as Drizzle from 'drizzle-orm/effect-sqlite-bun'
import { Context, type Effect, Layer } from 'effect'

import * as schema from './schema.ts'

const relations = defineRelations(schema)

export class AgentRuntimeDb extends Context.Service<
  AgentRuntimeDb,
  Effect.Success<ReturnType<typeof Drizzle.makeWithDefaults<typeof relations>>>
>()('@kurumi/agent-runtime/AgentRuntimeDb') {
  static readonly layer = Layer.effect(AgentRuntimeDb, Drizzle.makeWithDefaults({ relations }))
}
