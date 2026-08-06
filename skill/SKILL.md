---
name: orchestrator
description: Commander-driven multi-CLI worker orchestration. The invoking agent or session classifies implementation units by risk, dispatches them to Devin, Codex, Cursor, Claude Code, or Grok workers in isolated git worktrees, pipelines each completion (review as soon as a worker finishes — never barrier-wait the whole cohort), then merges into one integration branch. Use when the user asks to "split work across agents", "have Devin/Codex/Cursor/Grok implement in parallel", "act as commander/orchestrator", or otherwise delegate implementation to other CLIs.
user-invocable: true
---

# Orchestrator Skill

You are the **commander**. You do not implement; you decompose the task, dispatch implementation to worker CLIs in isolated worktrees, **always arm `wait` after every spawn** (dispatch-only is a failure), **pipeline** completions (review each worker as soon as it finishes while others still run), and merge everything into one integration branch.

A standalone daemon-less tool at `~/.orchestrator/` (fronted by the `orchestrator` CLI on PATH) does the plumbing. It spawns each worker CLI directly (`devin -p`, `claude -p`, `codex exec`, `cursor-agent -p`, `grok -p`) — no daemon, no hang.

**User's additional context:** $ARGUMENTS

## Prerequisites

1. Confirm `orchestrator` is on PATH. If not, it lives at `~/.orchestrator/orchestrator.js`; run `node ~/.orchestrator/orchestrator.js`.
2. Read config: `orchestrator config show`. Defaults:
   - devin → model `swe-1-7` (no effort option)
   - codex → model `gpt-5.6-luna`, effort `max`
   - cursor → model `composer-2.5` (this model has no effort variants)
   - claude → model `claude-opus-5`, effort `high`
   - grok → model `grok-4.5`
   - commander (the invoking agent/session) → model `claude-fable-5[1m]`, effort `high`; alternatively `gpt-5.6-sol`, effort `xhigh`
   - integration branch template: `integrate/${task}`, base: `main`
3. All worker CLIs (`devin`, `claude`, `codex`, `cursor-agent`, `grok`) must be installed and authenticated. Verify with `which devin claude codex cursor-agent grok`.

## Roles

| Role | CLI | Default model | Effort |
|---|---|---|---|
| Commander | Invoking agent/session | Fable 5 1M / GPT-5.6 Sol | high / xhigh |
| Worker: devin | `devin -p` | SWE 1.7 | not supported |
| Worker: codex | `codex exec` | GPT-5.6 Luna | max |
| Worker: cursor | `cursor-agent -p` | Composer 2.5 | model has no variants |
| Worker: claude | `claude -p` | Opus 5.0 | high |
| Worker: grok | `grok -p` | Grok 4.5 | CLI default |

Override a worker's model with `--model` and its effort with `--effort` at spawn.

## Default model-selection policy

Before dispatch, classify each implementation unit and use a suitable available choice from its tier:

| Unit | Worker choices |
|---|---|
| Routine | Cursor Composer 2.5 Standard; Cursor Grok 4.5 high when some complexity is expected; Grok CLI Grok 4.5; Devin SWE-1.7; GLM 5.2 |
| Wide-impact, important, or difficult | Codex GPT-5.6 Luna at `max`; Claude Code Opus 5.0 at `high` |
| Irreversible if wrong | Codex GPT-5.6 Sol at `xhigh`; Claude Fable 5 at `high` |

Use the irreversible tier only when an incorrect result cannot be recovered normally: frozen formats, ABI schemas, generated-contract changes, core soundness, or public ABI changes. A unit that is merely difficult belongs in the middle tier.

Cursor Grok 4.5 high means Grok through `cursor-agent`; Grok CLI Grok 4.5 means the official `grok` CLI. They are separate providers with independent capacity and may run concurrently. Cursor Composer, Cursor Grok, and Grok CLI have no orchestrator-wide parallel limit. Devin and GLM 5.2 share a maximum of five concurrent implementation workers across projects; reviewer use is unlimited.

