# orchestrator

Multi-CLI worker orchestration.

The invoking agent or session acts as **commander**: it classifies each implementation unit by risk, dispatches it to a suitable worker CLI in its own git worktree, waits for completion, reviews diffs, sends feedback via `revise`, and merges everything into one integration branch. The default selection policy is described below.

This tool spawns each worker CLI directly (`devin -p`, `claude -p`, `codex exec`, `cursor-agent -p`, `grok -p`) — no daemon, no hang.

## Install

```bash
git clone git@github.com:hckaye/orchestrator.git
cd orchestrator
# macOS / Linux
./install.sh
# Windows PowerShell: .\\install.ps1
```

`install.sh` is idempotent and safe to re-run. It:

- copies `orchestrator/` to `~/.orchestrator/` (preserves your existing `config.json`)
- runs `npm install` for `node-pty`
- installs an `orchestrator` command shim in `~/.local/bin/` (or `%USERPROFILE%\\.local\\bin\\` on Windows)
- installs both skills globally with `npx skills add`, only for worker CLIs found in `PATH`

If you only need the skills, install them directly:

```bash
npx skills add hckaye/orchestrator --skill orchestrator --skill orchestrator-handoff --global --copy --full-depth --yes
```

Requires Node.js (developed on v25) and the worker CLIs you want to use (`devin`, `claude`, `codex`, `cursor-agent`, `grok`) installed and authenticated.

## Config

`~/.orchestrator/config.json` — defaults:

| worker  | CLI            | default model       | effort                | permission          |
|---------|----------------|---------------------|-----------------------|---------------------|
| devin   | `devin`        | `swe-1-7`           | unsupported           | `dangerous` (auto)  |
| codex   | `codex`        | `gpt-5.6-luna`      | `max`                 | bypass approvals    |
| cursor  | `cursor-agent` | `composer-2.5`      | no variants           | `--yolo`            |
| claude  | `claude`       | `claude-opus-5`     | `high`                | `bypassPermissions` |
| grok    | `grok`         | `grok-4.5`          | CLI default           | `always-approve`    |

Commander default model: `claude-fable-5[1m]` at high effort. `gpt-5.6-sol` at xhigh is the alternative Commander choice. Integration branch template: `integrate/${task}`, base: `main`.

Override a worker's model per-spawn with `--model` and its effort with `--effort`.

### Default model-selection policy

Classify each unit before dispatching it. These are selection defaults, not a requirement to use every listed provider:

| Unit | Default worker choices |
|---|---|
| Routine | Cursor Composer 2.5 Standard; Cursor Grok 4.5 high when some complexity is expected; Grok CLI Grok 4.5; Devin SWE-1.7; GLM 5.2 |
| Wide-impact, important, or difficult | Codex GPT-5.6 Luna at `max`; Claude Code Opus 5.0 at `high` |
| Irreversible if wrong | Codex GPT-5.6 Sol at `xhigh`; Claude Fable 5 at `high` |

The irreversible tier is only for units whose failure cannot be recovered normally, such as frozen formats, ABI schemas, generated-contract changes, core soundness, or public ABI changes. Ordinary difficult work stays in the middle tier.

Cursor Grok 4.5 high and Grok CLI Grok 4.5 are separate providers with independent parallel capacity, so both may be dispatched in the routine tier. Cursor Composer, Cursor Grok, and Grok CLI have no orchestrator-wide parallel limit. Devin and GLM 5.2 share a limit of five concurrent implementation workers across projects; reviewer use is not part of that limit.

Use either Claude Fable 5 1M at `high` or GPT-5.6 Sol at `xhigh` for the Commander; Fable/high is the config default and Sol/xhigh is its alternative. The `commander` config entry is advisory because orchestrator does not launch or replace the invoking session, so select one of these models when starting the session when the host supports it. The three tiers above apply to dispatched workers, not to the Commander.

### Model and effort flags

At the orchestrator level, always keep these separate:

```bash
orchestrator spawn <type> --model <base-model> --effort <level> -- "<task>"
```

Do not append `-xhigh` (or another effort name) to the model passed to `orchestrator`. The adapter translates the separate `--effort` option for each underlying CLI:

| Worker | Underlying form |
|---|---|
| Devin | `--model <m>`; effort is unsupported |
| Codex | `--model <m> -c 'model_reasoning_effort="<level>"'`; Codex CLI has no `--effort` flag |
| Cursor | resolves the model ID to a listed `<base>-<level>` or `[effort=<level>]` variant when available |
| Claude | `--model <m> --effort <level>` |
| Grok | `--model <m> --effort <level>` (`--effort` aliases `--reasoning-effort`) |

For example, the correct Codex command is:

```bash
orchestrator spawn codex --model gpt-5.6-luna --effort max -- "implement an important cross-cutting change"
```

This passes `gpt-5.6-luna` and `model_reasoning_effort="max"` separately to Codex. It does not pass a model named `gpt-5.6-luna-max`.

## Usage (commander)

The skill (`skill/SKILL.md`) is the full reference. Quick form:

