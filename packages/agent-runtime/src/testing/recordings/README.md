# 本物の CLI とのやり取りの記録

本物の Claude Code CLI 2.1.332（SDK `0.3.332`、モデルは haiku）を、`dockerSandbox` と開発用の中継を通して流し、ホストの `spawnClaudeCodeProcess` が見た stdin と stdout を 1 行ずつ記録した。偽の CLI（次の単位）は、この形を返せばよい。

**確認したのは Docker Desktop for Mac（arm64）だけで、Linux では確かめていない。**

## 記録

| file | 筋書き | 結果 |
|---|---|---|
| `a.jsonl` | 初期化、PreToolUse フック（`onFailure: 'block'`）を通る Bash 1 回、ホストの MCP ツール `send_message` 1 回、最後の文 | `result` 1 つ（`success`）。コンテナは終了コード 0 |
| `b.jsonl` | 最後のツール結果の直後に `priority: 'next'` で押し込んだ受信 | `result` 2 つ。2 つ目が押し込んだ受信に答えた。終了コード 0 |
| `c.jsonl` | `sleep 20` の最中に `next` を押し込み、`interrupt({ cancelQueued: true })` | 押し込みは `cancelled`。`result` は `is_error: true`。終了コード 1 |

各行は次の形である。

```
{ "t": ISO の時刻, "dir": "sdk->cli" | "cli->sdk" | "spawn" | "exit", "msg": <1 行の JSON> }
```

先頭の `spawn` 行は SDK が `claude` に渡した引数（`cliArgs`）、末尾の `exit` 行は `docker run` の終了コードを持つ。`msg` が JSON として読めない行は文字列のまま入る。
`system/init` の `commands` などの長い欄は、そのまま残している。

## 流し直し

```sh
docker build -t kurumi-agent:sdk-0.3.332 packages/agent-runtime/container
CLAUDE_REAL_TOKEN=<本物のトークン> bun packages/agent-runtime/src/testing/recordings/record.ts [a] [b] [c]
```

引数なしで a〜c を全部流し、`a.jsonl` などを上書きする。`up` と `down`（`src/real/dev-env.ts`）で `kurumi-dev-internal`（`--internal`）と中継のコンテナを作り、終わると片付ける。
本物のトークンは中継のコンテナの環境にだけ入る。流した後は、記録に入っていないことを `grep -F` で確かめる。

## 偽の CLI が返す形

以下は記録から読み取った形である。引用の行番号は `a.jsonl` などの 0 始まりの行である。

### 起動

- ホストは `claude --output-format stream-json --verbose --input-format stream-json --model=haiku --disallowedTools=... --setting-sources= --strict-mcp-config --permission-mode=bypassPermissions --allow-dangerously-skip-permissions` を呼ぶ（`a.jsonl` 0 行）。`--setting-sources=` は値が空である。
- stdin から先に入るのは `initialize` の `control_request` と最初の `user` で、CLI の返事を待たない（`b.jsonl` 1〜2 行は 2 ms 差）。

### 初期化の要求と返事

要求（`sdk->cli`、`a.jsonl` 1 行）:

```
{ "request_id": "<SDK の乱数>", "type": "control_request",
  "request": { "subtype": "initialize", "systemPrompt": [""],
    "hooks": { "PreToolUse": [{ "hookCallbackIds": ["hook_0"], "timeout": 60, "onFailure": "block" }] },
    "sdkMcpServers": ["kurumi"],
    "sdkMcpServerManifests": { "kurumi": { "initializeResult": {...}, "toolsListResult": { "tools": [{ "name": "send_message", ... }] } } } } }
```

- `hooks` と `sdkMcp*` はフックや MCP を渡したときだけ付く（`b.jsonl` 1 行は `systemPrompt` だけ）。
- MCP の `initialize` と `tools/list` は、この要求の `sdkMcpServerManifests` に入って来る。CLI から `mcp_message` で聞き直されることはなく、`tools/call` だけが往復する。

返事（`cli->sdk`、`a.jsonl` 2 行）。包みは `{ "type": "control_response", "response": { "subtype": "success", "request_id": <要求と同じ>, "response": {...}, "pending_permission_requests": [...], "pending_user_dialog_requests": [...] } }` で、`response` の中身は次のとおり。

- 型定義（`sdk.d.ts` の `SDKControlInitializeResponse`）で `?` が付かないもの。空の配列や文字列でもよいかは確かめていない: `commands`、`agents`、`output_style`、`available_output_styles`、`models`、`account`。記録の `account` は `{ "tokenSource": "CLAUDE_CODE_OAUTH_TOKEN", "apiProvider": "firstParty" }` だけだった。
- **`hook_on_failure_supported: true`**: すべての `initialize` の返事に付いていた（フックを渡さない `b.jsonl`、`c.jsonl` でも）。`onFailure: 'block'` を守る CLI の印で、無いと SDK はセッションを拒む（`sdk.d.ts` 5132 行あたり）。
- **`hooks_applied: true`**: フックを渡した `a.jsonl` にだけある。`onFailure: 'block'` のフックを渡して `false` が返ると、SDK はセッションを拒む。フックを渡さないと欄ごと無い。
- ほかに付いていた欄: `pid`、`claude_code_version: "2.1.332"`、`current_permission_mode`、`sdk_mcp_manifests_parked: { "kurumi": "parked" }`（MCP を渡したとき）、`capabilities`。

