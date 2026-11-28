# Shortlist and uncertainty list (input to slice 3)

Inputs: ../prototypes/premise/notes-premise.md (slice 1, measured), teardown-local.md, teardown-remote.md.

## What slice 1 settled (do not redo)
- The PreToolUse gate is not a boundary against code execution in the container; an approved Bash child can write to the CLI's stdout pipe and forge host-bound messages. Only three things enforce against that attacker: the `--internal` network, the gateway, and side effects the host itself executes (host MCP tools / broker).
- Docker embedded DNS on `--internal` does not forward outside names (Mac). No route except the gateway (Mac).
- The dev relay passes any `kurumi-fake-` token, any path and method, forwards x-api-key/cookie, and an echoing upstream returns the injected credential.

## Eliminated (teardown only)
- OneCLI 1.45: ambient admin on the egress port answers approvals, unauthenticated CONNECT is an open tunnel, GHSA-j39m-796j-gjm3, fixed 180 s approval hold.
- OneCLI v2: per-agent long-lived tokens, OSS policy is host/path/method only, 5 containers + Postgres, bus factor ~1, v1→v2 rewrite and destructive in-line upgrades.
- just-bash as the agent runtime: cannot run real binaries (fails "keep Claude Code general-purpose").
- Composio as credential store: credentials in vendor cloud, sessions do not expire, approval binding unverifiable (closed backend), remembered grants. Optional catalog only if the operator lets credentials leave.
- executor as a dependency: Effect 4.0 beta vs Kurumi 4.1.7, v1 line being replaced by a v2 rewrite, one maintainer. Its pattern (approve the parsed args object, execute the same object) is kept.
- Any LLM judge / firewall as I3/I4: mitigation by the vendors' own docs.

## Shortlisted architectures
- **C' (coexistence split by credential).** Container reaches one gateway by base URL (no CA, no CONNECT). Gateway: per-turn token, route allowlist per service (method + path pattern), real credential injected per route, response scrubbing of credential bytes. Wire routes carry only credentials whose whole scope is acceptable without per-request approval (model, read-only tokens, package registries). Write-capable credentials live only in a host broker: host MCP tools whose arguments are parsed, shown to the human, and executed by the host with the same parsed object. B = C' with no wire credentials except the model.
- **A-MITM (comparator).** Forward proxy with CA trust (iron-proxy 0.61.0) so stock CLIs work unmodified via HTTPS_PROXY. Kept only to measure what generality C' loses and what A's wire-level binding can and cannot see.

Products per role: wire gateway = agentgateway v1.7.0 (standalone, base-URL routes + backendAuth) vs a Kurumi-built minimal gateway (extend `packages/agent-runtime/src/real/dev-relay.ts`, a few hundred lines); MITM comparator = iron-proxy 0.61.0; broker = Kurumi-built host MCP tool.

## Uncertainty list (measure only these)
| # | Question | Why it changes the design | Affects | Smallest experiment |
|---|---|---|---|---|
| U3 | Which must-support clients work through a base-URL gateway without MITM: git (url.insteadOf), gh (GH_HOST, needs TLS on the gateway's own name?), npm (registry), pip (index-url), curl, Claude Code WebFetch, a remote MCP server (URL)? What config each needs. | If several need MITM, C' loses generality and A comes back | C', A | run each client in the Kurumi image on `--internal` against the gateway and fakes; repeat through iron-proxy MITM |
| U4 | Can a wire gateway bind approval to the body for real clients: git receive-pack (refs, force), GraphQL (operation + variables), multipart, gzip, chunked? Does inspected == forwarded? | If not, writes must go to the broker (C' split) | C', A | capture real client requests at the gateway, parse them, attempt approval swap (approve one, send same method/path with other body) |
| U5 | Does a wire-level approval hold survive 15 minutes (ADR 0007) for curl, git, npm, gh, node fetch (Claude Code)? | If not, wire approval cannot follow ADR 0007 | A, C' | hold each client's request 16 min at a fake gateway, record who times out and when |
| U6 | Per-turn token revocation: does it stop the post-crash model call (#1)? Latency for agentgateway config-file key removal; in-process gateway dying with the host. apiKey `mode` default. | Decides gateway placement (in host process vs separate) and I5/I10 | C' | revoke mid-turn, kill host, replay token after turn end |
| U7 | Can the container reach each shortlisted gateway's control plane (agentgateway 15000/15020/15021, iron-proxy 9090/mgmt)? | I6 config requirements | all | port scan + admin calls from the container |
| U8 | In C', can the wire path exercise a broker-gated operation (POST /repos/a/b/issues, GraphQL mutation) with a wire credential? | I9 | C' | route allowlist on the gateway; attempt the gated ops through the wire |
| U9 | Does the gateway leak the injected credential back (echo upstream, error bodies, redirects to other hosts)? Can response scrubbing stop it? | I1 on allowed hosts | C', A | echo fake, redirect fake, canary grep |
| U10 | Broker approval swap: can the container change what executes after the human approved a brokered call (forged toolUseId, re-sent args)? | I4 for the broker | C' | host MCP broker in the slice-1 Runtime harness with the attacker CLI |

Not measured (argued only): a trustworthy tool_use_id at the wire layer. Any id the container sends is forgeable; per-turn attribution comes from the per-turn token, per-call attribution only for brokered calls the host executes.
