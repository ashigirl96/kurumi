# Issue 管理: GitHub

この repo の issue と仕様は GitHub の issue に置く。操作はすべて `gh` CLI で行う。

## 決まりごと

- **issue を作る**: `gh issue create --title "..." --body "..."`。複数行の本文は heredoc で渡す。
- **issue を読む**: `gh issue view <番号> --json number,title,body,labels,comments`
- **issue を一覧する**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` に、必要な `--label` と `--state` の絞り込みを付ける。
- **issue を親の子 issue にする**: `gh issue create --parent <親> ...`、または後から `gh issue edit <親> --add-sub-issue <子>`（`gh` 2.94 以降）。古い `gh` では `gh api --method POST repos/<owner>/<repo>/issues/<親>/sub_issues -F sub_issue_id=<子の database id>`（database id は下の **依存関係** と同じもの）。子 issue が使えないときは、子の本文の先頭に `Part of #<親>` と書く。
- **依存関係**: GitHub の **issue dependencies** を正式な表し方とする（UI にも出る）。`gh issue create --blocked-by <n>,<n> ...` か `gh issue edit <子> --add-blocked-by <先に要る issue>`（`gh` 2.94 以降）で辺を足す。古い `gh` では `gh api --method POST repos/<owner>/<repo>/issues/<子>/dependencies/blocked_by -F issue_id=<先に要る issue の database id>`。database id は数値の **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`）で、`#番号` や `node_id` では _ない_。dependencies が使えないときは、子の本文の先頭に `Blocked by: #<n>, #<n>` の行を書く。先に要る issue がすべて閉じたら着手できる。
- **未完了の先行 issue を数える**: `gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（開いているものだけを数え、0 なら着手できる）。`gh issue view <n> --json blockedBy` は閉じたものも返すので、`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'` で絞る。
- **comment する**: `gh issue comment <番号> --body "..."`
- **ラベルを付ける・外す**: `gh issue edit <番号> --add-label "..."` / `--remove-label "..."`
- **閉じる**: `gh issue comment <番号> --body "..."` で理由を書いてから `gh issue close <番号>`。既に閉じた issue に `gh issue close --comment` を使うと、comment が捨てられたまま exit 0 で終わる。

対象の repo は `git remote -v` から決まる。clone の中で動かせば `gh` が自動で判断する。

issue はユーザー自身の repo にだけ作る。これらの skill の出どころである `mattpocock/skills` には、ユーザーが持ち主でない限り作らない。fork の中では `gh` が上流の repo を既定にすることがあるので、session で最初に `gh issue create` する前に `gh repo view --json nameWithOwner` で行き先を確かめ、ユーザーの repo でなければ本人に確認する。

## pull request を triage の対象にするか

**PRs as a request surface: no.** _（外部からの PR を機能要望として扱う repo なら `yes` にする。`/triage` がこの値を読む。）_

`yes` のときは、PR も issue と同じラベルと状態で扱い、`gh pr` の同等のコマンドを使う。

- **PR を読む**: `gh pr view <番号>`、続けて `gh pr view <番号> --comments`（端末でないと `--comments` は本文を出さず comment だけを出す）、差分は `gh pr diff <番号>`。
- **triage する外部の PR を一覧する**: `gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`
- **comment・ラベル・閉じる**: `gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub は issue と PR で番号を共有するので、`#42` だけではどちらか分からない。`gh pr view 42` で調べ、無ければ `gh issue view 42` を試す。

## skill が「issue tracker に公開する」と言ったとき

GitHub の issue を作る。

## skill が「関係するチケットを取ってくる」と言ったとき

上の **issue を読む** のとおりに読む。

## wayfinding の操作

`/wayfinder` が使う。**地図** は 1 つの issue で、**子** の issue がチケットになる。

- **地図**: `wayfinder:map` ラベルを付けた 1 つの issue。本文に Notes / Decisions-so-far / Fog を持つ。`gh issue create --label wayfinder:map`。
- **子チケット**: GitHub の子 issue として地図につないだ issue（**issue を親の子 issue にする** を見る）。子 issue が使えないときは、地図の本文のタスクリストに子を足し、子の本文の先頭に `Part of #<地図>` と書く。ラベルは `wayfinder:<種類>`（`research`/`prototype`/`grilling`/`task`）。着手したら担当の開発者を assignee にする。
- **依存関係**: 決まりごとの **依存関係** を見る。
- **次の候補を探す**: 地図の開いている子を一覧し（`gh issue list --state open` を地図の子 issue かタスクリストに絞る）、未完了の先行 issue があるもの（**未完了の先行 issue を数える**、または `Blocked by` の行に開いた issue があるもの）と assignee がいるものを除く。地図の並びで最初のものを選ぶ。
- **着手する**: `gh issue edit <n> --add-assignee @me`。これを session で最初の書き込みにする。
- **片付ける**: `gh issue comment <n> --body "<答え>"`、次に `gh issue close <n>`、最後に地図の Decisions-so-far へ要点とリンクを足す。
