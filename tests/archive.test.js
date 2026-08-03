import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findArchiveCandidates,
  isArchiveCandidate,
  parseAgeMs,
} from "../orchestrator/lib/archive.js";
import { formatStreamLog } from "../desktop/renderer/stream-format.js";
import { replaceDirectory } from "../desktop/scripts/install-utils.js";
import {
  buildSkillsInstallArgs,
  detectInstalledSkillAgents,
  resolveNpmInvocation,
} from "../install-utils.js";
import { pickWorkerRuntime } from "../orchestrator/lib/models.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, "orchestrator", "orchestrator.js");
const hour = 60 * 60 * 1000;

test("model-selection defaults expose the approved commander choices and worker tiers", () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "orchestrator", "config.example.json"),
    "utf8"
  ));

  assert.deepEqual(pickWorkerRuntime(config, "codex"), {
    model: "gpt-5.6-luna",
    effort: "max",
  });
  assert.deepEqual(pickWorkerRuntime(config, "claude"), {
    model: "claude-opus-5",
    effort: "high",
  });
  assert.deepEqual(config.commander, {
    defaultModel: "claude-fable-5[1m]",
    thinkingLevel: "high",
    alternatives: [{
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
    }],
  });
});

test("Windows installer runs npm entry points with node instead of spawning .cmd files", () => {
  const npmCli = String.raw`C:\node\node_modules\npm\bin\npm-cli.js`;
  const invocation = resolveNpmInvocation("npm", ["install", "--silent"], {
    platform: "win32",
    execPath: String.raw`C:\node\node.exe`,
    env: { PATH: String.raw`C:\node;C:\Windows\System32` },
    existsSync: (candidate) => candidate === npmCli,
  });

  assert.deepEqual(invocation, {
    command: String.raw`C:\node\node.exe`,
    args: [npmCli, "install", "--silent"],
  });
});

test("installer keeps native npm commands on non-Windows platforms", () => {
  assert.deepEqual(
    resolveNpmInvocation("npx", ["--yes", "skills"], { platform: "linux" }),
    { command: "npx", args: ["--yes", "skills"] }
  );
});

test("installer targets only worker agents whose CLIs are installed", () => {
  const installedCommands = new Set(["claude", "codex", "devin"]);
  const agents = detectInstalledSkillAgents((command) => installedCommands.has(command));
  const args = buildSkillsInstallArgs("owner/repository", agents);

  assert.deepEqual(agents, ["devin", "claude-code", "codex"]);
  assert.deepEqual(args.slice(args.indexOf("--agent") + 1, args.indexOf("--global")), agents);
  assert.equal(args.includes("*"), false);
});

test("installer skips skill installation when no worker CLI is installed", () => {
  assert.deepEqual(detectInstalledSkillAgents(() => false), []);
  assert.equal(buildSkillsInstallArgs("owner/repository", []), null);
});

test("archive age parser and terminal-state policy", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  assert.equal(parseAgeMs("1d"), 24 * hour);
  assert.equal(parseAgeMs("24h"), 24 * hour);
  assert.equal(parseAgeMs("90m"), 90 * 60 * 1000);
  assert.equal(parseAgeMs("1 day"), null);

  const old = {
    id: "old",
    status: "completed",
    finishedAt: new Date(now - 24 * hour).toISOString(),
  };
  assert.equal(isArchiveCandidate(old, { now, olderThanMs: 24 * hour }), true);
  assert.equal(
    isArchiveCandidate({ ...old, status: "running" }, { now, olderThanMs: 24 * hour }),
    false
  );

  const candidates = findArchiveCandidates([
    { ...old, id: "new", finishedAt: new Date(now - 23 * hour).toISOString() },
    old,
    { id: "legacy", status: "failed", updatedAt: new Date(now - 30 * hour).toISOString() },
  ], { now, olderThanMs: 24 * hour });
  assert.deepEqual(candidates.map((state) => state.id), ["legacy", "old"]);
});

test("stream formatter retains only the configured number of rendered blocks", () => {
  const input = Array.from(
    { length: 5000 },
    (_, index) => `[2026-08-01T00:00:00.000Z] line ${index}`
  ).join("\n");
  const html = formatStreamLog(input, { maxBlocks: 80 });
  assert.match(html, /earlier blocks omitted/);
  assert.ok((html.match(/sf-block/g) || []).length <= 81);
  assert.match(html, /line 4999/);
  assert.doesNotMatch(html, /line 0</);
});

