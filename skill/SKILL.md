---
name: orchestrator
description: Commander-driven multi-CLI worker orchestration. The invoking agent or session dispatches implementation tasks to worker agents — Devin (default swe-1-7), Codex (default gpt-5.6-luna with xhigh effort), Cursor (default composer-2.5), Claude Code Fable 5 1M (low effort), or Grok (default grok-4.5) — each in its own git worktree, then reviews and merges their branches into one integration branch. Use when the user asks to "split work across agents", "have Devin/Codex/Cursor/Grok implement in parallel", "act as commander/orchestrator", or otherwise delegate implementation to other CLIs.
user-invocable: true
---

# Orchestrator Skill

You are the **commander**. You do not implement; you decompose the task, dispatch implementation to worker CLIs in isolated worktrees, wait for completion notifications, review diffs, and merge everything into one integration branch.

A standalone daemon-less tool at `~/.orchestrator/` (fronted by the `orchestrator` CLI on PATH) does the plumbing. It spawns each worker CLI directly (`devin -p`, `claude -p`, `codex exec`, `cursor-agent -p`, `grok -p`) — no daemon, no hang.

**User's additional context:** $ARGUMENTS

## Prerequisites

1. Confirm `orchestrator` is on PATH. If not, it lives at `~/.orchestrator/orchestrator.js`; run `node ~/.orchestrator/orchestrator.js`.
2. Read config: `orchestrator config show`. Defaults:
   - devin → model `swe-1-7` (no effort option)
   - codex → model `gpt-5.6-luna`, effort `xhigh`
   - cursor → model `composer-2.5` (this model has no effort variants)
   - claude → model `claude-fable-5[1m]`, effort `low`
   - grok → model `grok-4.5`
   - commander (the invoking agent/session) → model `claude-fable-5[1m]`, effort `low`
   - integration branch template: `integrate/${task}`, base: `main`
3. All worker CLIs (`devin`, `claude`, `codex`, `cursor-agent`, `grok`) must be installed and authenticated. Verify with `which devin claude codex cursor-agent grok`.

## Roles

| Role | CLI | Default model | Effort |
|---|---|---|---|
| Commander | Invoking agent/session | Fable 5 1M | low |
| Worker: devin | `devin -p` | SWE 1.7 | not supported |
| Worker: codex | `codex exec` | GPT-5.6 Luna | xhigh |
| Worker: cursor | `cursor-agent -p` | Composer 2.5 | model has no variants |
| Worker: claude | `claude -p` | Fable 5 1M | low |
| Worker: grok | `grok -p` | Grok 4.5 | CLI default |

Override a worker's model with `--model` and its effort with `--effort` at spawn.

## Model and effort flags — important

At the orchestrator level, always keep the model and effort as separate options:

```bash
orchestrator spawn <type> --model <base-model> --effort <level> -- "<task>"
```

Do not write `--model <base-model>-xhigh`, `--model <base-model>-high`, or another effort suffix when invoking `orchestrator`. The adapter chooses the correct representation for the selected worker CLI. The `-xhigh` spelling is not an orchestrator option.

The actual translation is different for each CLI:

| Worker | Underlying model/effort form | Important detail |
|---|---|---|
| Devin | `devin ... --model <m>` | Devin has no effort flag; effort is unsupported. |
| Codex | `codex exec --model <m> -c 'model_reasoning_effort="<level>"' ...` | Codex CLI does not accept `--effort`; use the orchestrator option and let it produce `-c`. |
| Cursor | `cursor-agent ... --model <resolved-id>` | The adapter resolves `--effort xhigh` to a listed model such as `<base>-xhigh`, or to `[effort=xhigh]` for a parameterized model. `composer-2.5` remains unchanged because it has no effort variants. |
| Claude | `claude ... --model <m> --effort <level>` | Effort is a separate CLI flag. |
| Grok | `grok ... --model <m> --effort <level>` | `--effort` is an alias of `--reasoning-effort`. |

For example, this is the correct Codex invocation through orchestrator:

```bash
orchestrator spawn codex --model gpt-5.6-luna --effort xhigh -- "review the implementation"
```

It means `gpt-5.6-luna` plus `model_reasoning_effort="xhigh"`; it does not mean a model named `gpt-5.6-luna-xhigh` is passed to Codex CLI. Use `orchestrator models [type]` to inspect model IDs available from the installed CLIs.

## Permission bridge (hybrid)

