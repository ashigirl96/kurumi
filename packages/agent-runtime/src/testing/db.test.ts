import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import { sessions } from '../schema.ts'
import { AgentRuntimeDb } from '../store.ts'
import { testDbLayer } from './db.ts'

const session = (id: string, channel: string, status: 'active' | 'lost' = 'active') => ({
  id,
  channel,
  conversation: 'c1',
  agent: 'a',
  configDir: `/cfg/${id}`,
  workspaceDir: `/work/${id}`,
  status,
})

const insertAll = (...rows: ReturnType<typeof session>[]) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    for (const row of rows) yield* db.insert(sessions).values(row)
  })

const run = <A, E>(effect: Effect.Effect<A, E, AgentRuntimeDb>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testDbLayer)))

describe('sessions の active 一意制約', () => {
  test('同じ channel と conversation に active を 2 つ入れると失敗する', async () => {
    const failure = await run(
      Effect.flip(insertAll(session('s1', 'slack'), session('s2', 'slack'))),
    )
    expect(String(failure.cause)).toContain('UNIQUE')
  })

  test('片方が lost なら入る', async () => {
    await run(insertAll(session('s1', 'slack', 'lost'), session('s2', 'slack')))
  })

  test('channel が違えば同じ conversation に active を入れられる', async () => {
    await run(insertAll(session('s1', 'slack'), session('s2', 'discord')))
  })
})
