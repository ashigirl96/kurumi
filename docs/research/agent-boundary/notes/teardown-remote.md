# Remote source teardown: iron-proxy, agentgateway, just-bash, Composio

Goal: evidence for the Kurumi agent ↔ outside-world boundary design (brief: `docs/research/agent-boundary/brief.md`). Read-only. No clone's code or build tool was run. Tags: `code (path:line)` relative to each clone root, `docs (url)`, `measured` (a command I ran: `gh api`, `curl` to registries), `inferred` (reading, not run), `argued` (assumptions listed).

## What was read

| Project | Clone dir (`src/<name>/repo`) | Commit (shallow HEAD) | Release context |
|---|---|---|---|
| iron-proxy | `src/iron-proxy/repo` | `0250cd313d24e45a8f244aed14679cab2bf9c6ce` | latest v0.61.0, 2026-11-25 (measured). Repo now `paradigmxyz/iron-proxy`; `ironsh/iron-proxy` redirects (measured: `gh api repos/ironsh/iron-proxy` → `full_name: paradigmxyz/iron-proxy`) |
| agentgateway | `src/agentgateway/repo` | `134cbf02e02742cce08ad52cdd221fef579186b8` (main, after v1.7.0) | latest stable v1.7.0, 2026-10-27 (measured) |
| just-bash | `src/just-bash/repo` | `ec5ab766551d479f2782b078b373d49ddc78bd26` | just-bash 3.6.1, @just-bash/executor 7.0.1 (code `packages/*/package.json`) |
| Composio | `src/composio/repo` | `34cbd9058cec4c2dbeabcda6711b75f97961b0a6` (branch `next`) | @composio/core 0.32.0 (code `ts/packages/core/package.json`) |

Docs opened: agentgateway blog index and the Credential Injection Patterns Part 1 (2026-07-27) and Part 4 (2026-11-22); docs.composio.dev token-custody, approvals, hooks/webhooks, sessions/create-and-reuse, sessions-via-mcp, deployment. Advisories read via `gh api repos/<o>/<r>/security-advisories[/<id>]` (measured).

---

## 1. iron-proxy (Go, Apache-2.0)

**Problem and layer.** Default-deny egress proxy with a built-in DNS server; MITM TLS; swaps proxy tokens for real secrets at egress; per-request JSON audit. Wire layer (HTTP request), plus an MCP Streamable-HTTP policy that parses JSON-RPC (operation-ish layer on the wire) and Postgres/SSH proxies. docs (README.md:15-23, 667-704).

**What it trusts.** The operator's YAML and secret sources (env, file, AWS SM/SSM, Vault KV, 1Password) code (internal/transform/secrets/resolver.go; README.md:457-560). In tenancy mode, a control plane that mints Ed25519 JWTs and returns per-tenant config docs (README.md:1130-1263). It does not trust the workload's DNS: names resolve to the proxy unless listed as passthrough code (internal/dns/server.go:76-100, 169-173).

**CONNECT/MITM vs base-URL; CA trust.** MITM only for HTTPS. The upstream scheme is taken from whether the client used TLS, and the upstream host from the request's `Host` code (internal/proxy/proxy.go:371-376, 507-545). A base-URL rewrite to `http://proxy` therefore sends plaintext upstream to the `Host` the client named; there is no generic "route this hostname to that https upstream" for HTTP, except `mcp_gateway` routes for MCP-matched requests docs (README.md:705-737) inferred. Clients must trust the operator CA (README.md:136-151, 829-833). Steering is by DNS (all names → proxy IP), explicit proxy (CONNECT/SOCKS5/absolute-form on `tunnel_listen`), or TPROXY docs (README.md:762-829, 835-950). `sni-only` mode passes TLS through by SNI without injection code (internal/proxy/proxy.go:211-230; internal/proxy/tunnel.go:417-424). `require_tls: true` keeps secrets off plain HTTP docs (README.md:492-522).

