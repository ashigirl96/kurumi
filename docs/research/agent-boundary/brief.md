# Brief: Kurumi agent ↔ outside-world trust boundary investigation (read-only + targeted throwaway prototypes)

## Goal
Produce the evidence for a later design session on how Kurumi's agents reach the outside world: credential storage and injection, authentication, authorization, human approval, egress control, audit, and integrations (CLI, MCP, HTTP APIs). Output is evidence and observation-based recommendations, not production code and not the final decision. Do not anchor on any reference product or on the current Kurumi drafts; they are inputs, not answers.

Depth over breadth: do not prototype every product or every architecture. Read source to narrow to a shortlist, then measure only the technical uncertainties whose answer would change the design.

## Read first (do not retype them; build on them)
- `GLOSSARY.md`, `docs/adr/0001`–`0009`, and GitHub issue ashigirl96/kurumi#1, especially the sections ツールの関所（PreToolUse）, コンテナ, 外向き通信と Credential Gateway との境界（暫定）. Measured facts there are tagged 【実測】; do not redo them.
- `docs/research/persistence-stack/brief.md` and `README.md`: the format precedent for this investigation.
- The user's NanoClaw fork at `~/.ghq/src/github.com/ashigirl96/nanoclaw`: `docs/gateway-seam.md`, `docs/SECURITY.md`, `docs/onecli-upgrades.md`, GLOSSARY sections Guard / Approval / Gateway, `src/gateway-providers/`, `src/egress-lockdown.ts`, `.claude/skills/add-onecli/`, `.claude/skills/add-iron-proxy/`.
- Local clones: `~/.ghq/src/github.com/onecli/onecli` (this is v2; NanoClaw pins 1.45, so read 1.45 too), `~/.ghq/src/github.com/ashigirl96/executor` (fork; product code equals upstream).
- Remote: https://github.com/ironsh/iron-proxy, https://github.com/composiohq/composio + docs.composio.dev, https://github.com/vercel-labs/just-bash (read THREAT_MODEL.md), https://github.com/agentgateway/agentgateway + agentgateway.dev (MCP authz, egress proxy, the 2026-11 "Credential Injection Patterns" posts).

Kurumi in one paragraph: single user, single host (Linux prod, macOS dev), TypeScript + Bun + Effect 4. Claude Agent SDK runs in the host process; Claude Code CLI runs per turn in `docker run -i --rm` on an `--internal` network whose only other member is the gateway. The container gets a fake token and `ANTHROPIC_BASE_URL` pointing at the gateway, which swaps in the real token without TLS interception. Host-side pieces: PreToolUse hook as the tool gate (write-ahead `tool_calls` record, then allow), in-turn Approval Request with a 15-minute timeout (ADR 0007), host MCP `send_message`. Requirement: keep Claude Code's general-purpose execution ability.

## Threat model (fix this before comparing anything)
Attacker = arbitrary code execution inside the turn container. They control the CLI process, everything it writes on stdio to the host SDK, the workspace, and the session's CLAUDE_CONFIG_DIR, and those persist into later turns. Untrusted content may arrive from any tool result. Out of scope, stated as assumptions: host compromise, Docker/kernel escape, compromise of Anthropic or of the external services themselves. If you think the scope is wrong, say so with reasons.

## Premise to test first
Under this attacker, the PreToolUse gate is not a security boundary for anything executed inside the container, because the attacker decides whether the hook is called and can run arbitrary code inside one allowed Bash call. Prove or refute it with a script, not an argument. Also test what the attacker can do over stdio to the host: forge hook inputs, call host MCP tools with forged `claudecode/toolUseId`, or spoof results. Everything after this depends on the answer.

## Invariants
Each invariant gets two separate verdicts, never merged:
- **Observed**: what the harness showed, for the inputs it tried. It can refute a guarantee but cannot establish one.
- **Guaranteed by construction**: an architectural argument that it holds for every input, naming the assumptions it rests on (for example "the container has no route except the gateway", "the gateway parses HTTP exactly as the upstream does"). A guarantee with no observation is a hypothesis; an observation with no argument is an anecdote.

