# エージェントのイメージ

Turn ごとのコンテナで動かす Claude Code CLI のイメージ。SDK `0.3.332` を入れると付いてくる linux 向けの `claude`（CLI 2.1.332）を PATH に置く。
アーキテクチャは固定しない。`docker build` を動かした先（`linux/arm64` か `linux/amd64`）の `claude` が入る。
専用の利用者は作らない。`docker run --user <uid:gid>` で走らせる。

```sh
docker build -t kurumi-agent:sdk-0.3.332 packages/agent-runtime/container
```

SDK の版を上げるときは、`Dockerfile` の版、タグ、root の `package.json` の catalog を一緒に変える。

確認は Docker Desktop for Mac（arm64）だけで行った。Linux の本番機（amd64 を含む）では確かめていない。