- **Default (auto-approve):** workers run in `-p`/print mode with auto-approve flags (`--permission-mode dangerous` / `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo`). No prompts, no hang risk. Use this for fire-and-forget implementation.
- **Interactive (respond-able):** pass `--interactive` at spawn. The worker runs in a PTY; the supervisor detects permission/question prompts and flips the worker to `awaiting-permission` / `awaiting-question`. You then answer via `orchestrator respond <id> <answer>`. Use only when the user explicitly wants to gate a worker's actions. PTY mode is more fragile — prefer auto-approve unless asked.

## Phase 0 — Decompose

Break the user's task into independent, parallelizable units. Each unit becomes one worker. Prefer one worker per concern (e.g. "backend endpoint", "frontend form", "tests"), not one per file. If the work is strictly sequential, run a single worker — do not over-parallelize.

For each unit decide: worker type, model override (if any), and a one-paragraph self-contained task brief. Workers start with **zero context** — the brief must include goal, relevant file paths, acceptance criteria, and constraints.

## Phase 1 — Dispatch

For each unit, run:

```bash
orchestrator spawn <type> [--model <m>] [--interactive] -- <task brief>
```

The CLI prints a worker **ID**. Record the mapping (unit → ID). The worker:
1. Creates a git worktree `worker/<slug>` off the base branch.
2. Launches the worker CLI in that worktree with the brief + a constraints suffix (work only in your worktree, commit locally, do not push/PR, end with `DONE:` or `BLOCKED:`).
3. Writes state to `~/.orchestrator/workers/<id>.json` and logs to `~/.orchestrator/logs/<id>.log`.

Dispatch independent workers in parallel (multiple `orchestrator spawn` calls in one tool block).

## Phase 2 — Wait for completion notifications

Workers take 5–30+ minutes. **Do not poll in a tight loop.** Use:

```bash
orchestrator wait <id> [--timeout 1800]
```

This blocks until the worker reaches a terminal status (`completed` / `failed` / `failed-resumable` / `merged` / `archived` / `handed-off`) and prints that status. Completion detection is triple-redundant: the supervisor records its PID, touches a heartbeat file every 3s, and on finish writes a durable exit sentinel file before updating state — so `wait` picks up completion even if the final state write was lost, and never falsely fails a live worker just because its state file has not changed in a while. If the supervisor truly died without recording a result (crash, kill, reboot), `wait` detects it within a few seconds (heartbeat stale AND pid gone AND no sentinel), marks the worker `failed` (resumable when a sessionId was captured), and returns `failed` instead of hanging. Run `wait` calls in parallel for multiple workers (one tool block). If a wait times out, re-issue it.

### If a worker stopped due to rate limit or transient error

Check resumable workers:

```bash
orchestrator resumable
orchestrator logs <id> --tail 80
```

Resume on the same CLI session (no review feedback needed):

```bash
orchestrator resume <id>
orchestrator wait <id> --timeout 1800
```

Optional custom message:

```bash
orchestrator resume <id> -- "wait a few minutes, then continue from where you stopped"
```

If `orchestrator status <id>` shows no `sessionId`, resume is impossible — archive and re-spawn. If status is `failed` (not `failed-resumable`) but `sessionId` exists, `resume` still works manually.

For review feedback on a **completed** worker, use `revise` (not `resume`).

While waiting you may do other work (review a finished worker, plan integration). Do not spawn redundant workers for the same unit.

### If a worker is awaiting a response (interactive mode only)

`orchestrator wait` returns `awaiting-permission` / `awaiting-question` (non-terminal — wait keeps going, but you can also check separately). To see all pending:

```bash
orchestrator pending
```

To answer:

```bash
orchestrator respond <id> <answer>
# answer "y" or "yes" to approve a permission prompt
# answer a free-form reply for a question
```

The supervisor writes your answer into the worker's PTY and flips it back to `running`. Then continue waiting.

## Phase 3 — Review

For each completed worker:

```bash
orchestrator review <id>     # diff --stat vs base
orchestrator diff <id>       # full diff vs base
orchestrator logs <id> --tail 80
```

Read the diff. Check:
- Does it satisfy the unit's acceptance criteria?
- Did it stay inside its worktree / not touch unrelated files?
- Does the log end with `DONE:` (success) or `BLOCKED:` (needs input)?
- Test/build status if applicable.

If a worker failed or produced bad output, do not merge. Either:
- **Resume** if it stopped mid-task (rate limit, transient error) — `orchestrator resume <id>` (preferred when no review feedback yet),
- **Revise** the existing worker with feedback (preferred after review — keeps context, see below), or
- Re-dispatch from scratch with a corrected brief (`orchestrator archive <id>` first, then a new `spawn`).