### 最初の受信とターンの始まり

- 受信（`sdk->cli`）は `{ "type": "user", "message": { "role": "user", "content": "<文>" }, "parent_tool_use_id": null, "uuid": "<ホストが決めた uuid>" }`。押し込みは `"priority": "next"` が付く（`b.jsonl` 10 行）。
- CLI は初期化の返事の直後、**`system/init` より先に** `command_lifecycle` の `queued` と `started` を返す（`b.jsonl` 4〜6 行）。`system/init` は `cwd: "/work"`、`session_id`、`tools`、`mcp_servers`、`capabilities`（`msg_lifecycle_v1` と `interrupt_cancel_queued_v1` を含む）、`user_message_uuids` を持つ。
- ターンごとに `system/init` が出る。2 つ目の `result` の前にも出た（`b.jsonl` 16 行）。

### `command_lifecycle`

```
{ "type": "command_lifecycle", "command_uuid": "<受信の uuid>", "state": "queued" | "started" | "completed" | "cancelled", "uuid": "<この通知の uuid>", "session_id": "..." }
```

- 押し込みを受け入れた直後に `queued`（`b.jsonl` 11 行、受信の 8 ms 後）。
- 順序の実測（`b.jsonl`）: 最初の受信 `queued`、`started`、押し込み `queued`、最初の受信 `completed`、押し込み `started`、押し込み `completed`。`completed` は対応する `result` の直後に出る。
- 押し込みは最後のツール結果のあとに来ても取り込まれず、別のターン（別の `result`）で答えられる。1 つ目の `result` の `user_message_uuids` は最初の受信だけ、2 つ目は押し込みだけを持つ。

### PreToolUse フックの往復

要求（`cli->sdk`、`a.jsonl` 11 行）。直前の `assistant` の `tool_use` の後に来る。

```
{ "type": "control_request", "request_id": "<CLI の uuid>",
  "request": { "subtype": "hook_callback", "callback_id": "hook_0",
    "input": { "session_id", "transcript_path": "/cfg/projects/-work/<session>.jsonl", "cwd": "/work", "prompt_id", "permission_mode": "bypassPermissions",
               "effort": { "level": "medium" }, "hook_event_name": "PreToolUse", "tool_name": "Bash",
               "tool_input": {...}, "tool_use_id": "toolu_..." },
    "tool_use_id": "toolu_..." } }
```

返事（`sdk->cli`、12 行）:

```
{ "type": "control_response", "response": { "subtype": "success", "request_id": <同じ>,
  "response": { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } } } }
```

- `callback_id` は `initialize` の `hookCallbackIds` のどれか。`tool_use_id` は直前の `assistant` の `tool_use` の `id` と同じ。
- Bash、`ToolSearch`、MCP の `send_message` のすべてでフックが呼ばれた。MCP ツールはモデルが先に `ToolSearch` で見つけ、その結果は `tool_reference` の欄だった（`a.jsonl` 18 行）。
- フックが許可すると、後続のツール結果に `tool_result_meta: [{ "id", "permission_decision": { "decision": "accept", "source": "hook", "reason_type": "hook" } }]` が付く（フックの無い `b.jsonl` は `source: "config"`）。

### MCP の往復と `_meta["claudecode/toolUseId"]`

要求（`cli->sdk`、`a.jsonl` 22 行）:

```
{ "type": "control_request", "request_id": "<CLI の uuid>",
  "request": { "subtype": "mcp_message", "server_name": "kurumi",
    "message": { "jsonrpc": "2.0", "id": 2, "method": "tools/call",
      "params": { "name": "send_message", "arguments": { "text": "progress ok" },
                  "_meta": { "claudecode/toolUseId": "toolu_...", "progressToken": 2 } } } } }
```

返事（`sdk->cli`、23 行）:

```
{ "type": "control_response", "response": { "subtype": "success", "request_id": <同じ>,
  "response": { "mcp_response": { "jsonrpc": "2.0", "id": 2, "result": { "content": [{ "type": "text", "text": "sent" }] } } } } }
```

- `_meta["claudecode/toolUseId"]` は、同じ呼び出しの `assistant` の `tool_use.id` と、フックの `tool_use_id` に一致した。
- 続く `user` の `tool_result` は `content: [{ "type": "text", "text": "sent" }]`（24 行）。

### `interrupt` の要求と返事（`c.jsonl`）