```bash
orchestrator spawn devin  --model swe-1-7 -- "implement /api/orders in src/api/orders.ts"
orchestrator spawn devin  --model glm-5.2 -- "implement a routine isolated unit"
orchestrator spawn codex  --model gpt-5.6-luna --effort max -- "implement an important cross-cutting change"
orchestrator spawn cursor -- "build OrdersForm in src/ui/OrdersForm.tsx"
orchestrator spawn cursor --model grok-4.5 --effort high -- "implement a somewhat complex routine unit"
orchestrator spawn claude --model claude-opus-5 --effort high -- "implement a difficult architecture change"
orchestrator spawn grok   --model grok-4.5 -- "review the integration tests and fix failures"

orchestrator ls
orchestrator wait <id> --timeout 1800      # block until worker idle
orchestrator pending                      # workers awaiting a response (interactive mode)
orchestrator respond <id> "y"             # answer a permission/question prompt

orchestrator review <id>                  # diff --stat vs base
orchestrator diff   <id>                  # full diff vs base
orchestrator revise <id> -- "fix X in src/foo.ts: handle empty list"  # resume + feedback
orchestrator resume <id>                              # continue after rate limit / transient failure
orchestrator resume <id> -- "wait 2m then continue"   # optional custom continuation message
orchestrator resumable                                # list workers that can be resumed
orchestrator handoff <id>                             # print cross-agent handoff briefing
orchestrator handoff-spawn cursor --from <id> -- "notes"  # new worker, same worktree
orchestrator merge  <id>                  # merge worker branch into integration branch
orchestrator integrate                    # merge all completed workers
orchestrator finish  --base main          # push integration branch + open PR
orchestrator archive <id>                 # remove worktree + state
orchestrator archive --older-than 1d      # archive every finished worker at least one day old
orchestrator archive --older-than 1d --dry-run  # preview without changing anything
```

### Review → revise cycle

Workers are resumable. Each worker's CLI session ID is captured automatically at spawn and stored in state. `orchestrator revise <id> -- "<feedback>"` resumes the worker on the same session in the same worktree, applies your feedback, and re-commits. Repeat `review → revise → wait` until the diff satisfies acceptance criteria, then `merge`.

If a worker stops early (rate limit, transient network error, etc.), `orchestrator resume <id>` continues on the same CLI session without review feedback. Failures matching known rate-limit/transient patterns are marked `failed-resumable`. Use `orchestrator resumable` to list resumable workers.

### Cross-agent handoff (best-effort)

When `resume` is impossible (no `sessionId`) or you want a **different** worker CLI to continue, use handoff. It packages the original task, worker log tail, branch diff, uncommitted worktree state, and prior status into a briefing, then spawns a new worker on the **same worktree**:

```bash
orchestrator handoff <source-id>                      # preview briefing
orchestrator handoff-spawn codex --from <source-id>   # spawn receiver
```

See skill `orchestrator-handoff` for the full workflow. Session memory does not transfer — only git state and reconstructed context.

### Permission bridge (hybrid)

- **Default (auto-approve):** workers run in `-p`/print mode with auto-approve flags. No prompts, no hang risk. Use for fire-and-forget implementation.
- **Interactive (respond-able):** `--interactive` at spawn runs the worker in a PTY; the supervisor detects permission/question prompts and flips the worker to `awaiting-permission` / `awaiting-question`. Answer via `orchestrator respond <id> <answer>`. Use only when you want to gate a worker's actions — PTY prompt detection is best-effort.

## Desktop UI

Optional Electron app to inspect worker sessions, live processes, and parent project context (sidebar + tabs).

Install the desktop app for the current OS:

```bash
cd desktop
npm install
npm run install:app
```

This installs and launches an app for the current user: an `.app` on macOS, a Start Menu application on Windows, or a `.desktop` launcher on Linux. To build distributable packages on the matching OS, use `npm run dist:mac`, `npm run dist:win`, or `npm run dist:linux`.

Dev run without installing:

```bash
cd desktop && npm start
```

See [desktop/README.md](desktop/README.md).

## Layout

```
orchestrator/
  orchestrator.js        CLI front (the `orchestrator` command)
  lib/
    cli-adapters.js      build argv + resume + session-id extraction per CLI
    worker.js            per-worker supervisor (spawn, state, IPC, PTY bridge, auto-commit)
    git.js               worktree + integration-branch merge + PR
    state.js             state files, logs, IPC sockets
    resume.js            resumable failure detection + continuation prompts
    handoff.js           cross-agent briefing builder (logs, diffs, worktree state)
  package.json           node-pty dependency
  config.example.json    default config (seeded on first install)
desktop/                 Electron session monitor (sidebar + tabs)
skill/
  SKILL.md               commander-facing skill reference
  handoff/SKILL.md       cross-agent handoff skill (orchestrator-handoff)
install.js               cross-platform CLI installer
install.sh               macOS/Linux CLI installer entry point
install.ps1              Windows PowerShell CLI installer entry point
```

## Notes

- Workers commit automatically on completion (so merge always has the diff).
- Workers are one worktree each, branched off the configured base. The commander's working tree is never disturbed — merges happen in a temporary integration worktree.
- No daemon. Each `spawn` / `revise` launches a detached `worker.js` process that owns one CLI subprocess and exits when the CLI exits.
