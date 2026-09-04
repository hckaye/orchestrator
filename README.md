# orchestrator

> [!WARNING]
> This tool runs Agent CLIs with permission checks bypassed by default. Use it in a safely isolated environment, or run it at your own risk.

[English](README.md) | [日本語](README.ja.md)

Multi-CLI worker orchestration.

The invoking agent or session acts as **commander**: it classifies each implementation unit by risk, dispatches it to a suitable worker CLI in its own git worktree, **pipelines** completions (reviews each worker as soon as it finishes while others still run instead of barrier-waiting for the whole cohort), sends feedback via `revise`, and merges into one integration branch. The default selection policy is described below.

This tool spawns each worker CLI directly (`devin -p`, `claude -p`, `codex exec`, `cursor-agent -p`, `grok -p`). It does not use a daemon, so there is no daemon hang.

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

Defaults in `~/.orchestrator/config.json`:

| worker  | CLI            | default model       | effort                | permission          |
|---------|----------------|---------------------|-----------------------|---------------------|
| devin   | `devin`        | `swe-1-7`           | unsupported           | `dangerous` (auto)  |
| codex   | `codex`        | `gpt-5.6-luna`      | `max`                 | bypass approvals    |
| cursor  | `cursor-agent` | `cursor-grok-4.6-medium` | `medium`          | `--yolo`            |
| claude  | `claude`       | `claude-opus-5`     | `high`                | `bypassPermissions` |
| grok    | `grok`         | `grok-4.6`          | `medium`              | `always-approve`    |

Commander default model: `claude-fable-5-1[1m]` at high effort. `gpt-5.6-sol` at xhigh is the alternative Commander choice. Integration branch template: `integrate/${task}`, base: `main`.

Override a worker's model per-spawn with `--model` and its effort with `--effort`.

### Default model-selection policy

Classify each unit before dispatching it. These are selection defaults, not a requirement to use every listed provider:

| Unit | Default worker choices |
|---|---|
| Routine | Cursor Grok 4.6 at `medium`; Grok CLI Grok 4.6 at `medium`; Devin SWE-1.7; GLM 5.2; Codex GPT-5.6 Luna at `xhigh` as the lowest-priority choice |
| Wide-impact, important, or difficult | Cursor Grok 4.6 at `xhigh`; Grok CLI Grok 4.6 at `xhigh`; Codex GPT-5.6 Luna at `max` |
| Irreversible if wrong | Codex GPT-6 Astra at `xhigh`; Claude Fable 5.1 at `xhigh` |

The irreversible tier is only for units whose failure cannot be recovered normally, such as frozen formats, ABI schemas, generated-contract changes, core soundness, or public ABI changes. Ordinary difficult work stays in the middle tier.

Also use this tier for new general-purpose modules, libraries the rest of the codebase will reuse widely, codebase architecture design, and architecture ADRs (writing or review). Split design from implementation with this rule:

- If a settled design determines the implementation mechanically, this tier does design and review only. Dispatch implementation to a lower tier.
- If the performance of the code itself matters (inner loops, allocations, hot-path algorithms), keep implementation on this tier. Do not choose this tier just because the work sits in a given architectural layer.

When multiple versions of the same named model are available, use the numerically newest version by default. The model name is a strict boundary: choose Opus 5 over Opus 4.8, but do not replace GPT-5.6 Luna with GPT-5.6 Sol or GPT-6 Astra, or Claude Opus 5 with Claude Fable 5.1.

Cursor workers may use only Grok, Composer, or Fable model families. Do not select any other model family for Cursor, even if `cursor-agent --list-models` lists it.

Use Claude Opus primarily as a reviewer, not as an implementation worker. It may implement only when Claude is the only usable worker provider.

Cursor Grok 4.6 and Grok CLI Grok 4.6 are separate providers with independent parallel capacity, so both may be dispatched in the same tier. Both use `medium` in the routine tier and `xhigh` in the middle tier. Cursor Grok and Grok CLI have no orchestrator-wide parallel limit. Devin and GLM 5.2 share a limit of five concurrent implementation workers across projects; reviewer use is not part of that limit.

