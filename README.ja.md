# orchestrator

> [!WARNING]
> このツールは、基本的に Agent CLI のパーミッション確認をバイパスして実行します。安全に隔離された環境で使用するか、自己責任で実行してください。

[English](README.md) | [日本語](README.ja.md)

複数の Agent CLI に作業を割り振るためのツールです。

このツールを呼び出したエージェントまたはセッションが **Commander** になります。Commander は実装単位ごとにリスクを判断し、それぞれ独立した git worktree で動く Agent CLI に作業を割り振ります。完了した作業はほかの処理を待たずに順次レビューし、必要なら `revise` で修正を依頼して、1 本の統合ブランチにマージします。既定の選択方針は後述します。

各 Agent CLI は直接起動します（`devin -p`、`claude -p`、`codex exec`、`cursor-agent -p`、`grok -p`）。デーモンは使用しないため、デーモンの停止によって処理が進まなくなることはありません。

## インストール

```bash
git clone git@github.com:hckaye/orchestrator.git
cd orchestrator
# macOS / Linux
./install.sh
# Windows PowerShell: .\\install.ps1
```

`install.sh` は繰り返し実行できます。実行内容は次のとおりです。

- `orchestrator/` を `~/.orchestrator/` にコピーします。既存の `config.json` は保持します。
- `node-pty` の `npm install` を実行します。
- `orchestrator` コマンドを `~/.local/bin/` にインストールします。Windows では `%USERPROFILE%\\.local\\bin\\` を使用します。
- `PATH` に存在する Agent CLI を対象に、`npx skills add` で両方のスキルをグローバルにインストールします。

スキルだけが必要な場合は、直接インストールできます。

```bash
npx skills add hckaye/orchestrator --skill orchestrator --skill orchestrator-handoff --global --copy --full-depth --yes
```

Node.js（開発時は v25 を使用）と、使用する Agent CLI（`devin`、`claude`、`codex`、`cursor-agent`、`grok`）のインストールおよび認証が必要です。

## 設定

`~/.orchestrator/config.json` の既定値は次のとおりです。

| worker  | CLI            | 既定のモデル       | effort                | パーミッション          |
|---------|----------------|---------------------|-----------------------|---------------------|
| devin   | `devin`        | `swe-1-7`           | 非対応                | `dangerous`（自動）  |
| codex   | `codex`        | `gpt-5.6-luna`      | `max`                 | 承認をバイパス       |
| cursor  | `cursor-agent` | `composer-2.5`      | バリエーションなし    | `--yolo`             |
| claude  | `claude`       | `claude-opus-5`     | `high`                | `bypassPermissions` |
| grok    | `grok`         | `grok-4.5`          | CLI の既定値          | `always-approve`     |

Commander の既定モデルは `claude-fable-5[1m]`、effort は `high` です。代わりに `gpt-5.6-sol` と `xhigh` も選択できます。統合ブランチのテンプレートは `integrate/${task}`、ベースブランチは `main` です。

worker ごとのモデルは `--model`、effort は `--effort` で起動時に変更できます。

### 既定のモデル選択方針

作業を割り振る前に、実装単位ごとに分類します。すべてのプロバイダーを使う必要はありません。

| 実装単位 | 既定の worker 候補 |
|---|---|
| 定型的な作業 | Cursor Composer 2.5 Standard。多少複雑な場合は Cursor Grok 4.5 high。Grok CLI Grok 4.5、Devin SWE-1.7、GLM 5.2 も選択可能 |
| 影響範囲が広い、重要、または難しい作業 | Codex GPT-5.6 Luna の `max`、Claude Code Opus 5.0 の `high` |
| 間違えた場合に元に戻せない作業 | Codex GPT-5.6 Sol の `xhigh`、Claude Fable 5 の `high` |

元に戻せない作業向けのモデルは、固定済みのフォーマット、ABI スキーマ、生成される契約の変更、健全性の中核、公開 ABI の変更など、通常の方法では失敗から復旧できない場合だけに使用します。単に難しいだけの作業には、中段のモデルを使用します。

Cursor Grok 4.5 high と Grok CLI Grok 4.5 は別のプロバイダーで、並列処理の枠も独立しています。そのため、定型的な作業に両方を割り振れます。Cursor Composer、Cursor Grok、Grok CLI には、orchestrator 全体の並列数制限はありません。Devin と GLM 5.2 は、プロジェクト全体で実装用 worker を 5 個まで同時に使用できます。レビュー用途はこの制限に含みません。

