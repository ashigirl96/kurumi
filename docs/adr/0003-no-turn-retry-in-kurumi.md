# Kurumi はターンを再試行しない

モデル呼び出しの失敗は Claude Code CLI がすでに自分で再試行するので（500、529、429 のいずれでも 11 回まで、約 3 分、実測）、Kurumi は重ねて再試行しない。CLI が諦めたら、`subtype` ではなく `is_error` と `terminal_reason` で失敗と判定し、モデルを呼べなかったことを利用者に知らせてターンを終える。Interrupted Turn（中断されたターン）もやり直さない。CLI 自身が中断されたターンをやり直す `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` は、コンテナに渡さない。

## Consequences

- 失敗した試行は会話記録に残るので、利用者が送り直した文は会話の中に 2 度現れる。間に API エラーの記録が入るため、起きたとおりの記録として残す。
- 失敗した試行を `resumeSessionAt` と `resumeDropsTurn` で切り捨てる手順は持たない。
