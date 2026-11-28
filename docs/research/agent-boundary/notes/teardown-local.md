# Source teardown: NanoClaw fork, OneCLI 1.45 and v2, executor

Slice S2a of `docs/research/agent-boundary/brief.md`. Read-only. Nothing here was run against a live system; every "measured" below is someone else's measurement and says whose. Tags: `code (path:line)`, `docs (url)`, `inferred`, `argued` (assumptions listed).

## Versions read

| Project | What | Commit / tag |
|---|---|---|
| NanoClaw fork | `~/.ghq/src/github.com/ashigirl96/nanoclaw` `main` | `9fbee967` (2026-11-27). Upstream is `nanocoai/nanoclaw`; the fork is not a GitHub fork object (`gh api repos/ashigirl96/nanoclaw` → `parent: null`). Contains the GHSA-j39m fix (`.claude/skills/add-onecli/scripts/postgres-password.ts` present). |
| OneCLI 1.45 | `git archive v1.45.0` into `teardown-local/onecli-1.45/` | `84ccaf74` (2026-07-31). NanoClaw pin: `onecli-gateway 1.45.0`, `onecli-sdk 2.2.1`, `onecli-cli 2.11.0` (`.claude/skills/add-onecli/versions.json`). |
| OneCLI v2 | local clone HEAD | `9319d08b` = v2.14.0 (2026-10-14). Latest upstream release is v2.20.0 (2026-11-09) per `gh api repos/onecli/onecli/releases`; not read. |
| executor | `~/.ghq/src/github.com/ashigirl96/executor` `main` | `c4db5b30`; product code = upstream `main` `906bee5e` (2026-10-12, merge-base), `@executor-js/sdk` 1.6.10. Upstream default branch is now `v2` ("executor-next", a rewrite); only its README and package list were read (`upstream/v2` `12a49d83`, 2026-10-16). |

Paths below are relative to each project root; OneCLI 1.45 paths are relative to the extracted tag, OneCLI v2 paths to the clone.

---

## 1. NanoClaw fork

**Problem and layer.** NanoClaw is not a gateway. It defines a seam (`GatewayProviderDefinition`) and owns session lifecycle, the human approval flow, and admission; one provider (OneCLI or Iron) is installed per copy. code (src/gateway-providers/gateway-provider-registry.ts:126-168), docs (docs/gateway-seam.md:3-8). Enforcement is at the wire (the gateway) plus host-side admission; NanoClaw's own Guard covers `ncl` commands and system actions, not outbound HTTP (GLOSSARY.md:286-312; Credential Approval "does not pass through Guard", GLOSSARY.md:325-327).

**Lifecycle fit (the precedent the brief names).** `sessions.ensure(input, signal)` is called once per container spawn and returns a lease whose typed `contribution` (env, mounts, containers, labels, `networkAccess` intent) is merged into the spec before admission validation. code (src/container-runner.ts:703-719; gateway-provider-registry.ts:16-25, 64-69). `release({kind:'session-ended'|'host-detached'})` is optional (gateway-provider-registry.ts:59-67). Containers are long-lived per session, not per turn (docs/SECURITY.md:30). An admission-generation check releases a lease acquired while admission closed (container-runner.ts:710-713). For Kurumi this maps to one `ensure` per turn with `release('session-ended')` at container exit: inferred.

**What it trusts.** The gateway's attestation of method, host, and `sendsPayload` (gateway-provider-registry.ts:83-88); the gateway's native identity for the agent group; container isolation as "the primary boundary" (docs/SECURITY.md:24-33).

