---
name: orchestrator-handoff
description: Best-effort handoff of in-progress work to a different coding agent CLI. Packages original task, worker logs, git/worktree state, and diffs into a briefing, then spawns a new worker on the same worktree. Use when resume is impossible (no sessionId), when switching worker type (Codex to Cursor, Grok, etc.), or when the user says handoff, transfer, or pass work to another agent.
user-invocable: true
---

# Orchestrator Handoff Skill

Transfer in-progress implementation to a **different** worker CLI when `resume` cannot (or should not) be used. This is **best-effort**: session memory does not transfer; the receiving agent gets a self-contained briefing plus the existing worktree.

**User's arguments:** $ARGUMENTS

## When to use

| Situation | Use |
|---|---|
| Same agent, same session, interrupted (rate limit) | `orchestrator resume <id>` |
| Same agent, review feedback on completed work | `orchestrator revise <id> -- "..."` |
| **Different agent CLI**, or no `sessionId`, or session drifted | **This skill** |

## Prerequisites

1. Confirm `orchestrator` is on PATH (`orchestrator --help`).
2. Identify the **source worker** (`orchestrator ls` / `orchestrator status <id>`).
3. Source worker must have a **worktree** (normal spawn path). Handoff reuses that worktree.

## Parsing arguments

1. **Target worker type** — `devin`, `codex`, `cursor`, `claude`, or `grok`. Explicit user request first; otherwise pick the best fit for the remaining work.
2. **Source worker** — `--from <id>` or the worker the user is referring to.
3. **Optional notes** — anything after `--` becomes commander notes in the briefing.

## Workflow

### Step 1 — Inspect source

```bash
orchestrator status <source-id>
orchestrator review <source-id>
orchestrator logs <source-id> --tail 80
```

Confirm: worktree path/branch, what's committed vs dirty, failure reason if any.

### Step 2 — Preview briefing (optional)

```bash
orchestrator handoff <source-id>
# or with commander notes:
orchestrator handoff <source-id> -- "focus on fixing the auth test; ignore UI polish"
```

The briefing includes:
- Original task / prompt
- Prior agent type, status, failure reason
- Worktree path, branch, base
- Committed branch diff vs base (+ truncated full diff)
- Uncommitted status and diff in the worktree
- Worker log tail
- Last worker output / review feedback if present

Use `--json` for machine-readable context. Tune size with `--log-tail N` and `--max-diff N`.

### Step 3 — Spawn receiving agent

```bash
orchestrator handoff-spawn <type> --from <source-id> [--model <m>] [--archive-source] -- "<optional notes>"
orchestrator wait <new-id> --timeout 1800
```

Examples:

```bash
# Codex failed mid-task → continue on Cursor, same worktree
orchestrator handoff-spawn cursor --from codex-20260701120000-ab12 -- "finish the remaining tests"

# Devin rate-limited with no sessionId → fresh Codex on same branch
orchestrator handoff-spawn codex --from devin-20260701120000-x7k2

# Claude failed mid-task → continue on Grok, same worktree
orchestrator handoff-spawn grok --from claude-20260701120000-c3d4 -- "finish the remaining tests"
```

Add `--archive-source` to mark the source worker as `handed-off` (keeps state file for audit; does not delete the worktree).

### Step 4 — Review as usual

```bash
orchestrator review <new-id>
orchestrator revise <new-id> -- "..."   # if sessionId captured on new worker
orchestrator merge <new-id>
```

## Handoff from your own session (no source worker)

When **you** (the commander) did work directly and want to delegate:

1. Ensure changes live in a git worktree (create one if needed).
2. Write a briefing manually using the template below — you are the source of truth for conversation context.
3. Spawn normally, pointing at the worktree:

```bash
orchestrator spawn codex --worktree my-task --cwd /path/to/repo -- "paste briefing here"
```

Or create a worker first, then `handoff-spawn` if you already have a worker id with the right worktree.

## Briefing template (manual / enrichment)

When writing or enriching a handoff, include:

```
## Task
[Imperative description of what remains.]

## Original instruction (summary)
[User's first request, condensed.]

## Context
[Why this exists, background the new agent needs.]

## Current state
[What's done, what works, what's broken.]

## Relevant files
- `path` — [role]

## What was tried
- [Approach] — [outcome]

## Decisions
- [Decision — rationale]

## Acceptance criteria
- [ ] [Criterion]

## Constraints
- [Must-not / must-preserve]
```

**Preserve task semantics.** Investigate-only → "DO NOT edit files." Fix → "implement the fix."

## Limitations (best-effort)

- **No session memory.** The new CLI cannot see the prior agent's conversation. Logs and diffs are a reconstruction, not a perfect replay.
- **Large diffs are truncated** (default 400 lines). Run `orchestrator diff <id>` yourself if the receiver needs more.
- **Concurrent workers on one worktree are unsafe.** Archive or wait for the source worker to stop before handoff-spawn.
- **Use only the `orchestrator` CLI.**

## Hard rules

- Prefer `resume` / `revise` when the **same** worker and `sessionId` are available.
- Do not merge the source and handoff worker branches separately — they share one branch; review the latest worker.
- Do not push/PR per worker; only `orchestrator finish` pushes the integration branch.

## Quick reference

```bash
orchestrator handoff <source-id>
orchestrator handoff <source-id> --log-tail 200 --max-diff 600
orchestrator handoff-spawn cursor --from <source-id> -- "finish auth tests"
orchestrator handoff-spawn codex --from <source-id> --archive-source
orchestrator wait <new-id> --timeout 1800
orchestrator review <new-id>
```