```
sdk->cli  { "request_id": "<SDK の乱数>", "type": "control_request", "request": { "subtype": "interrupt", "cancel_queued": true } }   (11 行)
cli->sdk  { "type": "command_lifecycle", "command_uuid": "<押し込み>", "state": "cancelled", ... }                                 (12 行)
cli->sdk  { "type": "control_response", "response": { "subtype": "success", "request_id": <同じ>,
            "response": { "still_queued": [], "cancelled": ["<押し込みの uuid>"] } } }                                             (13 行)
```

- `cancelled` の通知と返事は、要求の 13 ms 後に同じ時刻（47.172）で届き、通知が先だった（要求 47.159）。
- 続いて、走っていた Bash の `tool_result`（`is_error: true`、`"The user doesn't want to proceed with this tool use..."`、`tool_result_meta` は `non_execution_kind: "user-rejected"`）、`[Request interrupted by user for tool use]` の `user`、`result`、最初の受信の `command_lifecycle` `cancelled`。
- 押し込みは実行されず、`result` は 1 つだけだった。`command_lifecycle` の順序は、最初の受信 `queued`、`started`、押し込み `queued`、押し込み `cancelled`、最初の受信 `cancelled`。
- 中断を求めて入力を閉じると、コンテナは終了コード 1 で終わった。

### `result`（`is_error` と `terminal_reason`）

次の欄を見れば足りる。ほかに `usage`、`modelUsage`、`total_cost_usd`、`duration_ms`、`num_turns`、`uuid`、`session_id` などが付く。

| 場面 | `subtype` | `is_error` | `terminal_reason` | `result` / `errors` | `user_message_uuids` |
|---|---|---|---|---|---|
| 完了（`a.jsonl` 26 行、`b.jsonl` 13、18 行） | `success` | `false` | `completed` | `result` は最後の文 | 答えた受信の uuid 1 つ |
| `interrupt` で止めた（`c.jsonl` 16 行） | `error_during_execution` | `true` | `aborted_tools` | `errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]` | 走っていた受信の uuid |

`user_message_uuid`（単数）も付く。完了の `result` の後に、その受信の `command_lifecycle` `completed` が来る。

`is_error: true` の別の形は、試作 p7-resume-retry の README に実測がある（今回は流し直していない。試作は repo の外にある）。

試作の README（`p7-resume-retry/README.md`）の表の、該当する欄をそのまま引く（実測、Docker Desktop for Mac）。

CLI が API で諦めたとき（表の 2 行目）:

> An `assistant` message with `error=server_error` (or `rate_limit`) and the text `"API Error: 500 injected 500. This is a server-side issue..."`, then a `result` with **`subtype:"success"`**, `is_error:true`, `terminal_reason:"api_error"`, `api_error_status:500` (or 529, 429), `api_error_type`, `stop_reason:"stop_sequence"`. The container exits 1. **Do not branch on `subtype`.** Branch on `is_error` and `terminal_reason`.

存在しない会話を `resume` したとき（表の 1a）:

> **Fails loudly.** `result` `subtype=error_during_execution`, `is_error=true`, `num_turns=0`, `errors=["No conversation found with session ID: <id>"]`. No `system/init` is sent, the container exits with code 1, and the SDK iterator **ends normally** without throwing.

ツールを呼んだ後に失敗したとき（表の 5）:

> The stream shows `assistant tool_use:Bash(...)`, then `user tool_result:"tool-ran"`, then `system/api_retry`, then the API-error assistant, then `result` `subtype:"success"`, `is_error:true`, `terminal_reason:"api_error"`, `num_turns:2`. The tool's side effect happened (`work/proof.txt` = `tool-ran`). In the result, only `num_turns:2` hints that a tool ran. The reliable signal is a host-observed `tool_use` block after this turn's prompt.

## 試作と違った点

- 試作は `--add-host <API のホスト>:127.0.0.1` で外向きを塞ぎ、`host.docker.internal` の中継へ向けた。ここは `--internal` ネットワークに置き、中継のコンテナ名（`kurumi-dev-relay`）で届く。外のホスト名は引けない（`EAI_AGAIN`）ことを、同じイメージで確かめた。
- 試作の偽トークンは固定の `placeholder-not-a-token`。ここはターンごとに `kurumi-fake-<uuid>` で、中継はこの接頭辞のないものを 401 で断る。
- 試作は `docker run -e KEY=VALUE`。ここは `-e KEY` だけを引数に並べ、値は docker の client process の環境で渡す（偽トークンをホストの `ps` に出さないため）。
- 試作のイメージは `useradd` で利用者を作り `--user 1001:1001`。ここは利用者を作らず、ホストの `uid:gid` で走らせた。
- 試作のイメージは `linux/arm64` 固定。ここは固定せず、`linux-x64` と `linux-arm64` の `claude` を `find` で選ぶ（amd64 の方は確かめていない）。
- 初期化の要求と返事の生の形を、ここで記録した。`hook_on_failure_supported` は常にあり、`hooks_applied` はフックを渡したときだけあった。