**Request validation.** Rejects SNI≠Host, non-canonical hosts, dot segments, odd request targets before transforms code (internal/proxy/proxy.go:319-349; README.md:333-337). Inside a CONNECT tunnel each inner request is re-evaluated against its own Host code (internal/proxy/tunnel.go:436-438 → handleHTTP).

**Can a compromised client reach the control plane?**
- Management API (`POST /v1/reload`) is off by default, bearer-token protected, and the docs say bind loopback docs (README.md:1102-1128, line 1116). If bound on the internal network's interface it is reachable; the token is then the only barrier inferred.
- Metrics default `:9090` on all interfaces code (internal/config/config.go:309-310): reachable from the container on a shared network; read-only metrics, not control inferred.
- Tenancy config fetch is proxy→control plane with a separate proxy credential; a tenant token alone "must never fetch a config" docs (README.md:1213-1240).

**Per-session tokens.** Standalone: proxy tokens are static strings in YAML (`proxy_value`); rotation = rewrite config (or `file` source) and `POST /v1/reload`, which rebuilds the pipeline atomically docs (README.md:519-531, 1102-1128) inferred. Tenancy: JWT EdDSA, `exp` ≤ 24 h code (internal/tenancy/token.go:38, 155); revocation = control plane answers 403/404, effective on the next refresh after `fresh_for` (default 1 m) docs (README.md:1150, 1186-1190, 1242-1262); long-lived streams already open are not cut docs (README.md:1188-1190). Tenancy accepts only `Proxy-Authorization: Bearer` code (internal/tenancy/token.go:209-216), refuses SOCKS5 and the plain listeners docs (README.md:1191-1197). Stock CLIs that take `HTTPS_PROXY=http://user:pass@host` send Basic, so they would get 407 inferred (experiment E5).

**Audit and caller-supplied ids.** One JSON record per request: host, method, path, action, status, per-transform annotations; OTEL export docs (README.md:1039-1100). The `annotate` transform copies chosen request headers into the record docs (README.md:348-376) code (internal/transform/annotate/annotate.go:35-79), so an `X-Tool-Use-Id` header can be logged, but the container writes it (forgeable) inferred. Tenancy adds the signed token's `sub`/`jti` (not container-forgeable, but per-tunnel, not per tool call) docs (README.md:1318-1322).

**Body inspection.** `BufferedBody` buffers lazily up to `max_request_body_bytes` (default 1 MiB) code (internal/proxy/proxy.go:440-442; internal/transform/body.go:10-75). Once any transform reads it, the buffer is truncated at the limit, the original reader is closed, and the upstream gets the buffer with a matching Content-Length code (internal/transform/body.go:65-75, 91-101; internal/proxy/proxy.go:552-570; test internal/transform/body_test.go:44). The README says data beyond the limit "is truncated from the transform's perspective but still forwarded" docs (README.md:750-754): code and docs disagree (not measured; E1). Consequence for binding: what the MCP policy inspects is exactly what is forwarded, and an MCP POST whose Content-Length exceeds the buffer is denied code (internal/mcp/intercept.go:68-77). No Content-Encoding decoding in transforms (grep of `internal/` finds none; inferred). Multipart is only stubbed in the LLM judge code (internal/transform/judge/prompt.go:128-131). No GraphQL or git-protocol awareness (grep: none). `aws_auth`/`hmac_sign` reject chunked bodies by default because length can't be verified code (internal/transform/awsauth/awsauth.go:415-419; internal/transform/hmacsign/hmacsign.go:324-329).

