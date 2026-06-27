// git.js — worktree + integration branch merge helpers
import { execSync } from "node:child_process";

function git(args, cwd) {
  const out = execSync(`git ${args}`, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim();
}

export function currentBranch(cwd) {
  return git("rev-parse --abbrev-ref HEAD", cwd);
}

export function repoRoot(cwd) {
  return git("rev-parse --show-toplevel", cwd);
}

export function createWorktree(repo, slug, baseBranch) {
  const branch = `worker/${slug}`;
  // worktree path under repo's parent to avoid nesting in repo
  const wtPath = `${repo}/.worktrees/${slug}`;
  git(`worktree add -b ${branch} "${wtPath}" ${baseBranch}`, repo);
  return { branch, path: wtPath };
}

export function removeWorktree(repo, slug) {
  try {
    git(`worktree remove --force "${repo}/.worktrees/${slug}"`, repo);
  } catch {}
  try {
    git(`branch -D worker/${slug}`, repo);
  } catch {}
}

export function ensureIntegrationBranch(repo, branchName, baseBranch) {
  try {
    git(`rev-parse --verify ${branchName}`, repo);
  } catch {
    git(`branch ${branchName} ${baseBranch}`, repo);
  }
}

export function mergeWorkerIntoIntegration(repo, workerBranch, integrationBranch, baseBranch) {
  // seed the integration branch from the workers' base branch, not whatever
  // branch the user's checkout happens to be on
  ensureIntegrationBranch(repo, integrationBranch, baseBranch || git(`rev-parse --abbrev-ref HEAD`, repo));
  // checkout integration branch in a temp worktree to avoid disturbing caller's WD
  const tmp = `${repo}/.worktrees/_int_${Date.now()}`;
  git(`worktree add "${tmp}" ${integrationBranch}`, repo);
  try {
    const out = git(`merge --no-ff ${workerBranch} -m "merge ${workerBranch} into ${integrationBranch}"`, tmp);
    return { ok: true, output: out };
  } catch (e) {
    // conflict — abort and report
    try { git("merge --abort", tmp); } catch {}
    return { ok: false, error: e.stdout?.toString() || e.message };
  } finally {
    try { git(`worktree remove --force "${tmp}"`, repo); } catch {}
  }
}

export function diffStat(repo, branch, base) {
  try {
    return git(`diff --stat ${base}...${branch}`, repo);
  } catch (e) {
    return e.message;
  }
}

export function diffFull(repo, branch, base) {
  try {
    return git(`diff ${base}...${branch}`, repo);
  } catch (e) {
    return e.message;
  }
}

export function worktreeStatus(wtPath) {
  try {
    return git("status --short", wtPath);
  } catch (e) {
    return e.message || String(e);
  }
}

export function worktreeDiff(wtPath) {
  try {
    return git("diff HEAD", wtPath);
  } catch (e) {
    return "";
  }
}

export function commitLogSinceBase(wtPath, limit = 20) {
  try {
    return git(`log --oneline -${limit}`, wtPath);
  } catch (e) {
    return "";
  }
}

export function pushAndPR(repo, branch, base, title) {
  try {
    git(`push -u origin ${branch}`, repo);
  } catch (e) {
    return { ok: false, error: `push failed: ${e.message}` };
  }
  try {
    const body = `Integrated by orchestrator. Base: ${base}`;
    const out = execSync(
      `gh pr create --base ${base} --head ${branch} --title "${title}" --body "${body.replace(/"/g, '\\"')}"`,
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
    return { ok: true, url: out };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