Commander には Claude Fable 5 1M の `high` または GPT-5.6 Sol の `xhigh` を使用します。設定上の既定値は Fable/high で、Sol/xhigh も選択できます。`commander` の設定は参考値です。orchestrator は呼び出し元のセッションを起動したり置き換えたりしないため、利用環境が対応している場合は、セッション開始時にどちらかのモデルを選択してください。上記の 3 段階は、割り振り先の worker に適用します。Commander には適用しません。

### モデルと effort の指定

orchestrator では、モデルと effort を別々に指定します。

```bash
orchestrator spawn <type> --model <base-model> --effort <level> -- "<task>"
```

orchestrator に渡すモデル名へ `-xhigh` などの effort 名を追加しないでください。adapter は個別に指定された `--effort` を、各 Agent CLI に合った形式へ変換します。

| Worker | Agent CLI に渡す形式 |
|---|---|
| Devin | `--model <m>`。effort は非対応 |
| Codex | `--model <m> -c 'model_reasoning_effort="<level>"'`。Codex CLI に `--effort` フラグはありません |
| Cursor | 一覧に存在する `<base>-<level>` または `[effort=<level>]` のバリエーションを使用 |
| Claude | `--model <m> --effort <level>` |
| Grok | `--model <m> --effort <level>`。`--effort` は `--reasoning-effort` の別名 |

Codex の正しい実行例は次のとおりです。

```bash
orchestrator spawn codex --model gpt-5.6-luna --effort max -- "implement an important cross-cutting change"
```

このコマンドは、`gpt-5.6-luna` と `model_reasoning_effort="max"` を別々に Codex へ渡します。`gpt-5.6-luna-max` というモデル名は渡しません。

## Commander からの使い方

詳しい仕様は `skill/SKILL.md` にあります。主なコマンドは次のとおりです。

```bash
orchestrator spawn devin  --model swe-1-7 -- "implement /api/orders in src/api/orders.ts"
orchestrator spawn devin  --model glm-5.2 -- "implement a routine isolated unit"
orchestrator spawn codex  --model gpt-5.6-luna --effort max -- "implement an important cross-cutting change"
orchestrator spawn cursor -- "build OrdersForm in src/ui/OrdersForm.tsx"
orchestrator spawn cursor --model grok-4.5 --effort high -- "implement a somewhat complex routine unit"
orchestrator spawn claude --model claude-opus-5 --effort high -- "implement a difficult architecture change"
orchestrator spawn grok   --model grok-4.5 -- "review the integration tests and fix failures"

orchestrator ls
orchestrator wait <id> --timeout 120      # reconcile loop での短い待機（全 worker の一括待機より優先）
orchestrator wait <id> --timeout 1800     # ID ごとにバックグラウンド通知する場合のみ、長い待機も使用可能
orchestrator pending                      # 応答待ちの worker（interactive mode）
orchestrator respond <id> "y"             # パーミッション確認や質問に回答

orchestrator review <id>                  # この worker が完了したら、すぐにレビュー
orchestrator diff   <id>                  # ベースブランチとの差分全体
orchestrator revise <id> -- "fix X in src/foo.ts: handle empty list"  # セッションを再開して修正を依頼
orchestrator resume <id>                              # rate limit や一時的な失敗の後に再開
orchestrator resume <id> -- "wait 2m then continue"   # 任意の再開メッセージ
orchestrator resumable                                # 再開可能な worker の一覧
orchestrator handoff <id>                             # 別 Agent への引き継ぎ情報を表示
orchestrator handoff-spawn cursor --from <id> -- "notes"  # 同じ worktree で別 worker を起動
orchestrator merge  <id>                  # レビューを通過した worker をすぐにマージ
orchestrator archive <id>                 # マージ後または再利用できない失敗の後に必ず実行（worktree を削除）
orchestrator integrate                    # 完了した worker を一括マージ（任意）
orchestrator finish  --base main          # 統合ブランチを push して PR を作成
orchestrator archive --older-than 1d      # 残った worker を整理するための補助機能（個別の archive の代用にはしない）
orchestrator archive --older-than 1d --dry-run  # 変更せずに対象を確認
```

Commander の監視方法は `skill/SKILL.md` の Phase 2 を参照してください。**spawn だけでは完了しません。** worker を割り振るたびに `wait` を設定します。割り振るだけでは完了通知を受け取れないことがあります。worker の一覧を管理し、一括待機しかできない環境では、短い `wait` と `ls` を繰り返します。1 回のツール呼び出しで複数の長い待機を実行し、すべてが戻るまでレビューを始めない運用は避けてください。最初に完了した worker から処理します。マージに成功した後は必ず `archive` を実行し、再利用できない失敗に終わった worker も archive します。使用済みの worktree を残さないでください。

