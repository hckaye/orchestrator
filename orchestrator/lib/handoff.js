// handoff.js — best-effort context bundle for cross-agent handoff
import fs from "node:fs";
import * as git from "./git.js";
import * as state from "./state.js";

const DEFAULT_LOG_TAIL = 150;
const DEFAULT_MAX_DIFF_LINES = 400;
// Briefings are passed to the worker CLI as a single argv element; keep them
// well under the OS exec limit (ARG_MAX ~1MB incl. environment).
const DEFAULT_MAX_BRIEFING_BYTES = 200 * 1024;

function truncateToBytes(text, maxBytes, note) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let cut = text.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return cut + note;
}

function tailLines(text, n) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

function truncateDiff(text, maxLines) {
  if (!text) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines);
  kept.push(`\n... (diff truncated — ${lines.length - maxLines} more lines omitted)`);
  return kept.join("\n");
}

function readWorkerLog(id, tail = DEFAULT_LOG_TAIL) {
  try {
    return tailLines(fs.readFileSync(state.workerLog(id), "utf8"), tail);
  } catch {
    return "(no worker log available)";
  }
}

function worktreeGitState(wtPath) {
  if (!wtPath) return null;
  try {
    return {
      branch: git.currentBranch(wtPath),
      status: git.worktreeStatus(wtPath),
      uncommittedDiff: git.worktreeDiff(wtPath),
      commitLog: git.commitLogSinceBase(wtPath, 20),
    };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

export function collectHandoffContext(source, opts = {}) {
  const logTail = opts.logTail ?? DEFAULT_LOG_TAIL;
  const maxDiffLines = opts.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;

  const wt = source.worktree;
  const wtGit = worktreeGitState(wt?.path);

  let branchDiffStat = "";
  let branchDiff = "";
  if (source.repo && wt?.branch && source.base) {
    branchDiffStat = git.diffStat(source.repo, wt.branch, source.base);
    branchDiff = truncateDiff(
      git.diffFull(source.repo, wt.branch, source.base),
      maxDiffLines
    );
  }

  return {
    sourceId: source.id,
    sourceType: source.type,
    sourceModel: source.model,
    sourceStatus: source.status,
    failureReason: source.failureReason || null,
    originalTask: source.task || source.prompt || "",
    sessionId: source.sessionId || null,
    revisionCount: source.revisionCount || 0,
    resumeCount: source.resumeCount || 0,
    repo: source.repo || null,
    base: source.base || null,
    worktree: wt || null,
    branchDiffStat,
    branchDiff,
    worktreeGit: wtGit,
    workerLogTail: readWorkerLog(source.id, logTail),
    resultTail: source.resultTail || null,
    feedback: source.feedback || null,
  };
}

export function formatHandoffBriefing(ctx, opts = {}) {
  const extra = opts.extra?.trim() || "";
  const lines = [];

  lines.push("## Handoff notice");
  lines.push(
    "You are continuing work started by another agent. Session memory was **not** transferred — treat this briefing as authoritative. Do not restart from scratch unless told to."
  );
  lines.push("");

  lines.push("## Original task");
  lines.push(ctx.originalTask || "(unknown)");
  lines.push("");

  if (extra) {
    lines.push("## Commander notes");
    lines.push(extra);
    lines.push("");
  }

  lines.push("## Prior agent");
  lines.push(`- Worker ID: \`${ctx.sourceId}\``);
  lines.push(`- CLI: \`${ctx.sourceType}\` (model: \`${ctx.sourceModel || "default"}\`)`);
  lines.push(`- Status: \`${ctx.sourceStatus}\`${ctx.failureReason ? ` (${ctx.failureReason})` : ""}`);
  if (ctx.revisionCount) lines.push(`- Revisions: ${ctx.revisionCount}`);
  if (ctx.resumeCount) lines.push(`- Resumes: ${ctx.resumeCount}`);
  if (ctx.feedback) {
    lines.push(`- Last review feedback: ${ctx.feedback}`);
  }
  lines.push("");

  lines.push("## Worktree");
  if (ctx.worktree) {
    lines.push(`- Path: \`${ctx.worktree.path}\``);
    lines.push(`- Branch: \`${ctx.worktree.branch}\``);
    lines.push(`- Base: \`${ctx.base}\``);
    lines.push("- Work **only** in this worktree. Do not push or open PRs.");
  } else {
    lines.push("(no worktree — run in the cwd given at spawn)");
  }
  lines.push("");

  if (ctx.worktreeGit && !ctx.worktreeGit.error) {
    lines.push("## Worktree git state");
    lines.push(`Branch: \`${ctx.worktreeGit.branch}\``);
    if (ctx.worktreeGit.commitLog) {
      lines.push("");
      lines.push("Commits on branch:");
      lines.push("```");
      lines.push(ctx.worktreeGit.commitLog);
      lines.push("```");
    }
    if (ctx.worktreeGit.status?.trim()) {
      lines.push("");
      lines.push("Status:");
      lines.push("```");
      lines.push(ctx.worktreeGit.status);
      lines.push("```");
    }
    if (ctx.worktreeGit.uncommittedDiff?.trim()) {
      lines.push("");
      lines.push("Uncommitted diff:");
      lines.push("```diff");
      lines.push(truncateDiff(ctx.worktreeGit.uncommittedDiff, opts.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES));
      lines.push("```");
    }
    lines.push("");
  }

  if (ctx.branchDiffStat?.trim()) {
    lines.push("## Branch diff vs base (committed)");
    lines.push("```");
    lines.push(ctx.branchDiffStat);
    lines.push("```");
    lines.push("");
  }

  if (ctx.branchDiff?.trim()) {
    lines.push("## Full branch diff vs base");
    lines.push("```diff");
    lines.push(ctx.branchDiff);
    lines.push("```");
    lines.push("");
  }

  if (ctx.resultTail?.trim()) {
    lines.push("## Last worker output");
    lines.push("```");
    lines.push(tailLines(ctx.resultTail, 80));
    lines.push("```");
    lines.push("");
  }

  lines.push("## Worker log (tail)");
  lines.push("```");
  lines.push(ctx.workerLogTail);
  lines.push("```");
  lines.push("");

  lines.push("## What to do next");
  lines.push(
    "1. Read the worktree and diffs above. 2. Continue the original task from current state — finish remaining work, fix failures, or address review feedback. 3. Commit locally on the branch. 4. End with `DONE: <summary>` or `BLOCKED: <reason>`."
  );

  return lines.join("\n");
}

export function buildHandoffBriefing(source, opts = {}) {
  const ctx = collectHandoffContext(source, opts);
  const briefing = formatHandoffBriefing(ctx, opts);
  return truncateToBytes(
    briefing,
    opts.maxBytes ?? DEFAULT_MAX_BRIEFING_BYTES,
    "\n\n... (briefing truncated to fit the OS command-line limit — inspect the worktree and `orchestrator logs` for full context)"
  );
}
