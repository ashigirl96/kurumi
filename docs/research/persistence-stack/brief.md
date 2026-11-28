# Common brief: Kurumi persistence stack investigation (read-only + throwaway prototypes)

## Goal
The operator is choosing the persistence stack for Kurumi before implementation. Output is evidence for a later decision session, not a decision and not production code. You own one slice; the parent synthesizes.

Kurumi: a single-user personal agent platform on one host. TypeScript + Bun (1.4.4 locally) + Effect 4 used host-wide + SQLite. Monorepo modelled on the operator's Monica repo: `apps/*` for applications, `packages/<domain>` for domains, and **each domain package owns its own schema definitions and domain logic**. The central question: with schema living in each domain package, where do the DB connection and migrations naturally live, and how do cross-domain transactions and foreign keys work?

Options under comparison:
1. Drizzle ORM + bun:sqlite (no Effect SQL)
2. Effect SQL (`@effect/sql-sqlite-bun` / `effect/unstable/sql` in Effect 4)
3. Effect SQL + Drizzle ORM (Drizzle 1.0 RC `drizzle-orm/effect-sqlite-bun`, or `@effect/sql-drizzle`)
4. bun:sqlite used directly

Evaluation axes: Effect affinity; per-domain schema ownership; migration generation and application; cross-domain transactions and foreign keys; SQLite connection management and concurrency; type safety and error handling; ease of testing; implementation complexity and maintainability.

## Kurumi facts that shape persistence (from the agreed spec, GitHub issue ashigirl96/kurumi#1, and docs/adr in the kurumi repo)
- Only the host process writes SQLite. One process, one DB file. No other process opens it for writing.
- Tables planned for the Agent Runtime: `inbound_messages` (unique platform message id, INSERT OR IGNORE before acking the platform; assigned turn), `turns` (state machine queued/running/closing/completed/failed/interrupted; prompt_uuid, last_assistant_uuid), `tool_calls` (host write-ahead record written inside a PreToolUse hook before the tool is allowed; if the write fails the tool is blocked), `outbound_messages` (pending/sending/delivered, dedup key), `sessions`. Other domains (channels, schedules, later Credential Gateway audit) will add tables.
- Concurrency: up to 3 turns run at once across sessions, one per session; each turn's hook writes, stream writes, outbound delivery and inbound receipt all happen as concurrent fibers in the one host process. Startup recovery marks running turns interrupted.
- The spec currently says "use Effect's Bun SQL client; skip Drizzle for now because its Effect integration is RC; this default may change". That is the claim under test, not a settled decision.

## Already measured in this session (do not redo, build on it)
- `drizzle-orm@1.0.0-rc.6` + `drizzle-orm/effect-sqlite-bun` `makeWithDefaults()` + `@effect/sql-sqlite-bun@4.1.6` `SqliteClient.layer({filename: ":memory:"})` + `effect@4.1.6` on Bun 1.4.4: create table, insert, select worked. The same code lives in prototypes/drizzle/rc.
- `drizzle-orm@0.45.4` `drizzle-orm/bun-sqlite` insert/select worked (試作 drizzle/stable).
- `@effect/sql-drizzle@0.51` and `@effect/sql@0.52` are Effect 3 era packages; check before assuming they work with Effect 4.

## Shared prototype scenario (use exactly this so options compare)
Bun workspace with `apps/host` and two domain packages:
- `packages/inbox` owns `inbound_messages(id integer pk, platform_message_id text unique not null, body text not null, turn_id integer null references turns(id))`.
- `packages/turn` owns `turns(id integer pk, session_id text not null, state text not null check in (...))`.
Note the FK points from inbox to turn, so the inbox package needs to reference the turn table: record how each option expresses that and what package dependency it forces.
Checks, each printed as an observable line:
1. Migrations: generate (if the option has a generator) and apply on a fresh file DB; apply again (no-op); add a second migration that adds a column to `turns`; apply. Show where migration files live and who runs them.
2. Idempotent receipt: insert the same platform_message_id twice; exactly one row.
3. Cross-domain transaction: create a turn and assign two inbound messages to it atomically; then force a failure after the first statement and show full rollback.
4. Concurrency inside one process: two fibers/async tasks each open a transaction on the same client concurrently (one does insert, awaits/sleeps 50ms, inserts again, then fails and rolls back; the other inserts one row and commits). Show whether the committing task's row survives and the failing task's rows are gone, i.e. whether statements from one task leak into the other's open transaction. This is the most important check.
5. FK enforcement: insert an inbound message with a nonexistent turn_id; show whether it is rejected (PRAGMA foreign_keys).
6. Test ergonomics: a `bun test` file that gives each test a fresh migrated `:memory:` DB; report wall time per test.
7. Error shape: what type/value a unique violation and an FK violation surface as (typed error channel vs thrown exception), quoted.

## Rules
- Evidence from official docs and library source code (read `node_modules` sources and the upstream repos). Tag every claim: `code (path:line)`, `docs (url)`, `measured`, or `inferred`. Never present inference as measured.
- Work only under `<scratchpad>/inv3/<your-name>/`. Never edit the kurumi or monica repos. `bun add` inside your dir is fine; no global installs.
- No Claude model calls and no secrets are needed. Do not read any token.
- Prototype playbook: throwaway, speed over polish, no abstractions. The printed output is the evidence.
- Record exact package versions you used and npm dist-tags (`npm view <pkg> dist-tags`) for anything RC/beta.

## Report
Write `REPORT.md` in your dir: dense, cite throughout, 1500-3000 words. Include for each option you own: directory layout (tree), minimal code (schema in a domain package, client/connection layer, migration, one cross-domain transaction, one test), results of checks 1-7 with pasted output, and a per-axis assessment. End with what you could not verify. Final message under 600 words: verdicts first, each with evidence.