**Invariants.**
- I1: secret swap is a substring `ReplaceAll` in matched headers (and query/path/body when opted in) code (internal/transform/secrets/secrets.go:334-408, 496-503, 532-590); responses are not scrubbed (`TransformResponse` is a no-op) code (secrets.go:441-443). An allowed host that echoes headers, or a body swap into an issue text, returns or publishes the real secret argued (assumes the allowed host reflects input; E2). Rules scope by host/method/path; `require: true` rejects requests lacking the proxy token so the workload can't bring its own credential docs (README.md:483-486).
- I2: not provided by the proxy alone: DNS steering is "easy to bypass" docs (README.md:852-853); needs nftables/TPROXY or Kurumi's `--internal` network argued. DNS exfil: non-passthrough names are answered locally with the proxy IP, no recursion code (internal/dns/server.go:169-173). Upstream deny CIDRs block IMDS/loopback after resolution docs (README.md:28-36).
- I3: default-deny allowlist + per-secret host rules per request code (internal/transform/allowlist/allowlist.go; secrets.go:342-345). `inject` mode adds the credential to every matching request with no token needed docs (iron-proxy.example.yaml:121-122: "The client does not need to send any credential").
- I4: no human approval anywhere (grep `approv` finds only the SSH authorizer comment, internal/sshproxy/server.go:345). The external response-retry authorizer receives scheme, host, method, path, status, headers, sandbox id; never the request body code (internal/responseretry/handler.go:82-90) docs (README.md:299-327). MCP `when` clauses bind tool name + argument values (equals/in/regex) code (internal/mcp/intercept.go:93-110; internal/mcp/argmatch.go).
- I5: see tokens above.
- I6: see control plane above.
- I7: per-request audit, joinable to a turn only through a container-written header or a tenancy `jti` inferred.
- I9: MCP policy covers Streamable HTTP only; resources/prompts are not enforced docs (README.md:739-743).
- I10: `require: true` rejects when the secret source fails code (secrets.go:349-355); judge `fallback: deny` default docs (README.md:613-643); proxy down ⇒ no route in an internal-only topology argued.

**Guarantee vs mitigation.** Allowlist, secret swap, MCP allowlist are deterministic. The `judge` transform is an LLM; it can only reject, static deny wins docs (README.md:600-665). Mitigation, not a guarantee.

**Advisories (measured).** GHSA-vfgh-6jv3-4348 (medium): MCP policy bypass with non-JSON Content-Type, 0.23.0–0.49.0, fixed 0.50.0; fix inspects every POST code (internal/mcp/intercept.go:50-57). GHSA-wr9r-h2x5-jqjc (high): Postgres RLS bypass via uninspected calls, fixed 0.53.0.

**Single-host fit.** One Go process; DNS, HTTP, HTTPS, optional tunnel listeners; needs a fixed IP for `--dns` docs (README.md:153-195). Linux tarball 16.9 MB; image `ironsh/iron-proxy:0.61.0` exists on Docker Hub (measured). Idle RSS unmeasured. Per-turn containers need no registration in standalone mode inferred. NanoClaw already ships an `add-iron-proxy` skill (brief), see the local teardown.

**Maintenance.** 29 releases in 6 months (v0.42.0-rc.3 2026-05-29 → v0.61.0 2026-11-25), 65 commits in 26 weeks (measured). Bus factor 1: `mslipper` 163 of 178 contributions (measured). Pre-1.0; config has a legacy and a `replace:`/`inject:` form side by side code (secrets.go:263-317), so schema churn is likely inferred. Commercial upsell iron.sh docs (README.md:1324-1328).

---

## 2. agentgateway (Rust, Apache-2.0, Linux Foundation / AAIF)

**Problem and layer.** General L4/L7 proxy for LLM, MCP, A2A and HTTP traffic, standalone YAML or Kubernetes xDS docs (README; examples/). Both layers: HTTP routes/policies (wire) and an MCP-native proxy that parses JSON-RPC and authorizes per tool with CEL (operation) code (crates/agentgateway/src/mcp/session.rs:670-690; examples/mcp-authorization/config.yaml).

**What it trusts.** Its config (file watched and hot-reloaded, code crates/agentgateway/src/state_manager.rs:150-180) or xDS; JWKS for `jwtAuth`; API key lists in config code (crates/agentgateway/src/http/apikey.rs:150-170); external authz/guardrail services it calls.