### レビューと修正

worker は同じセッションで再開できます。worker の Agent CLI セッション ID は起動時に自動取得され、状態として保存されます。`orchestrator revise <id> -- "<feedback>"` は、同じ worktree とセッションで worker を再開し、修正依頼を適用して再度コミットします。その worker が完了条件を満たすまで `review → revise → wait` を繰り返し、確認できたら `merge` します。並行して動いているほかの worker の完了を待つ必要はありません。

worker が rate limit や一時的なネットワークエラーなどで途中停止した場合は、`orchestrator resume <id>` で同じ Agent CLI セッションを再開できます。既知の rate limit や一時的な失敗に該当する場合、状態は `failed-resumable` になります。再開可能な worker は `orchestrator resumable` で確認できます。

### 別の Agent CLI への引き継ぎ

`sessionId` がなく `resume` できない場合や、別の Agent CLI で作業を続ける場合は handoff を使用します。元の依頼、worker のログ末尾、ブランチの差分、worktree の未コミット変更、直前の状態を引き継ぎ情報にまとめ、同じ worktree で新しい worker を起動します。

```bash
orchestrator handoff <source-id>                      # 引き継ぎ情報を確認
orchestrator handoff-spawn codex --from <source-id>   # 引き継ぎ先を起動
```

詳しい手順は `orchestrator-handoff` スキルを参照してください。Agent CLI のセッション記憶は引き継がれません。git の状態と、作業状況から再構成した情報だけが新しい worker に渡されます。

### パーミッション確認への応答

- **既定（自動承認）:** worker は `-p` または print mode と自動承認フラグを使って動作します。確認プロンプトは表示されないため、応答待ちで停止しません。途中で操作せずに実装を任せる場合に使用します。
- **対話モード（応答可能）:** 起動時に `--interactive` を指定すると、worker は PTY で動作します。supervisor はパーミッション確認や質問を検出し、worker の状態を `awaiting-permission` または `awaiting-question` に変更します。`orchestrator respond <id> <answer>` で回答してください。worker の操作を確認したい場合だけ使用します。PTY に表示される確認の検出は常に成功するとは限りません。

## デスクトップ UI

worker のセッション、実行中のプロセス、親プロジェクトの情報を確認するための Electron アプリも利用できます。サイドバーとタブで表示します。

現在の OS 向けにデスクトップアプリをインストールするには、次のコマンドを実行します。

```bash
cd desktop
npm install
npm run install:app
```

現在のユーザー用にアプリをインストールして起動します。macOS では `.app`、Windows ではスタートメニューのアプリ、Linux では `.desktop` ランチャーを作成します。各 OS 向けの配布パッケージは、対応する OS 上で `npm run dist:mac`、`npm run dist:win`、`npm run dist:linux` のいずれかを実行して作成できます。

インストールせずに開発用として起動する場合は、次のコマンドを実行します。

```bash
cd desktop && npm start
```

詳しくは [desktop/README.md](desktop/README.md) を参照してください。

## ファイル構成

```
orchestrator/
  orchestrator.js        CLI のエントリーポイント（`orchestrator` コマンド）
  lib/
    cli-adapters.js      CLI ごとの引数生成、再開、セッション ID 取得
    worker.js            worker の管理（起動、状態、IPC、PTY 応答、自動コミット）
    git.js               worktree、統合ブランチへのマージ、PR
    state.js             状態ファイル、ログ、IPC socket
    resume.js            再開可能な失敗の検出と再開メッセージ
    handoff.js           ログ、差分、worktree の状態から引き継ぎ情報を作成
  package.json           node-pty の依存関係
  config.example.json    既定の設定（初回インストール時に使用）
desktop/                 Electron のセッション監視画面（サイドバーとタブ）
skill/
  SKILL.md               Commander 向けのスキル仕様
  handoff/SKILL.md       Agent CLI 間の引き継ぎスキル（orchestrator-handoff）
install.js               複数 OS 対応の CLI インストーラー
install.sh               macOS/Linux 用 CLI インストーラーのエントリーポイント
install.ps1              Windows PowerShell 用 CLI インストーラーのエントリーポイント
```

## 補足

- worker は完了時に自動でコミットします。マージ対象には常に差分が含まれます。
- worker ごとに worktree を 1 個使用し、設定されたベースブランチから分岐します。マージは一時的な統合用 worktree で行うため、Commander の作業ツリーには影響しません。
- デーモンは使用しません。`spawn` または `revise` を実行するたびに、1 個の Agent CLI プロセスを管理する独立した `worker.js` プロセスが起動します。Agent CLI の終了後に `worker.js` も終了します。
