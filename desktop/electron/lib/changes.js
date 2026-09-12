import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PATCH_CHARS = 1_500_000;
const MAX_UNTRACKED_BYTES = 512 * 1024;

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `git exited with ${result.status}`).trim();
    throw new Error(detail);
  }
  return result.stdout || "";
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function resolveCommit(ref, cwd) {
  if (!ref || typeof ref !== "string") return null;
  return runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd).trim();
}

function prepareContext(worker) {
  if (!worker) throw new Error("worker not found");

  const worktreePath = worker.worktree?.path;
  const repoPath = worker.repo;
  const cwdPath = worker.cwd;
  let cwd = null;
  let targetRef = null;
  let source = "working-tree";
  const warnings = [];

  if (worktreePath && isDirectory(worktreePath)) {
    cwd = worktreePath;
    if (worker.commitSha && ["completed", "merged", "handed-off"].includes(worker.status)) {
      try {
        targetRef = resolveCommit(worker.commitSha, cwd);
        source = "completed-commit";
      } catch {
        warnings.push("記録された完了コミットを参照できないため、現在のworktreeを表示しています。");
      }
    }
  } else if (repoPath && isDirectory(repoPath) && worker.worktree?.branch) {
    cwd = repoPath;
    targetRef = resolveCommit(worker.commitSha || worker.worktree.branch, cwd);
    source = "branch";
    warnings.push("worktreeが見つからないため、ブランチにコミット済みの変更だけを表示しています。");
  } else if (cwdPath && isDirectory(cwdPath)) {
    cwd = cwdPath;
    warnings.push("worktreeを使わないセッションのため、現在の作業ツリー全体の変更を表示しています。");
  } else if (repoPath && isDirectory(repoPath)) {
    cwd = repoPath;
    warnings.push("worktreeを使わないセッションのため、現在の作業ツリー全体の変更を表示しています。");
  } else {
    throw new Error("workerのworktreeまたはリポジトリが見つかりません");
  }

  const root = runGit(["rev-parse", "--show-toplevel"], cwd).trim();
  const headCommit = resolveCommit(targetRef || "HEAD", root);
  let baseline = headCommit;
  const baselineRef = worker.startCommit || worker.base;
  if (baselineRef) {
    try {
      const baseCommit = resolveCommit(baselineRef, root);
      baseline = runGit(["merge-base", baseCommit, headCommit], root).trim();
    } catch {
      warnings.push(`基準 '${baselineRef}' を参照できないため、HEADからの未コミット変更だけを表示しています。`);
    }
  }

  return {
    root,
    baseline,
    target: targetRef,
    source,
    warnings,
  };
}

function diffArgs(context, ...args) {
  const revisions = context.target
    ? [context.baseline, context.target]
    : [context.baseline];
  return ["diff", ...args, ...revisions, "--"];
}

function parseNameStatus(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const files = [];

  for (let i = 0; i < tokens.length;) {
    let statusToken = tokens[i++];
    let firstPath = null;
    const tab = statusToken.indexOf("\t");
    if (tab >= 0) {
      firstPath = statusToken.slice(tab + 1);
      statusToken = statusToken.slice(0, tab);
    }
    const status = statusToken.charAt(0) || "M";
    firstPath ??= tokens[i++] || "";

    if (status === "R" || status === "C") {
      const secondPath = tokens[i++] || "";
      files.push({
        path: secondPath,
        oldPath: firstPath,
        status,
        score: Number.parseInt(statusToken.slice(1), 10) || null,
      });
    } else {
      files.push({ path: firstPath, oldPath: null, status, score: null });
    }
  }
  return files.filter((file) => file.path);
}

function parseWorkingStatus(output) {
  const tokens = output.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const byPath = new Map();

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i++] || "";
    if (token.length < 3) continue;
    const indexStatus = token[0];
    const worktreeStatus = token[1];
    const currentPath = token.slice(3);
    const renamed = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    const oldPath = renamed ? tokens[i++] || null : null;
    const value = {
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " && worktreeStatus !== "?",
      untracked: indexStatus === "?" && worktreeStatus === "?",
    };
    byPath.set(currentPath, value);
    if (oldPath) byPath.set(oldPath, value);
  }
  return byPath;
}