- I1 No byte of a real credential is observable from inside the container: env, files, /proc, responses, error bodies, logs it can read.
- I2 No packet leaves the container except to the gateway.
- I3 Every request reaching an external service with a real credential matches a policy decision for that exact request.
- I4 **Approval binding**: what executes is what was approved. Binding covers destination, method and path, and also the body, query parameters, headers that change semantics, and any other side-effect-relevant arguments. Examples: issue or PR text, GraphQL operation and variables on a single endpoint, refs and force flag in a `git push`, files in a multipart upload, recipients of a message, tool arguments for brokered calls. State what representation is approved and shown to the human, what is compared at execution time, and how canonicalization, streamed or chunked bodies, compression, retries and time-of-check versus time-of-use are handled.
- I5 Turn-scoped identity: a credential or token issued for turn N is useless after turn N ends or the host crashes.
- I6 The gateway's and broker's control planes (token registration, policy, approval answers) are unreachable from the container.
- I7 Every external side effect can be joined to one turn, and where possible to one `tool_use_id`, from records the container cannot write.
- I8 Each human decision is asked once: no double prompt across layers, and no approval of A that authorizes B.
- I9 No path bypasses policy: a capability denied or approval-gated on one path (for example a brokered tool) is not reachable ungated on another path (for example a CLI through the wire gateway with the same credential).
- I10 Gateway or broker down ⇒ fail closed.
Add invariants you find missing. For each, state whether the reference products claim it, and whether they claim it as a guarantee or as best effort.

## Work
1. **Path inventory.** List every path by which authority is exercised or data leaves: model API, gateway routes, DNS, direct IP, host.docker.internal / LAN, Docker socket, host MCP tools, `send_message` to chat, persisted workspace read by a later turn or by a host component, approval channel. Fill a matrix of paths × enforcement points. Empty cells are the bypasses.
2. **Source teardown of the seven projects** (NanoClaw, OneCLI 1.45 and v2, Iron Proxy, executor, Composio, just-bash, agentgateway). For each:
   - the problem it solves and where it enforces (wire or operation)
   - what it trusts
   - which invariants it enforces, with code path:line, and which it explicitly disclaims
   - what approval binds to in its code: method, path, or also body and arguments
   - published security advisories
   - what is a guarantee and what is a mitigation (for example LLM judges)
   - versions read
   These are not competitors; place each as a component or a pattern.
3. **Shortlist.** From the teardown alone, eliminate products and architectures that cannot meet the threat model or the single-host constraint, and say why with citations. Keep at most two or three candidate architectures and one or two products per role. Prototype only the shortlist. The candidate space to shortlist from:
   - A. wire-only: MITM or base-URL gateway, with all CLIs in the container
   - B. operation-only: the container reaches only the model route, and every credentialed call goes through a host-side broker (typed MCP tools or Code Mode)
   - C. coexistence: credential injection through the wire gateway lets existing CLIs keep working, and MCP or Code Mode tools on a host broker serve the operations that need fine-grained authorization or approval. The same external service may be reachable through both. Specify how one policy and one approval cover both paths (I8, I9): per-service or per-operation path assignment, a shared decision point, or denying the wire path for operations the broker owns.
   - D. something else you propose
   For each shortlisted candidate: which layer is authoritative for which decision, where credentials live, where the call executes, and how approvals and audit join across layers.
4. **Uncertainty list.** Before building anything, list the technical unknowns whose answer would change the shortlist or the responsibility allocation. For each: the question, why it matters, which candidate it affects, and the smallest experiment that settles it. Measure only these. Candidates include:
   - the hook premise above
   - whether `--internal` permits DNS resolution of outside names
   - base-URL rewrite versus MITM, per CLI on the must-support list
   - whether the wire gateway can bind approval to the body for real CLIs' requests (GraphQL, git smart HTTP pack data, multipart, chunked, compressed), or only to method and path
   - whether a wire-level approval hold survives each client's timeout
   - whether per-turn token revocation stops the post-crash model call seen in #1
   - whether a shortlisted product fits Kurumi's per-turn container lifecycle (NanoClaw's lease and `sessions.ensure` shape is a precedent)
   - whether audit can carry `tool_use_id` to the wire layer
   - whether a compromised container can reach each shortlisted product's control plane
   - in candidate C, whether the same credential can be exercised through the wire path for an operation the broker gates