**Invariants.**
- I1: claimed. "Agents cannot discover real credentials — not in environment, stdin, files, or /proc." docs (docs/SECURITY.md:145-146). Rests on the gateway.
- I2: opt-in only. Egress lockdown puts agents on an `--internal` network with the gateway container attached under an alias; it refuses to spawn if the network is not internal or the gateway cannot attach. code (src/egress-lockdown.ts:86-121). Default is off: "Default: egress is open." docs (docs/SECURITY.md:220-222). Lockdown accepts only `runtime` targets (egress-lockdown.ts:90-92).
- I3: delegated to the gateway (docs/SECURITY.md:143).
- I4: core approval binds a decision to the SHA-256 of the canonicalized translated request (`requestBinding`), used for restart recovery and in-flight dedupe; "A changed request binding cannot reuse an existing approval." code (src/gateway-approval-coordinator.ts:316-322, 879-893), docs (docs/gateway-seam.md:181-185). The translated request is metadata only, by contract: "never credentials, query strings, or request bodies" (gateway-provider-registry.ts:82-89); adapters must not forward raw bodies, headers, or query strings to the card (docs/gateway-seam.md:427-432). So the human sees method, host, path, plus a gateway-made summary. The OneCLI adapter supplies `destination: {host, method}` and `audit: {method, host, path}` only, no `sessionId` (src/gateway-providers/onecli.ts:379-395).
- I4 relaxations shipped in core: requests to the provider's model domains are auto-approved "for all paths and methods" (docs/gateway-seam.md:145-148; coordinator.ts:407-419); optional `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` skips the card for GET/HEAD (gateway-seam.md:378-391); optional `NANOCLAW_GATEWAY_UNCREDENTIALED_READS` skips it when the gateway says no credential applies (gateway-seam.md:395-417; coordinator.ts:420-430). The doc names the residual risk: GET can carry data out in URL and headers and some GETs act (gateway-seam.md:412-416).
- I5: not provided with OneCLI. The OneCLI identity is the agent group, "stable across sessions" (onecli.ts:313-317); the OneCLI lease has no `release` (onecli.ts:320-329), so nothing is revoked when a session ends. With Iron, NanoClaw's own front issues a per-session HMAC token over `install/group/session` (iron-proxy.ts:294-298, 358-360; `gatewayRuntimeIdentity` in gateway-provider-registry.ts:50-52) and the front verifies it (add-iron-proxy/front-proxy/main.go:122-157); revocation is the host dropping the lease (`cancelIdentity`, iron-proxy.ts:482-490), checked on every request through the approval bridge (main.go:229-245). The token itself has no expiry (inferred from the format `iw1.<id>.<mac>`).
- I6: not addressed by NanoClaw for OneCLI; see OneCLI 1.45 below. The OneCLI upgrade doc requires agent containers to reach `host.docker.internal:10254/v1/health`, i.e. the OneCLI admin API port. docs (docs/onecli-upgrades.md:129-136).
- I7: approval audit carries method, host, path (onecli.ts:393); no turn or tool-call id.
- I8: one approval flow for every gateway (docs/gateway-seam.md:165-179). Credential Approval has no Replay; its result goes back to the gateway (GLOSSARY.md:325-327).
- I10: claimed and coded. No provider registered ⇒ host refuses to start (gateway-seam.md:222-225; src/gateway-providers/index.ts:15-29). Bridge loss ⇒ holds denied, sessions stopped, admission closed, supervised resubscribe (gateway-seam.md:193-199; docs/SECURITY.md:163-166). OneCLI health is probed every 5 s and kills the lease's container on failure (onecli.ts:127-165; container-runner.ts:680-686).

**Approval timing.** Core default 120 s (coordinator.ts:90), capped by the provider's `expiresAt` and an absolute 60 min (coordinator.ts:45, 371). Kurumi needs 15 min (ADR 0007).

