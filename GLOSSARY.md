# Kurumi

1 人の利用者のために、チャットから届いた依頼を隔離された環境のエージェントに処理させ、結果を返す個人用のエージェント基盤。

## エージェントと会話

**Agent（エージェント）**:
指示、作業場、権限をひと組にした、依頼を処理する主体。
_Avoid_: agent group、bot

**Channel（チャンネル）**:
チャットサービスとの接続 1 つ。
_Avoid_: adapter、platform

**Conversation（会話）**:
チャンネル上の 1 つのやり取りの場。チャットの部屋やスレッドに当たる。
_Avoid_: messaging group、chat、room

**Session（セッション）**:
1 つの会話で、1 つのエージェントが文脈を持ち続ける単位。
_Avoid_: thread、wiring

**Turn（ターン）**:
エージェントが入力を受けてから、受け取ったすべての受信メッセージに答え終えるまでの 1 回の処理。処理の途中で届いて受け取った受信メッセージも、そのターンに含める。
_Avoid_: run、query

**Interrupted Turn（中断されたターン）**:
利用者の停止、Kurumi の停止、エージェントの環境の異常な終わりのいずれかで、受け取った受信メッセージに答え終える前に止まったターン。やり直さず、止まったことを利用者に知らせる。
_Avoid_: failed turn、crashed turn

**Approval Request（承認依頼）**:
エージェントの操作を進めてよいか、ターンの途中で利用者に尋ねるもの。利用者の返事はこの依頼への答えであり、エージェントへの受信メッセージではない。
_Avoid_: permission prompt、confirmation

## メッセージ

**Inbound Message（受信メッセージ）**:
会話からエージェントに届くメッセージ。
_Avoid_: messages_in、input

**Outbound Message（送信メッセージ）**:
エージェントから会話へ返すメッセージ。
_Avoid_: messages_out、reply、output

## 境界

**Credential Gateway（資格情報ゲートウェイ）**:
エージェントの外への通信を受け、本物の資格情報の差し込み、アクセスの制御、承認、監査の記録を受け持つもの。エージェントは本物の資格情報を持たない。
_Avoid_: proxy、vault、OneCLI
