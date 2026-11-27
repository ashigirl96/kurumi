---
name: tackle
description: "仕様かチケットの束をもとに、作業を実装する。"
disable-model-invocation: true
---

作業は `issue-<番号>` の branch で行う。今の branch の名前が違えば、`git fetch origin main` してから `git switch --no-track -c issue-<番号> origin/main` で切る。

ユーザーが仕様かチケットで示した作業を実装する。

ユーザーがチケットを指したら、issue tracker から取ってきて、始める前にその title を述べる。どのチケットか曖昧なら聞く。

できる所では、事前に合意した境目で Skill tool に "tdd" を渡して呼ぶ。

型チェックとテストファイル単体の実行はこまめに回し、テスト全体は最後に 1 回流す。

終わったら Skill tool に "code-review" を渡して呼び、作業をレビューする。

作業は今の branch に commit する。