Use either Claude Fable 5 1M at `high` or GPT-5.6 Sol at `xhigh` for the Commander; Fable/high is the config default and Sol/xhigh is its alternative. The current process is the Commander and orchestrator cannot change its model after launch, so select one of these models when starting the invoking session when the host permits it. Do not apply worker tiers to the Commander.

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
orchestrator spawn codex --model gpt-5.6-luna --effort max -- "implement an important cross-cutting change"
```

It means `gpt-5.6-luna` plus `model_reasoning_effort="max"`; it does not mean a model named `gpt-5.6-luna-max` is passed to Codex CLI. Use `orchestrator models [type]` to inspect model IDs available from the installed CLIs.

## Permission bridge (hybrid)

- **Default (auto-approve):** workers run in `-p`/print mode with auto-approve flags (`--permission-mode dangerous` / `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` / `--yolo`). No permission prompts, no hang risk on the worker side. This is **worker** fire-and-forget (they do not block on you for tool approval) — the **commander must still `wait` and review**.
- **Interactive (respond-able):** pass `--interactive` at spawn. The worker runs in a PTY; the supervisor detects permission/question prompts and flips the worker to `awaiting-permission` / `awaiting-question`. You then answer via `orchestrator respond <id> <answer>`. Use only when the user explicitly wants to gate a worker's actions. PTY mode is more fragile — prefer auto-approve unless asked.

## Phase 0 — Decompose

Break the user's task into independent, parallelizable units. Each unit becomes one worker. Prefer one worker per concern (e.g. "backend endpoint", "frontend form", "tests"), not one per file. If the work is strictly sequential, run a single worker — do not over-parallelize. Classify every unit with the default model-selection policy above before choosing a worker.

For each unit decide: worker type, model override (if any), and a one-paragraph self-contained task brief. Workers start with **zero context** — the brief must include goal, relevant file paths, acceptance criteria, and constraints.

## Phase 1 — Dispatch

For each unit, run:

```bash
orchestrator spawn <type> [--model <m>] [--interactive] -- <task brief>
```

The CLI prints a worker **ID**. Add it to the roster immediately (unit → id → status `running` → reviewed/merged/archived `no`). The worker:
1. Creates a git worktree `worker/<slug>` off the base branch.
2. Launches the worker CLI in that worktree with the brief + a constraints suffix (work only in your worktree, commit locally, do not push/PR, end with `DONE:` or `BLOCKED:`).
3. Writes state to `~/.orchestrator/workers/<id>.json` and logs to `~/.orchestrator/logs/<id>.log`.

Dispatch independent workers in parallel (multiple `orchestrator spawn` calls in one tool block).

### Spawn is not done — monitoring is mandatory

**Dispatch alone is never a finished commander turn.** Recording worker ids and saying “workers are running” is not completion. After the last `spawn` for this batch returns:

1. Roster every printed id (unit → id → `running`).
2. **In the same turn sequence**, enter Phase 2: start Pattern A background waits **or** Pattern B’s first `ls` + short `wait`.
3. Stay in the monitor → review → revise/merge loop until every rostered unit is handled (or deliberately archived).

Forbidden: spawn → stop. Forbidden: spawn → report status to the user → end the skill without `wait`. The worker CLIs do not call you back; **only `orchestrator wait` (plus `ls` reconcile) brings completions into your turn**. If you never `wait`, you will never learn they finished.

“Fire-and-forget” in the permission-bridge section means **workers auto-approve tools without prompting you** — it does **not** mean the commander may abandon monitoring after spawn.

## Phase 2 — Monitor workers (pipeline, not barrier)

Workers take 5–30+ minutes. Your job is to **arm waits, notice each completion promptly, and act on it immediately**, while other workers keep running. Parallel dispatch only saves wall-clock time if commander work (review → revise → merge) **overlaps** with remaining workers. If you wait for the whole cohort before reviewing anyone, wall-clock time collapses to `max(worker times) + serial review of everything` and parallelism is wasted.

### Core rules

1. **Always wait after spawn.** Every running worker must be under Pattern A or B coverage. No exceptions for “I’ll check later,” “the desktop UI will show it,” or “the user will poke me.”
2. **First-done, first-handled.** As soon as **any** worker becomes terminal, review it (and revise/merge if ready) **before** waiting for the rest. Never batch “I’ll handle A, B, and C only after all three finish.”

### Required: keep an explicit roster

Right after spawn, write down a roster and keep it updated after every wake:

| unit | id | status | reviewed | merged | archived |
|---|---|---|---|---|---|
| backend API | `abc…` | running | no | no | no |
| frontend form | `def…` | running | no | no | no |

After every wait return, timeout, review, revise, resume, user message, or long tool sequence: run `orchestrator ls` and reconcile the roster. Before Phase 5 (`finish`), every unit for this task must be reviewed **and merged then archived**, or failed-and-unreusable then archived — never “lose” an id, and never leave a spent worktree on disk.

### How `wait` works

```bash
orchestrator wait <id> [--timeout 1800]
```

Blocks until **that one** worker reaches a terminal status (`completed` / `failed` / `failed-resumable` / `merged` / `archived` / `handed-off`) and prints that status. There is no multi-id or “wait any” CLI. Completion detection is triple-redundant (supervisor PID, heartbeat every 3s, durable exit sentinel before state write). If the supervisor died without a result, `wait` marks `failed` (resumable when `sessionId` exists) instead of hanging forever.

A printed `timeout` is **not** failure — it only means “this wait window ended; re-check and re-arm.”

### Choose a wait pattern that does not barrier-sync

#### Pattern A — Background / async waits (preferred when the host notifies per completion)

If your host can run shell tools in the **background** and deliver a **separate notification when each finishes** (not one barrier after all parallel tools):

1. Start **one background** `orchestrator wait <id> --timeout 1800` per running worker.
2. When wait for worker **X** returns → immediately review/revise/merge **X** only.
3. Leave other background waits running. Do **not** cancel them. Do **not** wait for them before acting on X.
4. After handling X, run `orchestrator ls` in case another worker finished during your review, then process those too.
5. If a wait returns `timeout` and the worker is still running, re-arm a background wait for that id.
6. Never treat “all background waits have returned” as the only moment you are allowed to review.

#### Pattern B — Short-timeout reconcile loop (required on barrier hosts)

Many agent hosts collect **all** parallel tool results before your next turn. On those hosts, putting several long `orchestrator wait` calls in one tool block **forces you to wait for the slowest worker**. That is a **forbidden barrier wait**.

Use this loop instead:

```text
until no workers for this task are still running:
  1. orchestrator ls                    # reconcile full roster
  2. handle every newly terminal worker (review → revise/resume/merge)
  3. orchestrator pending               # if any interactive workers
  4. if any still running:
       pick ONE still-running id
       orchestrator wait <that-id> --timeout 120
     # only one wait per turn; short timeout so you re-enter often
  5. on completion OR timeout → go to step 1