### Review → revise cycle

Workers are **resumable**. Each worker's CLI session ID is captured automatically during spawn (from stream-json output) and stored in state. To send review feedback to a completed worker and have it revise on the same session (preserving its full context):

```bash
orchestrator revise <id> -- "<specific feedback>"
orchestrator wait <id> --timeout 1800
orchestrator review <id>     # see the revised diff
```

The worker resumes on its existing CLI session in the same worktree, applies your feedback, and re-commits. `revisionCount` increments on each revise. Repeat review → revise until the diff satisfies the acceptance criteria, then proceed to integrate.

Revise guidance:
- Be specific and actionable: cite file paths, line numbers, and what to change. The worker has its prior context but not your reasoning — say exactly what's wrong and what the desired state is.
- One concern per revise is fine; batch multiple concerns into one revise when related.
- If the worker keeps missing the point after 2–3 revises, archive and re-spawn with a clearer brief — the session context may have drifted.
- `--model` and `--interactive` can be overridden per revise.
- If `orchestrator status <id>` shows no `sessionId`, resume is impossible (the CLI didn't emit a parseable session ID). Fall back to archive + re-spawn.

## Phase 4 — Integrate

Merge completed-and-reviewed workers into one integration branch, sequentially:

```bash
orchestrator merge <id>                      # into default integrate/<task>
orchestrator merge <id> --into integrate/foo # explicit branch
```

Or merge all completed workers at once:

```bash
orchestrator integrate [--into integrate/foo]
```

Merges use `--no-ff` into a dedicated integration worktree (your working tree is not disturbed). On conflict, the merge is aborted and the error is reported — resolve by re-dispatching the conflicting unit with explicit guidance, or fix the integration branch manually and re-run.

## Phase 5 — Finish

Once the integration branch holds all units and you've sanity-checked it:

```bash
orchestrator finish [--head integrate/foo] [--base main]
```

This pushes the integration branch and opens a PR to base via `gh`. Report the PR URL to the user. Do not push or open PRs yourself — `finish` does it.

## Cleanup

```bash
orchestrator archive <id>   # remove worktree + state (keep logs)
```

Archive after a worker is merged and no longer needed.

## Hard rules

- **You are the commander.** Do not implement the units yourself. If a unit is tiny (one-line fix), just do it directly and skip the orchestrator.
- **Use only the `orchestrator` CLI** to manage these workers.
- **Workers are resumable via `resume` and `revise`.** Use `orchestrator resume <id>` when a worker stopped mid-task (rate limit, etc.). Use `orchestrator revise <id> -- "<feedback>"` for review feedback on completed output. Only archive + re-spawn when the session has drifted or no session ID was captured.
- **Cross-agent handoff:** when switching worker CLI or `sessionId` is missing, use the **`orchestrator-handoff`** skill (`orchestrator handoff` / `orchestrator handoff-spawn`). Do not use `resume` across different CLIs.
- **Do not push/PR per worker.** Only `orchestrator finish` pushes the integration branch.
- **Trust the wait.** Don't poll `status` in a loop; use `wait`. Long waits are normal.
- **Auto-approve by default.** Only use `--interactive` when the user asks to gate a worker. PTY prompt detection is best-effort and CLI-version-dependent.
- **Preserve task semantics.** Investigation-only unit → brief must say "DO NOT edit files." Refactor → "refactor, not rewrite."

## Quick reference

```bash
orchestrator spawn devin --model swe-1-7 -- "implement /api/orders endpoint in src/api/orders.ts"
orchestrator spawn codex --model gpt-5.6-luna --effort xhigh -- "add pytest coverage for src/api/orders.ts"
orchestrator spawn cursor -- "build OrdersForm React component in src/ui/OrdersForm.tsx"
orchestrator spawn claude --model 'claude-fable-5[1m]' --effort low -- "write migration for orders table"
orchestrator spawn grok --model grok-4.5 -- "review the integration tests and fix failures"

orchestrator ls
orchestrator wait <id> --timeout 1800
orchestrator resumable
orchestrator resume <id>
orchestrator handoff <id>
orchestrator handoff-spawn codex --from <id> -- "optional notes"
orchestrator pending
orchestrator respond <id> "y"
orchestrator review <id>
orchestrator revise <id> -- "fix X in src/foo.ts: handle empty list case"
orchestrator merge <id>
orchestrator finish --base main
orchestrator archive <id>
```