**CONNECT/MITM vs base-URL; CA trust.** Both. (a) Base-URL: a listener with routes whose backends are fixed hosts plus `backendTLS`, and `backendAuth` sets the credential code (crates/agentgateway/src/http/auth/mod.rs:72-117): `key` (static secret or CEL expression), `passthrough`, `gcp`/`aws`/`azure`, `jwtSign`, `oauthTokenExchange`, `crossAppAccess`. No CA in the client; matches Kurumi's current `ANTHROPIC_BASE_URL` shape inferred. (b) Egress proxy: `tunnelProtocol: connect` plus either SNI allowlist without decryption (`tcpRoutes.hostnames`) or `tls.mode: dynamicCa` MITM, where clients must trust the CA code (examples/traffic-egress-proxy/config.yaml; config-dynamic-tls.yaml) docs (examples/traffic-egress-proxy/README.md). The dynamic-TLS example has no hostname allowlist and "permits every HTTPS destination" docs (same README, last paragraph). No DNS server inferred (grep).

**Can a compromised client reach the control plane?** Admin defaults to localhost:15000 code (crates/agentgateway/src/config.rs:390-396); it exposes `/quitquitquit`, `/logging`, `/config_dump` code (crates/agentgateway/src/management/admin.rs:192-200) and the UI's `POST /api/config` that writes config code (crates/agentgateway/src/ui.rs:100-103), with no authentication in the handler stack (admin.rs has only CORS; grep finds no auth check) inferred. Safe only while bound to loopback of the gateway's own netns argued. Stats `:15020` and readiness `:15021` bind the wildcard by default code (config.rs:397-410): reachable from containers on the same network (read-only) inferred.