Use either Claude Fable 5.1 1M at `high` or GPT-5.6 Sol at `xhigh` for the Commander; Fable/high is the config default and Sol/xhigh is its alternative. The `commander` config entry is advisory because orchestrator does not launch or replace the invoking session, so select one of these models when starting the session when the host supports it. The three tiers above apply to dispatched workers, not to the Commander.

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
orchestrator spawn codex  --model gpt-6-astra --effort xhigh -- "implement an irreversible ABI or schema change"
orchestrator spawn claude --model claude-fable-5-1[1m] --effort xhigh -- "write an ADR for a new shared cache module; design the public API; DO NOT implement"
orchestrator spawn claude --model claude-fable-5-1[1m] --effort xhigh -- "review the ADR for the shared cache module; report findings only, do not implement"
orchestrator spawn codex  --model gpt-6-astra --effort xhigh -- "implement the hot-path lookup in the shared cache; the performance of this code matters"
orchestrator spawn cursor --model cursor-grok-4.6-medium --effort medium -- "build OrdersForm in src/ui/OrdersForm.tsx"
orchestrator spawn cursor --model cursor-grok-4.6-medium --effort xhigh -- "implement a difficult architecture change"
orchestrator spawn claude --model claude-opus-5 --effort high -- "review a difficult architecture change; report findings only, do not edit files"
orchestrator spawn grok   --model grok-4.6 --effort medium -- "review the integration tests and fix failures"
orchestrator spawn grok   --model grok-4.6 --effort xhigh -- "implement a difficult architecture change"

orchestrator ls
orchestrator wait <id> --timeout 120      # short wait in reconcile loop (prefer over barrier)
orchestrator wait <id> --timeout 1800     # longer OK only with per-id background notify
orchestrator pending                      # workers awaiting a response (interactive mode)
orchestrator respond <id> "y"             # answer a permission/question prompt

orchestrator review <id>                  # as soon as THIS worker finishes
orchestrator diff   <id>                  # full diff vs base
orchestrator revise <id> -- "fix X in src/foo.ts: handle empty list"  # resume + feedback
orchestrator resume <id>                              # continue after rate limit / transient failure
orchestrator resume <id> -- "wait 2m then continue"   # optional custom continuation message
orchestrator resumable                                # list workers that can be resumed
orchestrator handoff <id>                             # print cross-agent handoff briefing
orchestrator handoff-spawn cursor --from <id> -- "notes"  # new worker, same worktree
orchestrator merge  <id>                  # merge as soon as THIS worker passes review
orchestrator archive <id>                 # REQUIRED after merge or unreusable failure (removes worktree)
orchestrator integrate                    # merge all completed workers (optional batch)
orchestrator finish  --base main          # push integration branch + open PR
orchestrator archive --older-than 1d      # safety net for leftovers (not a substitute for per-worker archive)
orchestrator archive --older-than 1d --dry-run  # preview without changing anything
```

Commander monitoring (see `skill/SKILL.md` Phase 2): **spawn is not done**. After every dispatch you must arm `wait` (dispatch-only is the main notification miss). Keep a roster; on barrier hosts use one short `wait` + `ls` loop; never put multiple long waits in one tool block and only review after all return. Act on the first completion while others still run. **Always `archive` after successful merge**, and archive failed workers that are not reusable. Do not leave spent worktrees.

### Review → revise cycle

Workers are resumable. Each worker's CLI session ID is captured automatically at spawn and stored in state. `orchestrator revise <id> -- "<feedback>"` resumes the worker on the same session in the same worktree, applies your feedback, and re-commits. Repeat `review → revise → wait` for **that** worker until acceptance criteria pass, then `merge` it without waiting for every parallel peer to finish.

If a worker stops early (rate limit, transient network error, etc.), `orchestrator resume <id>` continues on the same CLI session without review feedback. Failures matching known rate-limit/transient patterns are marked `failed-resumable`. Use `orchestrator resumable` to list resumable workers.

### Cross-agent handoff (best-effort)

When `resume` is impossible (no `sessionId`) or you want a **different** worker CLI to continue, use handoff. It packages the original task, worker log tail, branch diff, uncommitted worktree state, and prior status into a briefing, then spawns a new worker on the **same worktree**:

```bash
orchestrator handoff <source-id>                      # preview briefing
orchestrator handoff-spawn codex --from <source-id>   # spawn receiver
```

See skill `orchestrator-handoff` for the full workflow. Session memory does not transfer; only git state and reconstructed context are passed to the new worker.

### Permission bridge (hybrid)

- **Default (auto-approve):** workers run in `-p`/print mode with auto-approve flags. No prompts, no hang risk. Use for fire-and-forget implementation.
- **Interactive (respond-able):** `--interactive` at spawn runs the worker in a PTY; the supervisor detects permission/question prompts and flips the worker to `awaiting-permission` / `awaiting-question`. Answer via `orchestrator respond <id> <answer>`. Use only when you want to gate a worker's actions. PTY prompt detection is best-effort.

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
- Workers are one worktree each, branched off the configured base. The commander's working tree is never disturbed because merges happen in a temporary integration worktree.
- No daemon. Each `spawn` / `revise` launches a detached `worker.js` process that owns one CLI subprocess and exits when the CLI exits.
