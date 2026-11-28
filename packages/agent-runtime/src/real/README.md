# 本物での確認

本物の Docker と Claude Code CLI（モデルは haiku）で、偽の CLI では分からない振る舞いを確かめる。
目的は 2 つある。偽の CLI（`../testing/fake-cli.ts`）が本物からずれていないことと、SDK の型定義に載っていない依存がまだ動くことを、SDK と CLI の版を上げるたびに流し直して確かめる。

ふだんの `bun run check` では流れない。`KURUMI_REAL_CHECKS=1` のときだけ流れ、それ以外は skip される。

**確認したのは Docker Desktop for Mac（arm64）だけで、Linux では確かめていない。** Linux の本番機での隔離の確認は `docs/linux-isolation-check.md`。

## 流し方

必要なもの: Docker、定額プランのトークン（`CLAUDE_REAL_TOKEN`）、モデルを呼べるネットワーク。

```sh
docker build -t kurumi-agent:sdk-0.3.332 packages/agent-runtime/container
CLAUDE_REAL_TOKEN=<Claude Code の OAuth トークン> \
  KURUMI_REAL_CHECKS=1 bun test packages/agent-runtime/src/real/real.test.ts
```

全部で 1 分ほどかかる。テストは自分で中継とネットワークを起こして片付けるので、手で `up` や `down` を流す必要はない。

- 本物のトークンは、中継のコンテナの環境にだけ入る（`dev-env.ts` の `up`）。テストのプロセスは、中継を起こした後で環境からトークンを消す。エージェントのコンテナには、ターンごとの偽トークン（`kurumi-fake-<uuid>`）だけが渡る。表示も記録もしない。
- 中継は `kurumi-dev-relay`、ネットワークは `kurumi-dev-internal`（`--internal`）。中継を手で起こすときは `CLAUDE_REAL_TOKEN=… bun packages/agent-runtime/src/real/dev-env.ts up`、片付けは `… down`。
- エージェントのコンテナのラベルは `kurumi.agent=real-checks`。ふだんのラベル（`kurumi.agent=1`）と分けてあるので、`Runtime` の起動時の掃除が、手元の別のコンテナを巻き込まない。各テストの後と全部の後に、このラベルのコンテナと中継、ネットワーク、一時ディレクトリを消す。
- 途中で落とした後に残ったものは `docker rm -f $(docker ps -aq --filter label=kurumi.agent=real-checks) kurumi-dev-relay; docker network rm kurumi-dev-internal` で消せる。
- ホストを強制終了するテストの後、`write /dev/stdout: broken pipe` という docker の行が出ることがある。ホストと一緒に死んだ docker の client が、読み手のいない pipe に書いた跡で、失敗ではない。

## 確かめていること

| テスト | 確かめること | 偽の CLI との対応・型定義に載っていない依存 |
|---|---|---|
| 遅れて押し込んだ `next` | ツール結果の後に押し込んだ受信が、別の `result` で答えられる。1 つのターン、2 つの `final`、受信は両方 `answered` | `priority: 'next'` と `command_lifecycle` の順序 |
| ホストを関所の中で強制終了する | 別のプロセスで `Runtime` を起こし、関所（`policy`）の中で SIGKILL する（`kill-host.ts`）。ツールが動かない。コンテナも止まる（ユーザーストーリー 32） | `onFailure: 'block'` のフック |
| `result` の直後にコンテナを捨てても `resume` できる | ターンの後にコンテナが残らず、次のターンが前の内容を覚えている。`claude_session_id` が変わらない | `resume` と会話記録の照合 |
| `cancelQueued` | `/stop` で、待っていた押し込みが `cancelled` になり、実行されない（`started` は 1 つ、`result` は 1 つ） | `interrupt({ cancelQueued: true })`（型定義に無い） |
| `_meta` | 送るツールの `progress` の冪等キーが、CLI の `tool_use` の id と `tool_calls` の行に一致する | `extra._meta["claudecode/toolUseId"]`（型定義に無い） |
| 硬化フラグ | 動いているコンテナを `docker inspect` で見て、フラグが付いている。そのうえで 1 つのターンが完走する | `dockerRunArgs` のフラグ一式 |
| 仕込まれた設定 | 作業場所と `CLAUDE_CONFIG_DIR` に置いたフックと MCP の設定が動かない。同じファイルは `settingSources` を開けると動く（対照） | `settingSources: []`、`strictMcpConfig` |
| 止めてから `resume` | `/stop` の後の次のターンが、`lost` にならずに完了する | 照合（`transcriptHolds`） |
| `/` で始まる文 | `/help` が CLI のコマンドとして実行されない | 下の「分かっていること」 |

`CLAUDE_CODE_MAX_RETRIES`（型定義に載っていない 3 つ目の依存）は、仕様の 8 つの筋書きに入っていないので、ここでは確かめていない。

## 分かっていること

- `/help` のような `/` で始まる文は、今の `Runtime` では CLI のコマンドとして実行される。`system` の `local_command_outcome` が `unavailable_headless` で、`num_turns` は 0、モデルは呼ばれず、利用者には `/help isn't available in this environment.` が返る（SDK 0.3.332、CLI 2.1.332、Mac）。`Runtime` は `client_composed: true` を付けていない。
- `client_composed: true` を付けると、同じ文がエージェントへの文として扱われる（`num_turns` が 1 以上）。この確認は、テスト「client_composed を付けるとエージェントへの文として扱われる」にある。
- そのため、`/` で始まる文のテストは `test.failing`（今は失敗するのが正しい）にしてある。`Runtime` が `client_composed` を付けて直したら、このテストが「通ってしまった」と言って失敗するので、`.failing` を外す。

## SDK と CLI の版を上げるとき

1. 次を一緒に変える: `container/Dockerfile` の版、イメージのタグ、root の `package.json` の catalog、`dev-env.ts` の `agentImage`、`container/README.md`、この README のコマンド。
2. イメージを作り直す（上の `docker build`）。
3. 上の「流し方」で本物の確認を流す。落ちたテストが、ずれた依存を指している。
4. 偽の CLI がずれていないかを見る。`testing/recordings/record.ts` で記録を取り直し（`testing/recordings/README.md`）、`git diff` で形の変化を見て、`testing/fake-cli.ts` とそのテストを合わせる。
5. 隔離の確認も流し直す（`docs/linux-isolation-check.md`）。Mac では `bun packages/agent-runtime/src/real/isolation-check.ts --with-model`。

## ファイル

| file | 役割 |
|---|---|
| `real.test.ts` | 上の筋書き。`describe.skipIf` で環境変数がないと skip |
| `support.ts` | 本物の Docker 用の `Runtime` の道具、CLI の出力を控える Sandbox の包み（`tappedSandbox`）、待つ関数 |
| `kill-host.ts` | ホストを強制終了する筋書きで、別のプロセスとして起こすホスト |
| `dev-env.ts`、`dev-relay.ts` | 開発用の中継と `--internal` ネットワーク。Credential Gateway の実装ではない |
| `isolation-check.ts` | 隔離の確認の script（`docs/linux-isolation-check.md`） |