test("desktop installer preserves relative framework symlinks", {
  skip: process.platform === "win32",
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-install-test-"));
  try {
    const source = path.join(temp, "source", "Framework.framework");
    const destination = path.join(temp, "installed", "Framework.framework");
    fs.mkdirSync(path.join(source, "Versions", "A", "Resources"), { recursive: true });
    fs.symlinkSync("A", path.join(source, "Versions", "Current"));
    fs.symlinkSync("Versions/Current/Resources", path.join(source, "Resources"));

    replaceDirectory(source, destination);

    assert.equal(fs.readlinkSync(path.join(destination, "Versions", "Current")), "A");
    assert.equal(
      fs.readlinkSync(path.join(destination, "Resources")),
      "Versions/Current/Resources"
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI previews and archives only finished workers older than one day", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-archive-test-"));
  const root = path.join(tempHome, ".orchestrator");
  const workers = path.join(root, "workers");
  const logs = path.join(root, "logs");
  fs.mkdirSync(workers, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const now = Date.now();
  const records = [
    { id: "old-completed", status: "completed", finishedAt: new Date(now - 25 * hour).toISOString() },
    { id: "legacy-failed", status: "failed", updatedAt: new Date(now - 30 * hour).toISOString() },
    { id: "recent-completed", status: "completed", finishedAt: new Date(now - 23 * hour).toISOString() },
    { id: "old-running", status: "running", finishedAt: new Date(now - 48 * hour).toISOString() },
    { id: "missing-time", status: "completed" },
  ];
  for (const record of records) {
    fs.writeFileSync(path.join(workers, `${record.id}.json`), JSON.stringify(record));
    fs.writeFileSync(path.join(logs, `${record.id}.log`), `${record.id}\n`);
  }
  fs.writeFileSync(
    path.join(workers, "old-completed.exit.json"),
    JSON.stringify({ status: "completed", finishedAt: new Date(now - 25 * hour).toISOString() })
  );

  const env = { ...process.env, HOME: tempHome, USERPROFILE: tempHome };
  const preview = spawnSync(process.execPath, [cli, "archive", "--older-than", "1d", "--dry-run"], {
    env,
    encoding: "utf8",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /old-completed/);
  assert.match(preview.stdout, /legacy-failed/);
  assert.doesNotMatch(preview.stdout, /recent-completed/);
  assert.doesNotMatch(preview.stdout, /old-running/);
  assert.doesNotMatch(preview.stdout, /undefined/);
  assert.equal(fs.existsSync(path.join(workers, "old-completed.json")), true);

  const archive = spawnSync(process.execPath, [cli, "archive", "--older-than", "24h"], {
    env,
    encoding: "utf8",
  });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /archived 2 workers/);
  assert.equal(fs.existsSync(path.join(workers, "old-completed.json")), false);
  assert.equal(fs.existsSync(path.join(workers, "legacy-failed.json")), false);
  assert.equal(fs.existsSync(path.join(workers, "recent-completed.json")), true);
  assert.equal(fs.existsSync(path.join(workers, "old-running.json")), true);
  assert.equal(fs.existsSync(path.join(workers, "missing-time.json")), true);
  // Archive intentionally retains logs for later inspection.
  assert.equal(fs.existsSync(path.join(logs, "old-completed.log")), true);

  fs.rmSync(tempHome, { recursive: true, force: true });
});

test("desktop bulk archive works and its log reader stays bounded", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-log-test-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    const { ROOT, WORKERS_DIR, LOGS_DIR } = await import("../desktop/electron/lib/paths.js");
    const { readLogTail } = await import("../desktop/electron/lib/workers.js");
    const { archiveOldWorkers } = await import("../desktop/electron/lib/actions.js");
    fs.mkdirSync(WORKERS_DIR, { recursive: true });
    fs.mkdirSync(LOGS_DIR, { recursive: true });

    // Desktop delegates deletion to the installed CLI, so mirror the small
    // installed layout inside the isolated test home.
    fs.copyFileSync(cli, path.join(ROOT, "orchestrator.js"));
    fs.cpSync(path.join(repoRoot, "orchestrator", "lib"), path.join(ROOT, "lib"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(ROOT, "package.json"), JSON.stringify({ type: "module" }));
    const desktopOld = {
      id: "desktop-old",
      status: "completed",
      finishedAt: new Date(Date.now() - 25 * hour).toISOString(),
    };
    const desktopRecent = {
      id: "desktop-recent",
      status: "completed",
      finishedAt: new Date(Date.now() - 23 * hour).toISOString(),
    };
    fs.writeFileSync(path.join(WORKERS_DIR, `${desktopOld.id}.json`), JSON.stringify(desktopOld));
    fs.writeFileSync(path.join(WORKERS_DIR, `${desktopRecent.id}.json`), JSON.stringify(desktopRecent));
    const archived = await archiveOldWorkers();
    assert.equal(archived.ok, true);
    assert.deepEqual(archived.archived, [desktopOld.id]);
    assert.equal(fs.existsSync(path.join(WORKERS_DIR, `${desktopOld.id}.json`)), false);
    assert.equal(fs.existsSync(path.join(WORKERS_DIR, `${desktopRecent.id}.json`)), true);

    const id = "large-log";
    const file = path.join(LOGS_DIR, `${id}.log`);
    fs.writeFileSync(file, Array.from({ length: 3000 }, (_, index) => `line-${index}`).join("\n"));

    const first = readLogTail(id, { bytes: 32 * 1024, maxLines: 100 });
    assert.equal(first.truncated, true);
    assert.ok(first.text.split("\n").length <= 100);

    const second = readLogTail(id, {
      bytes: 32 * 1024,
      maxLines: 100,
      knownSize: first.size,
      knownMtimeMs: first.mtimeMs,
    });
    assert.equal(second.unchanged, true);
    assert.equal("text" in second, false);

    fs.appendFileSync(file, "\nnew-line");
    const third = readLogTail(id, {
      bytes: 32 * 1024,
      maxLines: 100,
      knownSize: first.size,
      knownMtimeMs: first.mtimeMs,
    });
    assert.equal(third.unchanged, undefined);
    assert.match(third.text, /new-line$/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