function collectChangesInternal(worker) {
  const context = prepareContext(worker);
  const nameStatus = runGit(diffArgs(context, "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-color"), context.root);
  const files = parseNameStatus(nameStatus);
  let working = new Map();

  if (!context.target) {
    working = parseWorkingStatus(
      runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], context.root)
    );
    const untracked = runGit(["ls-files", "--others", "--exclude-standard", "-z"], context.root)
      .split("\0")
      .filter(Boolean);
    const known = new Set(files.map((file) => file.path));
    for (const file of untracked) {
      if (!known.has(file)) files.push({ path: file, oldPath: null, status: "?", score: null });
    }
  }

  for (const file of files) {
    const work = working.get(file.path) || (file.oldPath ? working.get(file.oldPath) : null);
    file.staged = !!work?.staged;
    file.unstaged = !!work?.unstaged;
    file.untracked = file.status === "?" || !!work?.untracked;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const trackedCount = files.filter((file) => !file.untracked).length;
  const untrackedCount = files.length - trackedCount;
  let shortStat = runGit(diffArgs(context, "--shortstat", "--no-ext-diff", "--no-color"), context.root).trim();
  if (untrackedCount) {
    shortStat = [shortStat, `${untrackedCount} untracked`].filter(Boolean).join(" · ");
  }

  return {
    ok: true,
    root: context.root,
    baseline: context.baseline,
    target: context.target,
    source: context.source,
    warnings: context.warnings,
    files,
    fileCount: files.length,
    trackedCount,
    untrackedCount,
    shortStat,
    refreshedAt: new Date().toISOString(),
    _context: context,
  };
}

export function collectWorkerChanges(worker) {
  try {
    const result = collectChangesInternal(worker);
    delete result._context;
    return result;
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      files: [],
      fileCount: 0,
      refreshedAt: new Date().toISOString(),
    };
  }
}

function safeFilePath(root, relativePath) {
  const fullPath = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, fullPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("invalid file path");
  }
  return fullPath;
}

function untrackedPatch(root, relativePath) {
  const fullPath = safeFilePath(root, relativePath);
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(fullPath);
    return {
      patch: [
        `diff --git a/${relativePath} b/${relativePath}`,
        "new file mode 120000",
        "--- /dev/null",
        `+++ b/${relativePath}`,
        "@@ -0,0 +1 @@",
        `+${target}`,
      ].join("\n"),
      truncated: false,
    };
  }
  if (!stat.isFile()) throw new Error("selected path is not a file");

  const length = Math.min(stat.size, MAX_UNTRACKED_BYTES + 1);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(fullPath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (buffer.includes(0)) {
    return {
      patch: `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\nBinary file ${relativePath} is not shown.`,
      truncated: false,
    };
  }

  const truncated = stat.size > MAX_UNTRACKED_BYTES;
  let text = buffer.subarray(0, Math.min(buffer.length, MAX_UNTRACKED_BYTES)).toString("utf8");
  const endsWithNewline = text.endsWith("\n");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (endsWithNewline) lines.pop();
  const patch = [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
  if (!endsWithNewline && !truncated) patch.push("\\ No newline at end of file");
  if (truncated) patch.push("+... diff truncated ...");
  return { patch: patch.join("\n"), truncated };
}

function truncatePatch(patch) {
  if (patch.length <= MAX_PATCH_CHARS) return { patch, truncated: false };
  return {
    patch: `${patch.slice(0, MAX_PATCH_CHARS)}\n... diff truncated ...`,
    truncated: true,
  };
}

export function readWorkerFileDiff(worker, requestedPath) {
  try {
    if (!requestedPath || typeof requestedPath !== "string") throw new Error("file path is required");
    const result = collectChangesInternal(worker);
    const file = result.files.find((entry) => entry.path === requestedPath);
    if (!file) throw new Error("file is not part of this worker's changes");

    let rendered;
    if (file.untracked) {
      rendered = untrackedPatch(result.root, file.path);
    } else {
      const paths = [file.oldPath, file.path]
        .filter(Boolean)
        .map((filePath) => `:(literal)${filePath}`);
      const revisions = result.target
        ? [result.baseline, result.target]
        : [result.baseline];
      const patch = runGit([
        "diff",
        "--find-renames",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        ...revisions,
        "--",
        ...paths,
      ], result.root);
      rendered = truncatePatch(patch);
    }

    return {
      ok: true,
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      patch: rendered.patch,
      truncated: rendered.truncated,
      refreshedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      path: requestedPath || null,
      error: error.message || String(error),
      patch: "",
      refreshedAt: new Date().toISOString(),
    };
  }
}
