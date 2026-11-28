FROM oven/bun:1.4.4-debian
LABEL kurumi.dev/role=agent-image
WORKDIR /opt/claude
# procps は interrupt() で CLI がプロセスの木ごと止めるのに要る
RUN apt-get update && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/* \
 && echo '{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.332"}}' > package.json \
 && bun install \
 && ln -s "$(find /opt/claude/node_modules/@anthropic-ai -path '*claude-agent-sdk-linux-*' ! -path '*musl*' -name claude -type f)" /usr/local/bin/claude \
 && claude --version
