# ドメインの文書

engineering 系の skill が codebase を調べるときに、この repo のドメインの文書をどう読むかを決める。

## 調べる前に読むもの

- ルートの **`GLOSSARY.md`**、または
- ルートに **`GLOSSARY-MAP.md`** があればそれ。コンテキストごとの `GLOSSARY.md` を指しているので、話題に関係するものをそれぞれ読む。
- **`docs/adr/`**: これから手を入れる範囲に関わる ADR を読む。複数コンテキストの repo では、コンテキストに限った決定が `src/<context>/docs/adr/` にもあるので見る。

これらのファイルが無ければ、**何も言わずに進む**。無いことを指摘せず、前もって作ろうとも言わない。用語や決定が実際に固まったときに、`/domain-modeling` skill（`/grill-with-docs` と `/improve-codebase-architecture` から呼ばれる）が必要に応じて作る。

## ファイルの構成

単一コンテキストの repo（ほとんどの repo）:

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

複数コンテキストの repo（ルートに `GLOSSARY-MAP.md` がある）:

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system 全体の決定
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← コンテキストに限った決定
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## 用語集の言葉を使う

出力でドメインの概念に名前を付けるとき（issue の title、リファクタの提案、仮説、テストの名前）は、`GLOSSARY.md` で定めた用語を使う。用語集が避けると明記した同義語に流れない。

必要な概念が用語集にまだ無ければ、それ自体が手がかりになる。プロジェクトが使っていない言葉を作り出している（考え直す）か、本当に抜けている（`/domain-modeling` のために書き留める）かのどちらかである。

## ADR との食い違いを示す

出力が既存の ADR と食い違うなら、黙って上書きせずにはっきり示す。

> _ADR-0007（event-sourced orders）と食い違うが、…のため見直す価値がある_