**Per-session tokens.** API keys in config with metadata, `mode: strict` required; the default mode is `Optional`, which lets requests without a key through code (crates/agentgateway/src/http/apikey.rs:31-46). Per-turn issue/revoke = rewrite the watched config file; reload latency unmeasured (E7). Or `jwtAuth` with host-signed short JWTs (revocation by `exp` or JWKS change) code (examples/mcp-authorization/config.yaml). Enterprise adds the STS/elicitation flow for upstream tokens docs (https://agentgateway.dev/blog/2026-07-27-credential-injection-ai-agent-egress-cb4a/).

**Audit and caller-supplied ids.** Access-log fields are CEL expressions code (crates/agentgateway/src/telemetry/log.rs:412-419), so `request.headers["x-tool-use-id"]` (container-forgeable) or API key metadata / JWT claims (gateway-verified) can be logged inferred. MCP logs carry tool name and arguments code (crates/agentgateway/src/mcp/mod.rs:528-545, 824-832).

**Body inspection.** Non-consuming inspection: policies see a bounded snapshot and the same bytes are forwarded; over the limit yields `Partial` code (crates/http/src/lib.rs:61-76). CEL `request.body` fails to evaluate over the buffer limit docs (schema/cel.md:14-15); with `allow` rules that is a deny, while `deny` rules "fail to deny" docs (schema/config.md:251-252). `extAuthz` can send the body: `maxRequestBytes` default 8192, partial disallowed by default (request rejected), failure mode default Deny, default timeout 2 s overridable by a backend timeout code (crates/agentgateway/src/http/ext_authz.rs:93-103, 186-210, 282-310, 551-554, 1364-1366). Request decompression policy handles one configured encoding and skips multi-layer or unsupported encodings (body then passes compressed) code (crates/agentgateway/src/http/compression/policy.rs:130-182). No GraphQL, git or multipart awareness inferred (grep). GraphQL could be gated with CEL over `json(request.body)` on an HTTP authorization rule inferred (E9).

**Invariants.**
- I1: injection sets the credential; reflection by an allowed echo host still leaks it argued (same assumption as iron-proxy).
- I2: SNI allowlist forwards to the SNI hostname code (traffic-egress-proxy/config.yaml `dynamic: {}`); no DNS control; relies on network topology argued.
- I3: routes + CEL authorization + extAuthz per request inferred.
- I4: no built-in human approval. Hooks where Kurumi can implement one: `extAuthz` (headers + body up to the limit) and MCP `Remote` guardrail processors (tool params, 10 s default timeout, FailClosed default) code (crates/agentgateway/src/mcp/guardrails/mod.rs:105-108, 186-205, 236-243; guardrails/client.rs:31). MCP arguments are captured from the parsed request before authorization and the same struct is sent upstream code (mcp/session.rs:675-690), so binding to the parsed arguments holds by construction inferred.
- I6: see above. I7: CEL log fields. I10: extAuthz Deny and guardrail FailClosed by default; apiKey `Optional` default is fail-open code (apikey.rs:35-44).

**Guarantee vs mitigation.** CEL rules, extAuthz, backendAuth are deterministic. LLM guardrails / prompt guards exist (examples/llm-prompt-guard, llm-guardrail-jev-openai) and are mitigations.

**Advisories (measured, 7).** MCP-layer bypasses in 2026: GHSA-mvgg-jvj2-4frq (high, session reuse crosses routes and authz, <1.4.0), GHSA-7hv4-jgp9-mgx2 (same for guardrails, <1.7.0), GHSA-qm3r-hhvc-62cp (invalid JSON-RPC id skips `mcpAuthorization`, <1.7.0); two MCP→OpenAPI sanitization issues; two Kubernetes ReferenceGrant issues. Three authz bypasses in the MCP path in five months argues for a version floor of v1.7.0 and for not making agentgateway's MCP layer the only gate argued.

**Single-host fit.** One binary, `agentgateway-linux-amd64` v1.7.0 is 96 MB (measured); idle RSS unmeasured. Standalone mode needs no Kubernetes docs (examples/*/config.yaml with `agentgateway -f`). Fits base-URL on `--internal` without a CA; per-turn tokens via config rewrite inferred.

**Maintenance.** Stable minors roughly monthly: v1.3.0 (06-18), 1.3.1, 1.4.0 (07-27), 1.4.1, 1.5.0 (08-27), 1.6.0 (10-02), 1.7.0 (10-27) (measured); 1503 commits in 26 weeks; 97 human contributors, top `howardjohn` 1397 of 2975 (measured). Fast-moving config schema (blog notes MCP spec revisions per release) inferred.

---

## 3. just-bash (TypeScript, Apache-2.0)

**Problem and layer.** A bash interpreter in TypeScript with a virtual filesystem, ~79 built-in commands and no `spawn()`, for agents that should not get a real OS docs (THREAT_MODEL.md:24-60, 3.5 table "child_process … Not imported anywhere"). Operation layer in-process: network goes through a host-supplied fetch with URL-prefix allow-list, method allow-list (default GET/HEAD), and header "transforms" that inject credentials at the fetch boundary code (packages/just-bash/src/network/types.ts:31-45, 59-95; src/network/fetch.ts:131-165). Credentials are re-applied per redirect hop and user-supplied credentials stripped code (fetch.ts:390, 450-475).

**What it trusts.** Host-provided `fs`, `fetch`, `customCommands`, transform plugins, Node and the OS docs (THREAT_MODEL.md:1.1).

**Kurumi questions.** No CONNECT/MITM (in-process fetch). No control plane. No per-session tokens (static header values in config). No audit of its own. No body policy: allow-list is URL prefix + method only (types.ts:59-95). Not a container replacement: it does not run real binaries (`git`, `npm`, Claude Code's tools), which breaks the requirement to keep general-purpose execution argued. Bun compatibility of the defense-in-depth layer is unknown: contextual dynamic-import blocking needs `node:module.registerHooks()` docs (THREAT_MODEL.md:4.1) inferred (E12).

**Approval binding (@just-bash/executor 7.0.1, experimental).** `onToolApproval` receives `toolPath`, `args` (parsed object), `approvalLabel`; the same parsed `args` object is passed to the SDK invoke after approval code (packages/just-bash-executor/src/create-executor.ts:143, 155-176, 178), so the approved arguments are the executed arguments within one process inferred. Defaults to `allow-all`; inline tools bypass approval code (packages/just-bash-executor/src/types.ts:112-124); `operationKind` is always `"unknown"` code (create-executor.ts:163). It wraps `@executor-js/sdk` ^0.2.0 code (packages/just-bash-executor/package.json:49-52), i.e. the executor project covered by the local teardown.

**Invariants.** I1/I2 by architecture for the bash surface (no env, network off by default) docs (THREAT_MODEL.md:6 scenarios 3, 7); defense-in-depth monkey-patching is explicitly secondary and bypassable docs (THREAT_MODEL.md:4.2-4.3, 5). Python opt-in is a residual risk docs (THREAT_MODEL.md:4.7).

**Advisories (measured).** GHSA-g5pf-mh4h-h655 (high): `ReadWriteFs` escape via pre-existing hard links, <3.3.0.

**Maintenance.** 10 just-bash releases in 6 months (3.0.2 06-21 → 3.6.1 11-16), executor majors 1.0.3 → 7.0.1 (measured); 118 commits in 26 weeks; 46 contributors, `cramforce` 328 of 454 (measured). Executor is experimental with seven majors in five months: high upgrade burden (measured release list, inferred burden).

---

## 4. Composio (SDKs MIT; backend closed, hosted)

**Problem and layer.** Hosted integration catalog, managed OAuth, and tool execution: the caller sends a tool slug and arguments; Composio resolves the connected account, injects the credential server-side and returns the result docs (https://docs.composio.dev/docs/security/token-custody). Operation layer (typed tools), plus Proxy Execute for raw HTTP to the provider's registrable domain docs (same page, "Execution paths"). The repo holds SDKs, CLI and docs, not the backend (repo tree: `ts/`, `python/`, `docs/`) inferred.

**Trust shift.** In Composio Cloud "Composio has custody of those credentials" and decrypts them to execute docs (token-custody). Alternatives: BYOC (Enterprise; Composio operates in your cloud account), customer-managed keys (proxy in your cloud decrypts), Helm self-host via sales docs (https://docs.composio.dev/docs/deployment). None is a single-host, operator-run open-source option inferred. Tool arguments and results are stored in execution logs up to a year unless ZDR (paid) docs (token-custody, "Where payloads go").

**Kurumi questions.** No CONNECT/MITM; HTTPS API to `backend.composio.dev`. Control plane = Composio's API: anything holding the project API key can act for any `user_id` in the project docs (token-custody, "Your backend owns identity"). Session MCP headers carry that same project `x-api-key` (or an org-wide user key) docs (https://docs.composio.dev/docs/sessions-via-mcp). Sessions "don't expire"; `delete()` stops them docs (https://docs.composio.dev/docs/sessions/create-and-reuse). So there is no per-turn token to hand a container; the key must stay host-side argued. Execute params carry no caller correlation id (`tool_slug`, `arguments`, `input_responses`, `request_state`, `account`) code (ts/packages/core/src/models/ToolRouterSession.ts:742-751); the remote response is mapped to `{ data, error, logId }` from the backend's `log_id` code (ts/packages/core/src/models/Tools.ts:376, 1481-1489; ToolRouterSession.ts:765-767), so Kurumi can join `tool_use_id → logId` in its own DB inferred. Org audit logs cover configuration changes, not tool calls docs (docs/content/docs/security/audit-logs.mdx, "What audit logs don't record").

**Approval binding.** Experimental elicitation: the call returns `input_required` with a message showing tool + JSON args; the client sends "the same call again" with `input_responses` and `request_state` docs (https://docs.composio.dev/docs/governance/approvals). Whether the server checks that the re-sent arguments equal the approved ones is not visible (closed backend): unverifiable from source. "Always approve" persists for the session per tool and connected account (a remembered grant). Workbench/bash scripts use "a model" to find tool calls and "can miss some"; Proxy Execute is disabled for toolkits with approval-gated tools docs (approvals, "Current limitations"). Webhooks (Enterprise) get tool + args, can block/override, but must answer within 100–5000 ms docs (https://docs.composio.dev/docs/hooks/webhooks): too short for a 15-minute human hold argued. Firewall prompt checks and injection detection are LLM decision models docs (docs/content/docs/firewall.mdx): mitigations.

**Advisories.** 0 published GitHub advisories (measured).

**Maintenance.** At least 22 @composio/core GitHub releases between 2026-06-19 and 2026-10-22 (the releases API stops at 1000 tags, measured; full list `composio-releases.txt`); 1806 commits in 26 weeks; 91 human contributors, top two 1500 and 1454 of 5987 (measured). Approvals need @composio/core > 0.24.0 docs (approvals callout).

---

## 5. Answers at a glance

| Question | iron-proxy 0.61 | agentgateway 1.7 | just-bash 3.6 | Composio |
|---|---|---|---|---|
| CONNECT/MITM vs base-URL | MITM (DNS/CONNECT/TPROXY); no generic base-URL (proxy.go:371-376) | both; base-URL needs no CA (auth/mod.rs:72-117) | in-process fetch | hosted API |
| Container reaches control plane | mgmt off by default, loopback advised; metrics `:9090` open | admin localhost unauthenticated; stats/readiness wildcard | n/a | project key = control plane |
| Per-turn token issue/revoke | YAML + reload; tenancy JWT Bearer-only, revoke ≤ `fresh_for` | config-file keys (strict mode) or short JWT | none | none (sessions don't expire) |
| Audit with caller id | `annotate` header (forgeable); tenancy `jti` | CEL log fields (forgeable header or verified key metadata) | none | `logId` returned, joinable host-side |
| Body bind | ≤1 MiB, inspected==forwarded (truncates), no decompression; MCP args | ≤limit, inspected==forwarded, single-layer decompression; CEL/extAuthz; MCP args | none | args (server-side, unverifiable) |
| Human approval | none | hooks only (extAuthz 2 s, guardrail 10 s defaults) | executor callback, in-process | experimental elicitation, remembered grants |
| Single host, `--internal` | yes, brings DNS | yes, no DNS | host library | needs host egress to cloud |
| License / bus factor | Apache-2.0 / 1 | Apache-2.0 / many | Apache-2.0 / ~1 dominant | MIT SDK, closed backend / company |

---

## 6. Preliminary view on candidate architectures

**A (wire-only).** iron-proxy is the most complete A component: DNS sinkhole, default-deny allowlist, token swap with `require`, MCP argument policy, per-request audit code (sections above). agentgateway serves A with base-URL routes (no CA) or CONNECT+`dynamicCa`. Neither supplies human approval; in A approval must live in an extAuthz-style hook holding the request, which runs into client HTTP timeouts and body limits (git pack data, multipart, compressed bodies are opaque or capped) argued. A cannot meet I4 for GraphQL variables or push refs without protocol parsers neither product has inferred.

**B (operation-only).** Container reaches only the model route (agentgateway base-URL route, or Kurumi's minimal relay). Host-side broker options: agentgateway's MCP proxy with CEL `mcpAuthorization` on tool args and a Remote guardrail as the approval point; @just-bash/executor or executor as Code Mode with an in-process approval callback whose approved args are the executed args (create-executor.ts:143-178); Composio as catalog if the operator accepts the cloud custody shift. B gives the strongest I4 (binding to parsed arguments) but gives up CLIs with credentials argued.

**C (coexistence).** agentgateway is the only one of the four that can host both paths in one process (HTTP routes with `backendAuth` for CLIs, MCP routes for brokered tools) with one CEL policy language, one log stream and one key/JWT identity, which addresses I8/I9 by a shared decision point inferred. For I9, broker-owned operations must be denied on the wire path; path-based denial works for REST, but GraphQL needs CEL over `json(request.body)` with `allow` rules (fails closed over the buffer limit, schema/cel.md:14) inferred. iron-proxy + a separate host MCP broker splits policy across two configs; its wire rules are host/method/path only, so GraphQL can't be split without the LLM judge (mitigation) argued.

**D (proposal): split by credential, not by policy.** Give the wire gateway only read-scoped or low-impact real credentials (for example a fine-grained read-only GitHub token), and keep write-capable credentials exclusively in the host broker behind approval. I9 then holds by construction for writes: the wire path has no credential that can perform them argued (assumes the provider offers scopes fine enough; GitHub fine-grained PATs do, many SaaS keys don't). Works with either gateway.

**Eliminated or demoted (from teardown alone).**
- just-bash as the agent runtime: no real binaries, so it fails "keep Claude Code's general-purpose execution" argued; keep as a pattern (fetch-boundary injection, per-hop credential re-application) or host-side Code Mode.
- Composio as credential store when credentials must stay on the machine: Cloud custody docs (token-custody); no per-turn tokens; approval binding unverifiable; remembered grants. Keep only as an optional catalog in B for services the operator lets leave the machine.
- iron-proxy tenancy mode for stock CLIs: Bearer-only Proxy-Authorization (token.go:209-216) inferred; standalone mode remains.
- Relying on any vendor's LLM judge/firewall for I3/I4: mitigation by their own docs (iron-proxy README.md:600-665, Composio approvals limitations).

---

## 7. Technical uncertainties and cheap local experiments

All use local fakes and canary secrets; none needs a real account except E11.

| # | Question | Why it matters | Affects | Experiment (binary/version) |
|---|---|---|---|---|
| E1 | Does iron-proxy forward a truncated body once a transform reads >1 MiB (code) or the full body (README)? | silent data corruption of uploads; binding semantics | A, C | `ironsh/iron-proxy:0.61.0`, `match_body: true`, POST 2 MiB to the echo fake, compare byte counts |
| E2 | Does a header/body swap leak the real secret via an echo host or a POSTed body? | I1 on allowed hosts | A, C | same image; echo fake; grep canary in response and fake log |
| E3 | With container `--dns <proxy>` on `--internal`, are outside names/DNS exfil blocked and Docker's embedded DNS bypassed? | I2 | A | same image; `dig rand.exfil.test` from container, fake authoritative DNS logs |
| E4 | Per-turn token rotation in standalone: YAML rewrite + `POST /v1/reload` latency; in-flight SSE with the old token | I5, post-crash model call (#1) | A, C | same image, management on a host-only network |
| E5 | Tenancy with stock clients (`HTTPS_PROXY=http://u:tok@proxy`) | per-turn identity without reload | A | same image; curl, git, node; expect 407 |
| E6 | Claude Code via agentgateway base-URL: strict apiKey (fake per-turn key) + `backendAuth.key` setting `Authorization: Bearer` to the fake model endpoint; is the fake key stripped? | fit with current Kurumi shape | A, C | `agentgateway-linux-amd64` v1.7.0 standalone |
| E7 | Config-file key removal → rejection latency; behaviour of streams already open | I5 | A, C | same binary |
| E8 | From the turn container: scan agentgateway 15000/15020/15021 and iron-proxy 9090/9092 | I6 | all | both binaries on an `--internal` network |
| E9 | CEL `json(request.body)` allow rule for a GraphQL mutation; body over limit; gzip and double-encoded bodies with/without decompression policy; chunked | I4, I9 on single-endpoint APIs | C, D | agentgateway v1.7.0 + GraphQL fake |
| E10 | extAuthz hold for 15 min with raised backend timeout; which clients (curl, gh, git, Claude Code WebFetch) time out first | wire-level approval viability | A, C | agentgateway v1.7.0 + a sleeping authz fake |
| E11 | Composio: re-send an approved call with changed arguments and the same `request_state` | approval swap (I4) | B with Composio | needs a real Composio account and connected test app: operator approval |
| E12 | just-bash `DefenseInDepthBox.getInstance().getStatus()` under Bun | host-side Code Mode safety | B | `just-bash@3.6.1` in Bun, in an isolated dir |
| E13 | Idle RSS and startup time of both gateways | cost axis | all | `ps -o rss` after start, both binaries |
| E14 | agentgateway apiKey with `mode` omitted lets keyless requests through | I3 footgun | A, C | v1.7.0, one request without key |

## Not verified
- No binary was run; every runtime behaviour above is from code or docs. Idle footprints unmeasured.
- Composio backend behaviour (argument binding on approval, log contents) is closed source.
- agentgateway CONNECT handling of a mismatch between CONNECT target, SNI and inner Host was not traced.
- agentgateway `http/authorization.rs` semantics for HTTP (non-MCP) rules were taken from schema docs, not code.
