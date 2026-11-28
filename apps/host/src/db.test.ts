import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentRuntimeDb, saveInbound } from '@kurumi/agent-runtime/store'
import { Effect, Exit } from 'effect'
import { SqlClient } from 'effect/sql'

import { dbLayer } from './db.ts'
import { message } from './test-support.ts'

const fixture = (name: string) => ({
  migrationsFolder: join(import.meta.dir, 'fixtures/rebuild', name),
  migrationsTable: '__drizzle_migrations_fixture',
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kurumi-db-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | AgentRuntimeDb>,
  layer: ReturnType<typeof dbLayer>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)))

const names = (rows: readonly { name: string }[]) => rows.map((r) => r.name)

describe('dbLayer startup', () => {
  test('a fresh in-memory DB has every table, foreign keys on and synchronous FULL', async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const tables = yield* sql<{
          name: string
        }>`SELECT name FROM sqlite_master WHERE type = 'table'`
        const fk = yield* sql<{ foreign_keys: number }>`PRAGMA foreign_keys`
        const sync = yield* sql<{ synchronous: number }>`PRAGMA synchronous`
        return { tables: names(tables), fk: fk[0]?.foreign_keys, sync: sync[0]?.synchronous }
      }),
      dbLayer(':memory:'),
    )
    expect(result.tables).toEqual(
      expect.arrayContaining([
        'inbound_messages',
        'turns',
        'tool_calls',
        'outbound_messages',
        'sessions',
        '__drizzle_migrations_agent_runtime',
      ]),
    )
    expect(result.fk).toBe(1)
    expect(result.sync).toBe(2)
  })

  test('a file DB is in WAL mode', async () => {
    const mode = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return (yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`)[0]?.journal_mode
      }),
      dbLayer(join(dir, 'k.db')),
    )
    expect(mode).toBe('wal')
  })

  test('restarting twice keeps the saved message and the start still succeeds', async () => {
    const file = join(dir, 'k.db')
    const saveAgain = () => run(saveInbound(message('m1')), dbLayer(file))
    expect(await saveAgain()).toBe(true)
    expect(await saveAgain()).toBe(false)
    expect(await saveAgain()).toBe(false)
  })

  test('a pre-existing table that conflicts with a migration stops the start', async () => {
    const file = join(dir, 'k.db')
    const raw = new Database(file)
    raw.run('CREATE TABLE turns (x)')
    raw.close()
    const exit = await Effect.runPromiseExit(Effect.void.pipe(Effect.provide(dbLayer(file))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain('already exists')
  })

  test('a foreign key violation already in the file stops the next start', async () => {
    const file = join(dir, 'k.db')
    await run(Effect.void, dbLayer(file))
    const raw = new Database(file)
    raw.run('PRAGMA foreign_keys = OFF')
    raw.run(
      "INSERT INTO inbound_messages (channel, conversation, platform_message_id, sender, body, received_at, turn_id) VALUES ('c', 'v', 'm', 's', 'b', 0, 999)",
    )
    raw.close()
    const exit = await Effect.runPromiseExit(Effect.void.pipe(Effect.provide(dbLayer(file))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain('ForeignKeyViolations')
  })

  test('a table-rebuild migration passes over rows that reference the rebuilt table', async () => {
    const file = join(dir, 'k.db')
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO turns (id, session_id) VALUES (1, 's')`
        yield* sql`INSERT INTO inbound_messages (id, turn_id) VALUES (1, 1)`
      }),
      dbLayer(file, [fixture('migrations-v1')]),
    )
    const after = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const ddl = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE name = 'turns'`
        const refs = yield* sql<{ turn_id: number }>`SELECT turn_id FROM inbound_messages`
        const target = yield* sql<{ table: string }>`PRAGMA foreign_key_list(inbound_messages)`
        return {
          ddl: ddl[0]?.sql,
          refs: refs.map((r) => r.turn_id),
          target: target.map((r) => r.table),
        }
      }),
      dbLayer(file, [fixture('migrations-v2')]),
    )
    expect(after.ddl).toContain('UNIQUE')
    expect(after.refs).toEqual([1])
    expect(after.target).toEqual(['turns'])
  })
})
