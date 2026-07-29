# orchestrator

Multi-CLI worker orchestration.

The invoking agent or session acts as **commander**: it decomposes a task, dispatches implementation units to worker CLIs — Devin (default `swe-1-7`), Codex (default `gpt-5.6-luna` at xhigh), Cursor (default `composer-2.5`), Claude Code Fable 5 1M at low effort, or Grok (default `grok-4.5`) — each in its own git worktree, waits for completion, reviews diffs, sends feedback via `revise`, and merges everything into one integration branch.

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
- installs both skills globally with `npx skills add`, for all supported agent CLIs

If you only need the skills, install them directly:

```bash
npx skills add hckaye/orchestrator --skill orchestrator --skill orchestrator-handoff --agent '*' --global --copy --full-depth --yes
```

Requires Node.js (developed on v25) and the worker CLIs you want to use (`devin`, `claude`, `codex`, `cursor-agent`, `grok`) installed and authenticated.

## Config

`~/.orchestrator/config.json` — defaults:

| worker  | CLI            | default model       | effort                | permission          |
|---------|----------------|---------------------|-----------------------|---------------------|
| devin   | `devin`        | `swe-1-7`           | unsupported           | `dangerous` (auto)  |
| codex   | `codex`        | `gpt-5.6-luna`      | `xhigh`               | bypass approvals    |
| cursor  | `cursor-agent` | `composer-2.5`      | no variants           | `--yolo`            |
| claude  | `claude`       | `claude-fable-5[1m]`| `low`                | `bypassPermissions` |
| grok    | `grok`         | `grok-4.5`          | CLI default           | `always-approve`    |

Commander default model: `claude-fable-5[1m]` at low effort. Integration branch template: `integrate/${task}`, base: `main`.

Override a worker's model per-spawn with `--model` and its effort with `--effort`.

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
orchestrator spawn codex --model gpt-5.6-luna --effort xhigh -- "review the implementation"
```

This passes `gpt-5.6-luna` and `model_reasoning_effort="xhigh"` separately to Codex. It does not pass a model named `gpt-5.6-luna-xhigh`.

## Usage (commander)

The skill (`skill/SKILL.md`) is the full reference. Quick form:

```bash
orchestrator spawn devin  --model swe-1-7 -- "implement /api/orders in src/api/orders.ts"
orchestrator spawn codex  --model gpt-5.6-luna --effort xhigh -- "add pytest for src/api/orders.ts"
orchestrator spawn cursor -- "build OrdersForm in src/ui/OrdersForm.tsx"
orchestrator spawn claude --model 'claude-fable-5[1m]' --effort low -- "write orders migration"
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