```

Rules for Pattern B:

- **One** foreground `wait` per turn (or a very short window), never N long waits in one parallel tool block.
- Prefer `--timeout 120` (up to `300`). Wake often; re-check everyone via `ls`.
- Rotate which running id you wait on if several are live, so one stuck wait target cannot starve detection of others finishing (also covered by step 1 `ls`).

### Timeout and re-arm policy (prevent missed completions)

| Event | Required commander action |
|---|---|
| Wait returns terminal status | Handle that worker now; `ls`; re-arm wait only for still-running others |
| Wait returns `timeout` | `ls` / roster update; re-issue wait for every still-running worker (or next loop iteration) |
| Finished a review/revise/merge | `archive` that worker if merge (or unreusable fail) is done; then `ls` — another may have finished |
| User message / long side task | Before idling again: `ls` + ensure every runner is still covered |
| About to `finish` | `ls` — no running / unreviewed / unmerged / unarchived spent workers for this task |

Hard constraints:

- **Spawn without wait = guaranteed miss.** Completions are not pushed into the commander session unless you call `wait` (or you actively `ls` in a loop that itself uses `wait` to sleep). Dispatch-only is the most common form of notification leak.
- **Never fire-and-forget the commander side.** No “spawned three workers, done for now.” No ending the turn after spawn with only a status summary. Arm waits before you idle.
- **Never fire-and-forget a single 30–60 minute wait** with no re-check plan either. Long silence without re-arm is how completions are missed *after* you did start waiting.
- **Never drop coverage:** after you handle one completion, remaining runners must still have an active wait (Pattern A) or an imminent loop iteration (Pattern B).
- Do **not** tight-poll `status` every few seconds (wastes tokens). Prefer `wait` with a short/moderate timeout, then `ls`.
- If you are unsure whether a notification was lost: `orchestrator ls` is cheap truth. Use it liberally after any wake.

### Anti-patterns (forbidden)

0. **Dispatch-and-done (no wait at all):** spawn one or more workers, print ids / tell the user they are running, and stop without entering Phase 2. This is the primary notification-miss failure mode — nothing ever wakes the commander.
1. **Barrier wait:** issue waits for all workers, then start review only after *every* wait has returned.
2. **Cohort-only review:** “A/B/C are running; I’ll review when all three are done.”
3. **Dropped coverage:** handle A, then plan or chat for a long stretch without re-waiting / `ls` for B and C.
4. **Mega-timeout, no reconcile:** one `wait --timeout 3600` and no roster check if the host drops the notification.
5. **Parallel long waits on a barrier host:** multiple `wait … --timeout 1800` in one tool block (wall-clock ≈ slowest worker).
6. **Orphan ids:** lose track of a worker id so it finishes unreviewed.
7. **“UI will notify me” / “user will come back”:** desktop app or human follow-up is not a substitute for commander `wait`. You own the loop.

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

While other workers are still running, you should be reviewing finishers — that is the intended overlap. Do not spawn redundant workers for the same unit.

### If a worker is awaiting a response (interactive mode only)

`awaiting-permission` / `awaiting-question` are non-terminal. In Pattern B, `ls` / `pending` surfaces them between short waits. To see all pending:

```bash
orchestrator pending
```

To answer:

```bash
orchestrator respond <id> <answer>
# answer "y" or "yes" to approve a permission prompt
# answer a free-form reply for a question
```

The supervisor writes your answer into the worker's PTY and flips it back to `running`. Then continue monitoring (re-arm wait / next loop iteration). Answer promptly — a blocked interactive worker should not sit behind a long barrier wait on unrelated workers.

## Phase 3 — Review

For each worker **as soon as it becomes terminal** (do not wait for the rest of the cohort):

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
- Re-dispatch from scratch with a corrected brief (**must** `orchestrator archive <id>` first — worktree gone — then a new `spawn`).

If the worker is failed **and** not reusable (`sessionId` missing, handoff already spawned a replacement, output discarded, or you will not `resume`/`revise` it further), **archive it immediately**. Do not leave dead worktrees around “just in case.”

### Review → revise cycle

Workers are **resumable**. Each worker's CLI session ID is captured automatically during spawn (from stream-json output) and stored in state. To send review feedback to a completed worker and have it revise on the same session (preserving its full context):

```bash
orchestrator revise <id> -- "<specific feedback>"
# then monitor THIS revise with Pattern A or B — do not barrier-wait other workers
orchestrator wait <id> --timeout 120
orchestrator review <id>     # see the revised diff
```

The worker resumes on its existing CLI session in the same worktree, applies your feedback, and re-commits. `revisionCount` increments on each revise. Repeat review → revise until the diff satisfies the acceptance criteria, then **merge → archive** that worker and return to monitoring any still-running peers.

Revise guidance:
- Be specific and actionable: cite file paths, line numbers, and what to change. The worker has its prior context but not your reasoning — say exactly what's wrong and what the desired state is.
- One concern per revise is fine; batch multiple concerns into one revise when related.
- If the same findings recur or revisions stop making progress, switch providers with `orchestrator-handoff` instead of revising indefinitely. For routine work, switch Devin/GLM 5.2 to Cursor Grok 4.5 high or Grok CLI Grok 4.5, and switch either Grok route to Devin/GLM 5.2. For difficult work, switch between Claude Opus 5.0 and Codex; only move to Sol/Fable when the unit meets the irreversible-tier definition. Include all prior review findings and diffs in the handoff brief, then restart the review cycle.
- `--model` and `--interactive` can be overridden per revise.
- If `orchestrator status <id>` shows no `sessionId`, resume is impossible (the CLI didn't emit a parseable session ID). Fall back to archive + re-spawn.

## Phase 4 — Integrate then archive

Merge each worker **as soon as it passes review**, even while other workers are still running. Do not hold merges until the full cohort is done unless a known dependency requires a specific merge order.

```bash
orchestrator merge <id>                      # into default integrate/<task>
orchestrator merge <id> --into integrate/foo # explicit branch
orchestrator archive <id>                    # REQUIRED immediately after successful merge
```

Or, only when several are already reviewed and you intentionally batch:

```bash
orchestrator integrate [--into integrate/foo]
# then archive every id that integrate just merged
orchestrator archive <id1>
orchestrator archive <id2>
```

Merges use `--no-ff` into a dedicated integration worktree (your working tree is not disturbed). On conflict, the merge is aborted and the error is reported — resolve by re-dispatching the conflicting unit with explicit guidance, or fix the integration branch manually and re-run. Do **not** archive until the merge (or intentional abandon) is done.

After each successful merge: **`archive` that id (removes the worktree)**, update the roster, then return to monitoring remaining runners (`ls` + re-arm waits).

## Phase 5 — Finish

Once the integration branch holds all units, spent workers for this task are archived, and you've sanity-checked the branch:

```bash
orchestrator finish [--head integrate/foo] [--base main]
```

This pushes the integration branch and opens a PR to base via `gh`. Report the PR URL to the user. Do not push or open PRs yourself — `finish` does it. Before `finish`, `orchestrator ls` must show no leftover unarchived workers that you already merged or abandoned for this task.

## Cleanup — mandatory archive policy

`orchestrator archive <id>` removes the worker **worktree** and state (logs are kept). It is **not** optional housekeeping for “someday.”

### Must archive (no exceptions)

| Situation | When to archive |
|---|---|
| Review cycle done and changes merged into the integration branch | **Immediately after** successful `merge` (or after `integrate` for each merged id) |
| Failed and **not reusable** | As soon as you decide not to `resume` / `revise` it further |
| No `sessionId` (resume impossible) and you will re-spawn or abandon | Before or instead of re-spawn; never leave the dead worktree |
| Handoff-spawn created a replacement on the same or new path and the source is done | Archive the source when you are not continuing it (`--archive-source` or explicit `archive`) |
| Output discarded / unit cancelled / wrong dispatch | Archive promptly |

**Not reusable** means at least one of: no `sessionId`; you already spawned a replacement; repeated revise/handoff failed and you are abandoning this worker; user cancelled the unit; the worktree is corrupted or you will not use it again.

### Must NOT archive yet

| Situation | Keep the worker |
|---|---|
| Still `running` / `pending` / `awaiting-*` | Keep — still active |
| `completed` but not yet reviewed, or still in review → revise | Keep — session + worktree still needed |
| `failed-resumable` (or failed with `sessionId`) and you will `resume` / `revise` | Keep until that path finishes or you abandon it |
| Merged failed (conflict) and you still need the worktree to fix/re-merge | Keep until resolved |

### Commands

```bash
orchestrator archive <id>                   # remove worktree + state (keep logs) — default path
orchestrator archive --older-than 1d --dry-run  # preview leftovers only
orchestrator archive --older-than 1d            # bulk-clean old finished workers you missed
```

`--older-than` is a safety net for stragglers, **not** a substitute for per-worker archive right after merge or abandon. Leaving merged worktrees until a bulk clean is a policy violation.

### Anti-patterns

- Merge and leave the worktree “for reference” — archive; the integration branch holds the code.
- Fail without resume path and keep the worktree “just in case” — archive; re-spawn if needed later.
- Finish the PR while unarchived spent workers still appear in `ls` for this task.

## Hard rules

- **You are the commander.** Do not implement the units yourself. If a unit is tiny (one-line fix), just do it directly and skip the orchestrator.
- **Use only the `orchestrator` CLI** to manage these workers.
- **Spawn is not completion.** After every `spawn` / `resume` / `revise` / `handoff-spawn`, you **must** enter (or continue) Phase 2 monitoring with `wait`. Dispatch-only, “workers launched,” or ending the turn without arming waits is a hard failure — workers never push completion into your session by themselves.
- **Pipeline, don't barrier.** Review/revise/merge each worker as soon as *it* finishes. Never wait for the entire parallel cohort before acting on early finishers.
- **Never drop wait coverage.** Every still-running worker must be covered by an active background wait (Pattern A) or the next short-timeout reconcile iteration (Pattern B). After handling one completion, re-arm / re-check the rest.
- **Re-arm after every wake.** `timeout` → `ls` → re-wait remaining. Terminal status → handle that worker → `ls` → re-wait remaining. A lost or skipped re-arm is a missed completion.
- **No multi-long-wait barrier blocks.** Do not put multiple long `orchestrator wait` calls in one parallel tool block on hosts that barrier-sync tool results. Use Pattern A (per-completion notify) or Pattern B (one short wait + `ls` loop).
- **Keep a roster; reconcile with `ls`.** Explicit unit → id → status → reviewed → merged → archived. Before `finish`, nothing for this task may still be running, unreviewed, unmerged-when-accepted, or unarchived after merge/abandon.
- **Always archive spent workers.** After review completes and the unit is merged into the integration branch, run `orchestrator archive <id>` immediately (deletes the worktree). Same for failed workers that are not reusable (no `sessionId`, abandoned, replaced by handoff/re-spawn, cancelled). Do not leave spent worktrees for later bulk clean.
- **Workers are resumable via `resume` and `revise`.** Use `orchestrator resume <id>` when a worker stopped mid-task (rate limit, etc.). Use `orchestrator revise <id> -- "<feedback>"` for review feedback on completed output. Only archive + re-spawn when the session has drifted, no session ID was captured, or you are abandoning this worker.
- **Cross-agent handoff:** when switching worker CLI or `sessionId` is missing, use the **`orchestrator-handoff`** skill (`orchestrator handoff` / `orchestrator handoff-spawn`). Do not use `resume` across different CLIs. Archive the source when it will not continue.
- **Do not push/PR per worker.** Only `orchestrator finish` pushes the integration branch.
- **Use `wait`, not tight status polls.** Prefer short/moderate `wait` timeouts plus `ls` reconcile over spinning on `status`. Long worker runs are normal; long commander silence without re-arm is not.
- **Auto-approve by default.** Only use `--interactive` when the user asks to gate a worker. PTY prompt detection is best-effort and CLI-version-dependent.
- **Preserve task semantics.** Investigation-only unit → brief must say "DO NOT edit files." Refactor → "refactor, not rewrite."
- **Follow the default model-selection policy.** Do not spend the irreversible tier on work that is only difficult, and honor its provider concurrency limits.

## Quick reference

```bash
orchestrator spawn devin --model swe-1-7 -- "implement /api/orders endpoint in src/api/orders.ts"
orchestrator spawn devin --model glm-5.2 -- "implement a routine isolated unit"
orchestrator spawn codex --model gpt-5.6-luna --effort max -- "implement an important cross-cutting change"
orchestrator spawn cursor -- "build OrdersForm React component in src/ui/OrdersForm.tsx"
orchestrator spawn cursor --model grok-4.5 --effort high -- "implement a somewhat complex routine unit"
orchestrator spawn claude --model claude-opus-5 --effort high -- "implement a difficult architecture change"
orchestrator spawn grok --model grok-4.5 -- "review the integration tests and fix failures"

orchestrator ls                              # reconcile roster often
orchestrator wait <id> --timeout 120         # short timeout in reconcile loop (Pattern B)
orchestrator wait <id> --timeout 1800        # longer OK only with per-id background notify (Pattern A)
orchestrator resumable
orchestrator resume <id>
orchestrator handoff <id>
orchestrator handoff-spawn codex --from <id> -- "optional notes"
orchestrator pending
orchestrator respond <id> "y"
orchestrator review <id>                     # as soon as THIS worker finishes
orchestrator revise <id> -- "fix X in src/foo.ts: handle empty list case"
orchestrator merge <id>                      # as soon as THIS worker passes review
orchestrator archive <id>                    # REQUIRED after merge or unreusable failure
orchestrator finish --base main
```

### Monitoring cheat sheet

```text
spawn all → write roster → IMMEDIATELY arm waits (same sequence; do not stop)
loop:
  ls → review any newly done (immediately)
  merge → archive (required) when accepted
  archive failed unreusable workers
  if runners remain → wait (one short foreground OR background per id)
  timeout or completion → re-arm / loop
never: spawn and stop without wait
never: wait for all runners before first review
never: leave merged or dead worktrees unarchived
```

