import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectWorkerChanges,
  readWorkerFileDiff,
} from "../desktop/electron/lib/changes.js";
import { formatStreamLog } from "../desktop/renderer/stream-format.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.join(repoRoot, "tmp");

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return (result.stdout || "").trim();
}

function fixtureRepo() {
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, "desktop-changes-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(root, "alpha.txt"), "before\n");
  fs.writeFileSync(path.join(root, "old.txt"), "rename me\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  git(root, ["switch", "-c", "feature/test-changes"]);
  return root;
}

test("desktop change reader lists tracked, renamed, and untracked worker files", () => {
  const root = fixtureRepo();
  try {
    fs.writeFileSync(path.join(root, "alpha.txt"), "after\n");
    fs.writeFileSync(path.join(root, "new file.txt"), "new content\n");
    git(root, ["mv", "old.txt", "renamed.txt"]);

    const worker = {
      id: "devin-test",
      status: "running",
      repo: root,
      base: "main",
      worktree: { path: root, branch: "feature/test-changes" },
    };
    const changes = collectWorkerChanges(worker);
    assert.equal(changes.ok, true, changes.error);
    assert.deepEqual(
      changes.files.map((file) => [file.path, file.status]),
      [
        ["alpha.txt", "M"],
        ["new file.txt", "?"],
        ["renamed.txt", "R"],
      ]
    );
    assert.equal(changes.files.find((file) => file.path === "alpha.txt").unstaged, true);
    assert.equal(changes.files.find((file) => file.path === "renamed.txt").staged, true);

    const trackedDiff = readWorkerFileDiff(worker, "alpha.txt");
    assert.equal(trackedDiff.ok, true, trackedDiff.error);
    assert.match(trackedDiff.patch, /-before/);
    assert.match(trackedDiff.patch, /\+after/);

    const untrackedDiff = readWorkerFileDiff(worker, "new file.txt");
    assert.equal(untrackedDiff.ok, true, untrackedDiff.error);
    assert.match(untrackedDiff.patch, /new file mode/);
    assert.match(untrackedDiff.patch, /\+new content/);

    const rejected = readWorkerFileDiff(worker, "../package.json");
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /not part of this worker's changes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completed worker changes stay pinned to its recorded commit", () => {
  const root = fixtureRepo();
  try {
    fs.writeFileSync(path.join(root, "alpha.txt"), "worker result\n");
    fs.writeFileSync(path.join(root, "created.txt"), "created\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-m", "worker result"]);
    const commitSha = git(root, ["rev-parse", "HEAD"]);

    // Simulate a later handoff sharing the same worktree.
    fs.writeFileSync(path.join(root, "alpha.txt"), "later handoff edit\n");

    const worker = {
      id: "devin-completed",
      status: "completed",
      commitSha,
      repo: root,
      base: "main",
      worktree: { path: root, branch: "feature/test-changes" },
    };
    const changes = collectWorkerChanges(worker);
    assert.equal(changes.ok, true, changes.error);
    assert.equal(changes.source, "completed-commit");
    assert.deepEqual(
      changes.files.map((file) => file.path),
      ["alpha.txt", "created.txt"]
    );

    const diff = readWorkerFileDiff(worker, "alpha.txt");
    assert.equal(diff.ok, true, diff.error);
    assert.match(diff.patch, /\+worker result/);
    assert.doesNotMatch(diff.patch, /later handoff edit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Devin terminal formatter preserves Read and Edited tool activity", () => {
  const input = [
    "\x1b[32m ● Read lines 1-60 in .\\server\\index.ts\x1b[0m\r",
    " └ 60 lines\r",
    " ● Edited .\\server\\index.ts\r",
    " │   10 -  import { decode } from './protocol';\r",
    " │   10 +  import { decode, DraftPhase } from './protocol';\r",
  ].join("\n");

  const html = formatStreamLog(input, { workerType: "devin", maxBlocks: 80 });
  assert.match(html, /sf-devin-action sf-devin-read/);
  assert.match(html, /sf-devin-action sf-devin-edit/);
  assert.match(html, /Read/);
  assert.match(html, /Edited/);
  assert.match(html, /server\\index\.ts/);
  assert.match(html, /sf-devin-output/);
  assert.doesNotMatch(html, /\x1b\[/);
});