5. **Targeted harness.** Build only what the uncertainty list needs, from local fakes, and run the same scripts against every shortlisted candidate so results compare. Fakes:
   - a GitHub-like HTTPS API requiring `Bearer <CANARY_REAL>`, with GET and POST /repos/a/b/issues, a GraphQL endpoint, and POST /gists
   - an endpoint that echoes request headers and body back
   - an exfil sink
   - a fake authoritative DNS server
   - a fake model endpoint
   Each fake logs everything it receives, including bodies. Attack scripts run inside the container as the compromised agent. Pick the ones that touch the uncertainties:
   - read env, /proc and files for the canary
   - connect directly to an outside IP, the host, the LAN, and the Docker socket
   - DNS exfiltration
   - an allowed host with a disallowed method or path
   - use the gateway as an open proxy: CONNECT, Host/SNI mismatch, absolute-URI, HTTP/2 :authority, redirects
   - hit the echo endpoint so the injected secret comes back in the response
   - hit model-host paths other than those the CLI needs
   - reach a control plane; register its own token; answer its own approval
   - replay a token after the turn ends and after a host kill
   - skip or forge the hook; forge host MCP calls over stdio
   - approval swap: get approval for one request, then send the same destination, method and path with a different body or arguments; vary the GraphQL variables, the push refs, the multipart file
   - path bypass in candidate C: do through the CLI and wire gateway what the broker gates
   - plant a payload in the workspace for the next turn
   - hold an approval at the wire level past the CLI's HTTP timeout
   Each outcome: blocked or passed, at which point, the log line as evidence, and a canary grep over pcap, container filesystem, response bodies and logs.
6. **Generality floor.** For shortlisted candidates only, run in the container: `gh api`, `git clone` and `git push` over HTTPS, `npm install`, `pip install`, `curl`, Claude Code WebFetch, and a remote MCP server. Record works or breaks and the config needed (CA trust such as NODE_EXTRA_CA_CERTS and REQUESTS_CA_BUNDLE, proxy env vars, pinned certs, SSH-only remotes).
7. **Cost.** For shortlisted candidates and products: processes and containers added, idle RSS, config lines, glue code Kurumi must write (estimate in LOC), license, release cadence over the last 6 months, maturity and bus factor, upgrade burden (OneCLI's v1→v2 rewrite is a data point). Score each against safety, generality, simplicity, maintainability and operational burden.
8. **Responsibility allocation and build/buy.** A table assigning credential storage, injection, authn, authz decision, enforcement, approval (including what it binds to), egress, audit, and integration catalog to a layer and component, justified by teardown and harness results. For each component: build, adopt (which product and version), or library, with the observed reason. Note the trust shift for any choice that moves credentials off the machine (for example Composio's cloud).

## Settle by experiment, then recommend from what you observed
Prototype every item on the uncertainty list that an experiment can answer, and recommend from the results. Where an item cannot be settled without real credentials or real external accounts, do not run it: write down the experiment, what it would decide, and what credential or account it needs, and leave it for the operator to approve.

## Leave for the operator (do not decide; frame each with the evidence and the trade-off)
- which credentials may leave the machine
- the must-support list of services and CLIs (the generality floor)
- approval friction tolerance, and whether to revisit ADR 0007's no-remembered-grants rule
- acceptable residual risk inside allowed channels
- willingness to depend on pre-1.0 or vendor-backed projects
- operational budget
- any experiment that needs real credentials

## Rules
- Tag every claim: `code (path:line)`, `docs (url)`, `measured`, `inferred`, or `argued` (an architectural argument, with its assumptions listed). Never present inference or argument as measured. Open every URL you cite.
- Work only under `<scratchpad>/inv-boundary/<your-name>/`. Never edit the kurumi, nanoclaw, executor or onecli repos.
- Use fake canary secrets and local fake services by default. Touch no real external account and read no real credential, including the Claude token. A live Claude Code run counts as a real-credential experiment.
- Throwaway prototypes: speed over polish, no abstractions. Printed output and pcaps are the evidence. Record exact versions.
- Suggested slices if you fan out:
  1. threat model, path inventory, and the hook premise
  2. source teardown and shortlist
  3. targeted harness on the shortlist, with the generality floor
  4. synthesis
  Slices 3 and 4 start only after the shortlist and the uncertainty list exist.

## Report
`REPORT.md`: dense, cited, 2000–4000 words. Contents:
- the premise result
- the path × enforcement matrix
- per-project teardown, and the shortlist with the reasons for each elimination
- the uncertainty list, each item with its experiment and result, pasted output included
- an invariant table with separate Observed and Guaranteed-by-construction columns, the assumptions behind each guarantee, and approval binding broken down by method/path, body and other arguments
- the generality floor table
- cost and the five-axis assessment
- the responsibility allocation and build/buy recommendation with the observation behind each
- residual risks
- the operator decisions list, including deferred real-credential experiments
- what you could not verify
Keep the harness re-runnable with one command. The final message stays under 600 words, verdicts first, each with its evidence.