**Advisories.** `gh api repos/nanocoai/nanoclaw/security-advisories` lists 11 published. Boundary-relevant:
- GHSA-j39m-796j-gjm3 (critical, 2026-11-17): agent containers log in to OneCLI's Postgres as superuser with the default password `onecli`, directly on `172.17.0.1:5432` or through OneCLI 1.45's gateway via `CONNECT postgres:5432` with no agent token; reads every agent's `aoc_` token and admin `oc_` keys in plain text, can re-point a secret's `host_pattern` to exfiltrate it, and runs `COPY … FROM PROGRAM`. Measured by the advisory authors on 1.45.0 and 2.20.0, with egress lockdown on or off. docs (https://github.com/nanocoai/nanoclaw/security/advisories/GHSA-j39m-796j-gjm3). Fixed in NanoClaw 2026.11.0 by setting a random `POSTGRES_PASSWORD`.
- It cites GHSA-jh2q-3h97-pg55, "agent containers can reach OneCLI's unauthenticated admin API". Not public: github.com/advisories/GHSA-jh2q-3h97-pg55 and the nanoclaw and onecli repository advisory URLs all return 404 (curl, 2026-11-28). The j39m text says the admin API on 10254 needs a key on 2.20 but not on 1.45.
- GHSA-628g-jj3x-6mp9 (high): OneCLI installer fetched over plain HTTP and run. GHSA-frvf-5rf5-89fq, GHSA-7wx5-9p7v-wvhp, GHSA-vwj5-j44r-v364, GHSA-j5mj-3gjr-xpwj: host following agent-planted symlinks, TOCTOU, and a FIFO in agent-writable mounts. These are the brief's "persisted workspace read by a host component" path.

**Guarantee vs mitigation.** Fail-closed admission and gateway selection are coded guarantees (assuming the process stays up). The approval summary is display only and "cannot alter authorization" (gateway-seam.md:421-425). The read-only-host and uncredentialed-read rules are trades of a human check for an allowlist, stated as such.

**Cost.** MIT. 19 releases in the last 6 months (`gh api …/releases`, published ≥ 2026-05-28). Contributors: top committers `claude` 1184, `gavrielc` 822, `glifocat` 466 (`gh api …/stats/contributors`); 100+ contributors. Idle footprint is the gateway's, not NanoClaw's.

---

## 2. OneCLI 1.45 (the version NanoClaw pins)

**Problem and layer.** A credential vault plus an HTTP(S) forward proxy that MITMs TLS with its own CA and injects secrets by host and path pattern. Wire layer. The agent authenticates to the proxy with `HTTPS_PROXY=http://x:<aoc_ token>@<gateway>` (packages/api/src/routes/container-config.ts:187, 282-283) and trusts the CA via `NODE_EXTRA_CA_CERTS` (container-config.ts:280-292 region).

**Process shape.** One container runs both the Next.js web server and API on 10254 and the Rust gateway on 10255 (docker/entrypoint.sh:65-71; docker/docker-compose.yml:31-33), plus a Postgres container (docker-compose.yml:4-22). Postgres password defaults to `onecli` (docker-compose.yml:9, 35). The gateway reaches the API over loopback with a per-start `GATEWAY_INTERNAL_SECRET` (entrypoint.sh:33-41).

**What it trusts.** Possession of the agent's `aoc_` token for identity; in local mode, anything that reaches the port for administration (below).

**I6, control plane reachability: reachable from a container that can reach the gateway, by construction of the code.**
- Local auth mode is selected whenever `NEXTAUTH_SECRET` is unset (entrypoint.sh:45-49). In local mode every request to the API resolves to the local admin user with no credential: code (apps/web/src/lib/auth/auth-server.ts:45-49); the API middleware tries an `oc_` key first and then falls back to that ambient session (packages/api/src/middleware/auth.ts:87-129); strict key-only auth is an EE flag (auth.ts:92-105).
- The gateway port itself serves `GET /v1/approvals/pending` and `POST /v1/approvals/{id}/decision` (apps/gateway/src/gateway.rs:373-380) behind `AuthUser`, which in local mode looks up `local-admin` with no credential check (apps/gateway/src/auth.rs:1-5, 143-165). Non-CONNECT, non-absolute-URI requests to 10255 go to that router (gateway.rs:735-746). So the same port an agent must use for egress also accepts approval decisions. An agent with a held request can approve it. argued (assumptions: NanoClaw's default local install without `NEXTAUTH_SECRET`, which NanoClaw's skill never sets per `grep NEXTAUTH_SECRET` over `.claude/skills/add-onecli` and `setup/`; agent can open a second connection to the gateway). Not measured here.
- A CONNECT with no `Proxy-Authorization` is not refused: identity fields stay empty and the session becomes a raw TCP tunnel (gateway.rs:785-808, 912-918) to whatever `host:port` was named, with no address filter (apps/gateway/src/gateway/tunnel.rs:10-13). This is an open relay to the Internet, to `localhost:10254` inside the OneCLI container, and to `postgres:5432` on the compose network. The Postgres path was measured by the GHSA-j39m authors.
- Net: under the brief's threat model, OneCLI 1.45 gives a compromised container the vault's control plane (agents, grants, policies, approvals) and, via Postgres, every agent's token. The vault's secret values are encrypted with a key outside the database (advisory), so exfiltration needs a `host_pattern` re-point through the gateway.

**I2/I3.** An authenticated CONNECT is always MITM'd (gateway.rs:834-839). Policy is first-match over host, path glob, and method; the body-condition arm is a no-op in the OSS build (apps/gateway/src/policy_engine/evaluate.rs:1-9; policy_engine/enforce.rs:28-30). The unauthenticated tunnel bypasses all of it (above), so I3 holds only for clients that present a token, which the attacker chooses not to.

**I4, approval binding.**
- What executes: the held request itself. The gateway peeks up to 16 KiB of the body for the summary, then forwards the peeked chunks chained to the rest of the same stream (apps/gateway/src/gateway/forward.rs:93-99, 438-500). No re-send, so no time-of-check/time-of-use gap between the approved and the executed bytes. argued (assumption: one HTTP/1.1 request per approval on the MITM'd connection; a client retry is a new request and a new approval).
- What the human sees: `summarize_request(provider, method, path, content_type, first ≤16 KiB)` rendered as text (forward.rs:509-529). Bytes after 16 KiB, a second multipart part past the prefix, and anything the per-app summarizer does not render are forwarded unseen. Whether gzip or chunked bodies are decoded before summarizing: not checked.
- Pending record fields: method, scheme, host, path, headers, body_preview, summary (apps/gateway/src/approval.rs:33-54).
- Timeout 180 s, fixed constant (approval.rs:23); auto-deny on expiry. Kurumi's 15-minute wait (ADR 0007) does not fit without changing OneCLI.

**I5.** The `aoc_` token is per agent, stored at rest (packages/db/prisma/schema.prisma:294), and reused for every container of that agent. Revocation means `POST /v1/agents/:id/regenerate-token` or `DELETE /v1/agents/:id` (packages/api/src/routes/agents.ts:126, 144). The gateway caches the token-to-identity resolution for 60 s (apps/gateway/src/connect.rs:21) unless `/v1/cache/invalidate` is called (gateway.rs:369-372). A MITM tunnel resolves identity once at CONNECT (gateway.rs:790-808). Per-turn identity is reachable only by creating and deleting an agent plus grants per turn: inferred, unmeasured cost.

**I7.** `request_logs` rows carry project, agent, method, host, path, provider, status, latency, injection count (schema.prisma:567-588; apps/gateway/src/telemetry.rs:44). No turn or tool-call field. Raw tunnels log only via tracing (tunnel.rs:23-28).

**CONNECT/MITM vs base URL.** Forward proxy only: CONNECT plus absolute-URI HTTP (gateway.rs:707-709, 735-738). No reverse-proxy or base-URL mode found (grep for reverse proxy and base-URL handling in `apps/gateway/src`: no hits). Inside a MITM tunnel the upstream URL is built from the CONNECT authority, not the inner `Host` header (forward.rs:197), so Host/SNI mismatch does not redirect the credential. inferred from that line; HTTP/2 not checked.

**I10.** Gateway down ⇒ proxy unreachable ⇒ the client fails; nothing falls back inside OneCLI. inferred.

**Advisories.** `gh api repos/onecli/onecli/security-advisories` returns `[]` (2026-11-28). The two OneCLI-facing advisories are filed on NanoClaw (above).

**Cost.** Apache-2.0 (LICENSE); EE code paths exist in the tree but compile only in non-OSS editions (apps/gateway/build.rs:14-38). Two containers (one runs two processes), Postgres with a named volume. Idle RSS: not measured.

---

## 3. OneCLI v2 (2.14.0 read; 2.20.0 is latest)

**Shape.** "OneCLI v2 - workspaces, split services, hosted agents" (CHANGELOG.md:177-182). Compose base: `postgres`, one-shot `migrations`, `api` on 10256, `web` on 10254, `gateway` on 10255, each `cap_drop: ALL` and `no-new-privileges` (docker/docker-compose.yml:12-33, 40-58, 62-79, 180-192, 234-246); optional profiles add `runner`, `ssh-terminator`, `channel-adapter` (docker-compose.yml:297-298, 365, 419). `BETTER_AUTH_SECRET`, `SECRET_ENCRYPTION_KEY`, `GATEWAY_INTERNAL_SECRET` are required (docker-compose.yml:91, 95, 97). Postgres still defaults to password `onecli` (docker-compose.yml:19). The product now includes hosted agents, channels, crons, memories, evals (packages/api/src/routes/ listing), which is outside Kurumi's need.

**Changes that matter for the threat model.**
- CONNECT with no token is refused: "serving it would mean a raw tunnel … an open relay wherever this gateway is the only route out of a sandbox network." code (apps/gateway/crates/server/src/lib.rs:879-892).
- Destination guard on the resolved address blocks loopback, private, CGNAT, ULA, link-local, and metadata ranges unless `GATEWAY_ALLOW_PRIVATE_DESTINATIONS` names them; it names the api-server, dashboard, Postgres, and LAN as what it protects. code (apps/gateway/crates/proxy/src/egress.rs:1-24).
- Approval decision routes are still on the gateway port (server/src/lib.rs:344-350) but need an `oc_` API key or a session cookie signed with `BETTER_AUTH_SECRET` (apps/gateway/crates/context/src/auth.rs:625-736); an invalid org key no longer falls through to an ambient session (auth.rs:368-390). The agent's `aoc_` token is not an `oc_` key. So I6 rests on key secrecy and the topology, not on reachability: argued.
- An "open lane" CONNECT passes TLS untouched under host-level policy (server/src/lib.rs:920, 939-944).
- Agent token is still per agent and long-lived (packages/db/prisma/schema.prisma:430); regenerate exists (packages/api/src/routes/agents.ts:293-297). No per-session or per-turn token found.

**Upgrade burden (1.x → 2.x).** NanoClaw: "OneCLI 2.x is a rewrite and is not supported. Never upgrade past the pin." docs (docs/onecli-upgrades.md:7). Even within 1.x, moving to 1.44 deletes every custom network and behavioral rule, including `block` rules, drops rate limits, resets a `block` default to `allow`, and gives `all`-mode agents explicit grants to every secret, so an agent a rule kept away from a host gets that host's secret (onecli-upgrades.md:36-40). Rollback from 1.44+ to 1.43 needs a database backup (onecli-upgrades.md:171). The doc is 254 lines of manual procedure for a pin move. This is the brief's maintenance data point.

**Cadence and bus factor.** 50 releases in the last 6 months (v1.32.0 on 2026-05-28 through v2.20.0 on 2026-11-09; list in `teardown-local/onecli-releases.txt`). Commits: `guyb1` 348, `johnnyfish` 31, everyone else ≤ 11, 28 contributors total (`gh api …/stats/contributors`). Bus factor ≈ 1. License: Apache-2.0 plus `LICENSE-ENTERPRISE` for listed paths (LICENSE-ENTERPRISE:1-8).

---

## 4. executor (v1 line, SDK 1.6.10)

**Problem and layer.** An integration catalog: OpenAPI, GraphQL, MCP, Google Discovery become typed tools with per-tool policy (`approve` / `require_approval` / `block`), exposed over MCP or embedded via the SDK. Operation layer. docs (README.md:15-45; GLOSSARY.md:76-94). Credentials live in a Credential Provider (keychain, 1Password, encrypted file) and are attached in the executor process; sandboxed code calls tools but "does not touch Credentials." docs (GLOSSARY.md:22-30, 108-110).

**Approval binding (I4): tool address plus the full structured argument object.** `enforceApproval` runs before invoke, builds a form whose message is the address plus `JSON.stringify(args)` truncated at 4000 chars, and calls the handler with `{address, args, request, source:'policy'}`; decline aborts. code (packages/core/sdk/src/executor.ts:232, 1838-1843, 6377-6396). The same `args` value is then passed to the tool (executor.ts:6495-6500, 6664). So what executes is what the handler saw, within one process: argued (assumptions: the plugin builds the HTTP request deterministically from `args`; no plugin-internal re-fetch of mutable state). The 4000-char limit is only the default message; an embedder's handler receives the raw `args` and can show all of it. Policies match tool addresses by dot-segment glob, with no argument conditions (packages/core/sdk/src/policies.ts:81-103). An `approve` policy overrides a tool's `requiresApproval` annotation (executor.ts:6368).

**I6 and I8 as shipped: the agent can answer its own approval.**
- The MCP host's elicitation mode is read from the client's request URL `?elicitation_mode=` and defaults to `model` (packages/hosts/mcp/src/browser-approval.ts:39-52; tool-server.ts:1571-1575). In `model` mode the server registers a `resume` tool through which the model answers accept/decline, with an optional `persist` duration that remembers the grant (tool-server.ts:2098-2125). In `native` mode the MCP client asks; in Kurumi the client is the CLI in the container. Only `browser` mode routes the answer to a human URL, and the client chooses the mode.
- Locally, one bearer token gates `/api`, `/mcp`, and the approval and OAuth endpoints (apps/local/src/auth.ts:1-8). A container holding the MCP token holds the control plane. Rotation requires a restart (auth.ts:65-72).
- The default tool catalog includes control-plane tools: `connections.create`, `oauth.clients.create`, `policies.create|update|remove`, gated only by `requiresApproval` (packages/core/sdk/src/core-tools.ts:664-675, 796-811, 999-1059).
- Conclusion: executor's own server must not be reachable from the container. Embedded as a library behind a Kurumi host tool, with `onElicitation` set to Kurumi's approval flow (executor.ts:276-286, 704-727) and the `executor.*` namespace blocked, the agent reaches only the tools Kurumi exposes: argued.

**Other invariants.**
- I1: credentials never enter the sandbox; QuickJS stubs `fetch` to throw (packages/kernel/runtime-quickjs/src/index.ts:259-260); the Deno runtime defaults to deny net, read, write, env, run, ffi (packages/kernel/runtime-deno-subprocess/src/deno-worker-process.ts:41-43). Code mode runs agent-written code on the executor host, which widens the host attack surface (inferred).
- I7: `InvokeOptions` carries only a per-call `onElicitation` (packages/core/sdk/src/elicitation.ts:103-106). Kurumi can close over a turn id and the tool call's id in that per-call handler and in an injected `httpClientLayer` or `fetch` (executor.ts:728-733) to tag outbound requests: inferred. The tool call's id comes from the CLI (`claudecode/toolUseId`), so it is only as trustworthy as the brief's premise test allows.
- Egress: a hosted HTTP client with private-address blocking, TLS requirement, and redirect cap exists (packages/core/sdk/src/hosted-http-client.ts:21-28); local mode uses plain fetch unless the embedder injects that client (inferred).
- I5: not applicable inside the container if embedded; the container holds no executor credential.

**Advisories.** `gh api repos/UsefulSoftwareCo/executor/security-advisories` returns `[]` (2026-11-28).

**Cost.** MIT. Effect `4.0.0-beta.59` (package.json:100) versus Kurumi's `4.1.7`: two Effect copies or a forced upgrade (inferred). Local runtime is one Bun process on port 4788 with libsql/SQLite (apps/local/src/db/). 125 releases in 6 months: v1.5.0–v1.6.11 (last v1, 2026-10-22) and 74 `executor@2.0.0-beta.*` (to beta.79 on 2026-11-25). Commits: `RhysSullivan` 1310 of ~1350 (`gh api …/stats/contributors`); bus factor 1. v2 is a rewrite into an apps/accounts model with "Effect pinned to an upstream snapshot" (upstream/v2 README.md), so the v1 SDK an embedder would adopt today is the line being replaced. Same burden class as OneCLI 1→2.

---

## 5. The specific questions

| Question | NanoClaw | OneCLI 1.45 | OneCLI v2.14 | executor v1 |
|---|---|---|---|---|
| Compromised container reaches control plane (token registration, policy, approval answers)? | Not its surface; inherits the gateway's. | **Yes**: ambient admin on 10254 and on 10255's approval routes; unauthenticated CONNECT tunnel to Postgres (code, plus GHSA-j39m measured). | Not through the gateway (token required, private destinations blocked); approval routes need an `oc_` key. Depends on topology and on keeping `oc_` keys and Postgres off the agent network (argued). | **Yes** if the container talks to executor's server: one token for MCP and API, and `elicitation_mode=model` lets the model approve. No, if embedded behind a host tool (argued). |
| Per-session/turn tokens, issue and revoke | OneCLI: per agent group, no release. Iron front: per-session HMAC, revoked by dropping the host lease. | Per agent, persistent; revoke = regenerate or delete; ≤60 s cache lag. | Same as 1.45. | N/A to the container. |
| Audit can carry `tool_use_id`? | No field; method, host, path only. | No field in `request_logs`. Only per-agent attribution; per-turn if one agent per turn. | Not checked in detail; same token model. | Embedder can tag via per-call handler and injected HTTP client; id source is the CLI. |
| CONNECT/MITM vs base URL | Delegates; mounts the MITM CA as `gateway-trust` (gateway-seam.md:276-284). | Forward proxy, MITM on every authenticated CONNECT; no base-URL mode. | Adds an open (non-MITM) lane. | Not a proxy; makes the HTTPS call itself. |
| Approval binds to | Metadata hash for dedupe; the gateway holds the request. | The held request; human sees method, host, path and a summary of the first 16 KiB. | Not re-read; `approval_enrich.rs` exists (1120 lines). | Tool address plus the full args object. |
| Runs as | Host process (Node) plus the gateway's containers. | 2 containers (web+API and gateway in one), Postgres. | 5 base containers, Postgres. | 1 Bun process plus SQLite, or a library in the host process. |
| License, 6-month cadence, bus factor | MIT, 19 releases, many contributors. | Apache-2.0; pinned and frozen. | Apache-2.0 plus EE; 50 releases; ≈1 maintainer. | MIT; 125 releases; 1 maintainer; v2 rewrite in beta. |

## 6. Preliminary view against the brief's candidates

- **A, wire-only.** OneCLI 1.45 as the wire gateway fails I2, I3, and I6 under this threat model by code: open unauthenticated tunnel, ambient-admin approvals on the egress port, and approval held for 180 s against Kurumi's 15 minutes. It is eliminated for A in its pinned form. OneCLI v2 closes the tunnel and the ambient admin but keeps per-agent long-lived tokens (no I5), method/path-level policy in OSS, and a 5-container footprint; it could be A's injector with Kurumi issuing one agent per turn, at the cost of a rewrite-prone dependency. Wire approval can bind only to the held request with a summary of its first 16 KiB, which is weaker than the brief's I4 for GraphQL, multipart, and git pack data. NanoClaw contributes patterns, not code: typed contribution merged before admission, fail-closed selection, bridge supervision that closes admission, and Iron's per-session signed identity checked live against host leases.
- **B, operation-only.** executor fits as a host-embedded library: it eliminates credential exposure to the container for brokered calls, binds approval to full structured arguments, and leaves the approval answer with Kurumi's handler. Its server, its MCP host, and its default `model` elicitation must not be used. It does not give generality: Claude Code's own `gh`, `git`, `npm`, `curl` need the wire.
- **C, coexistence.** Wire gateway for model traffic and generic CLIs, executor-as-library for operations that need argument-level approval. I9 then requires the wire path to refuse the credentials the broker owns (per-service credential assignment: a GitHub token lives either in the broker or in the gateway, never both). None of these products provides a shared decision point; Kurumi would build it.
- **D, proposed.** Kurumi's existing base-URL relay, extended into a small host-side gateway: per-turn tokens registered and revoked by the runtime (the I5 hook the spec already reserves), no CONNECT, only allowlisted base-URL routes, and credentials injected per route. Generic CLIs reach external services only through brokered tools or not at all. This removes the MITM CA, the vault's control plane, and Postgres from the attack surface, and borrows NanoClaw's lease and admission patterns. Cost: Kurumi writes and owns the gateway (estimate a few hundred LOC for model plus a handful of fixed routes; inferred).

## 7. Uncertainties a cheap local experiment can settle

1. OneCLI 1.45 local mode: from a container on an `--internal` network with only the `onecli` container attached, does `GET http://<alias>:10255/v1/approvals/pending` return 200 and does `POST …/decision {"decision":"approve"}` release a held request? Does `CONNECT 127.0.0.1:10254` without a token tunnel? Decides A-with-1.45 outright. Needs only fakes and the pinned image.
2. OneCLI v2.20 under the same topology: is the gateway container the only reachable thing, does every unauthenticated route 401, does the destination guard stop `CONNECT host.docker.internal:*` and DNS-rebinding names? Decides whether v2 is a viable A component.
3. Per-turn identity on OneCLI v2: latency of create agent + attach grant + container-config + delete per turn, and whether a deleted agent's token stops working at once or after the 60 s cache. Decides I5 feasibility.
4. OneCLI approval binding: hold a POST, then send a multipart body whose second part starts after 16 KiB, and a gzip-encoded JSON body; compare the card summary with the fake upstream's received bytes. Decides how far wire approval meets I4.
5. Wire hold vs client timeouts: hold for 179 s and for >180 s; record what `gh`, `git push`, `curl`, `npm` do. Decides whether any wire approval can follow ADR 0007.
6. executor embedded: `createExecutor({onElicitation})` with an OpenAPI fake; verify the handler sees full args, that a denied call makes no upstream request, that `executor.*` tools can be removed or blocked, and whether the Effect 4.0 beta coexists with Kurumi's Effect 4.1.7 in one Bun process.
7. executor OpenAPI destination: can tool arguments (server variables, absolute-URL path params, `$ref`) send an attached credential to a host other than the connection's base URL? Decides whether executor needs Kurumi's egress-guarded HTTP client injected.

## 8. Not verified

- No container, gateway, or executor was run; all reachability claims are from code plus the GHSA-j39m authors' measurements.
- OneCLI v2.15–2.20 source; v2 `approval_enrich.rs`; HTTP/2 handling in either OneCLI line; gzip and chunked handling in the 1.45 summarizer.
- executor v2 source beyond its README; executor plugin internals (OpenAPI URL construction).
- GHSA-jh2q-3h97-pg55 content (not public).
- Idle RSS for any component.
