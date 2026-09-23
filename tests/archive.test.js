import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  updateConfigDefaults,
} from "../install-utils.js";
import { applyCursorModelEffort, applyDevinModelEffort, pickWorkerRuntime } from "../orchestrator/lib/models.js";
import { buildCommand, buildResumeCommand, extractSessionId } from "../orchestrator/lib/cli-adapters.js";
import { moduleDirectory } from "../orchestrator/lib/paths.js";
import { buildOrchestratorInvocation } from "../desktop/electron/lib/orchestrator-process.js";
import {
  buildWorkerPrompt,
  nestedSpawnError,
  workerEnvironment,
} from "../orchestrator/lib/worker-context.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, "orchestrator", "orchestrator.js");
const hour = 60 * 60 * 1000;

test("module URLs resolve to native filesystem directories", () => {
  const fixture = path.join(repoRoot, "directory with spaces", "entry.js");
  const directory = moduleDirectory(pathToFileURL(fixture));

  assert.equal(directory, path.dirname(fixture));
  if (process.platform === "win32") {
    assert.doesNotMatch(directory, /^\/[A-Za-z]:/);
  }
});

test("packaged Electron runs the installed orchestrator script as Node", () => {
  const env = { PATH: "/usr/bin" };
  const invocation = buildOrchestratorInvocation(
    "/home/test/.orchestrator/orchestrator.js",
    ["archive", "--older-than", "1d"],
    {
      execPath: "/opt/Orchestrator/Orchestrator",
      env,
      electron: true,
    }
  );

  assert.equal(invocation.command, "/opt/Orchestrator/Orchestrator");
  assert.deepEqual(invocation.args, [
    "/home/test/.orchestrator/orchestrator.js",
    "archive",
    "--older-than",
    "1d",
  ]);
  assert.deepEqual(invocation.env, {
    PATH: "/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
});

test("model-selection defaults expose the approved commander choices and worker tiers", () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "orchestrator", "config.example.json"),
    "utf8"
  ));

  assert.deepEqual(pickWorkerRuntime(config, "devin"), {
    model: "swe-2",
    effort: "high",
  });
  assert.deepEqual(pickWorkerRuntime(config, "codex"), {
    model: "gpt-6.0-luna",
    effort: "max",
  });
  assert.deepEqual(pickWorkerRuntime(config, "claude"), {
    model: "claude-opus-5-5",
    effort: "high",
  });
  assert.deepEqual(pickWorkerRuntime(config, "cursor"), {
    model: "grok-4.7-medium",
    effort: "medium",
  });
  assert.deepEqual(pickWorkerRuntime(config, "grok"), {
    model: "grok-4.7",
    effort: "medium",
  });
  assert.deepEqual(pickWorkerRuntime(config, "opencode"), {
    model: "deepseek/deepseek-v4.1-flash",
    effort: null,
  });
  assert.deepEqual(pickWorkerRuntime(config, "opencode-go"), {
    model: "deepseek-v4.1-flash",
    effort: null,
  });
  assert.deepEqual(pickWorkerRuntime(config, "zen"), {
    model: "deepseek-v4.1-flash",
    effort: null,
  });
  assert.deepEqual(config.commander, {
    defaultModel: "claude-fable-5-1[1m]",
    thinkingLevel: "high",
    alternatives: [{
      model: "gpt-6-astra",
      thinkingLevel: "medium",
    }],
  });
});

test("installer upgrades previous model defaults without replacing custom choices", () => {
  const legacy = {
    workers: {
      devin: { defaultModel: "glm-5.2" },
      codex: { defaultModel: "gpt-5.6-terra" },
      claude: { defaultModel: "claude-opus-5" },
      cursor: { defaultModel: "composer-2.5" },
      grok: { defaultModel: "grok-4.5" },
    },
    commander: { defaultModel: "claude-fable-5[1m]" },
    permissionBridge: { patterns: { grok: [] } },
  };
  assert.equal(updateConfigDefaults(legacy), true);
  assert.equal(legacy.workers.devin.defaultModel, "swe-2");
  assert.equal(legacy.workers.devin.defaultEffort, "high");
  assert.equal(legacy.workers.codex.defaultModel, "gpt-6.0-luna");
  assert.equal(legacy.workers.claude.defaultModel, "claude-opus-5-5");
  assert.equal(legacy.workers.cursor.defaultModel, "grok-4.7-medium");
  assert.equal(legacy.workers.cursor.defaultEffort, "medium");
  assert.equal(legacy.workers.grok.defaultModel, "grok-4.7");
  assert.equal(legacy.workers.grok.defaultEffort, "medium");
  assert.equal(legacy.workers.opencode.defaultModel, "deepseek/deepseek-v4.1-flash");
  assert.equal(legacy.workers["opencode-go"].provider, "opencode-go");
  assert.equal(legacy.workers["opencode-go"].defaultModel, "deepseek-v4.1-flash");
  assert.equal(legacy.workers.zen.provider, "opencode");
  assert.equal(legacy.workers.zen.defaultModel, "deepseek-v4.1-flash");
  assert.ok(legacy.permissionBridge.patterns["opencode-go"].length > 0);
  assert.equal(legacy.commander.defaultModel, "claude-fable-5-1[1m]");

  const previousGrok = {
    workers: {
      cursor: { defaultModel: "cursor-grok-4.6-medium", defaultEffort: "medium" },
      grok: { defaultModel: "grok-4.6", defaultEffort: "medium" },
    },
  };
  assert.equal(updateConfigDefaults(previousGrok), true);
  assert.equal(previousGrok.workers.cursor.defaultModel, "grok-4.7-medium");
  assert.equal(previousGrok.workers.cursor.defaultEffort, "medium");
  assert.equal(previousGrok.workers.grok.defaultModel, "grok-4.7");
  assert.equal(previousGrok.workers.grok.defaultEffort, "medium");

  const legacyVariant = { workers: { devin: { defaultModel: "glm-5-2" } } };
  assert.equal(updateConfigDefaults(legacyVariant), true);
  assert.equal(legacyVariant.workers.devin.defaultModel, "swe-2");

  const previousSweDefault = {
    workers: { devin: { defaultModel: "swe-2", defaultEffort: "max" } },
  };
  assert.equal(updateConfigDefaults(previousSweDefault), true);
  assert.equal(previousSweDefault.workers.devin.defaultEffort, "high");

  const custom = {
    workers: {
      devin: { defaultModel: "opus", defaultEffort: "high" },
      codex: { defaultModel: "gpt-6.0-sol" },
      claude: { defaultModel: "claude-haiku-4-5" },
      cursor: { defaultModel: "cursor-custom", defaultEffort: "high" },
      grok: { defaultModel: "grok-custom", defaultEffort: "high" },
      opencode: { defaultModel: "custom/custom-model" },
      "opencode-go": { defaultModel: "custom-go-model" },
      zen: { defaultModel: "custom-zen-model" },
    },
    commander: { defaultModel: "gpt-6.0-sol" },
    permissionBridge: {
      patterns: { grok: [], opencode: [], "opencode-go": [], zen: [] },
    },
  };
  assert.equal(updateConfigDefaults(custom), false);
  assert.equal(custom.workers.devin.defaultModel, "opus");
  assert.equal(custom.workers.devin.defaultEffort, "high");
  assert.equal(custom.workers.codex.defaultModel, "gpt-6.0-sol");
  assert.equal(custom.workers.claude.defaultModel, "claude-haiku-4-5");
  assert.equal(custom.workers.cursor.defaultModel, "cursor-custom");
  assert.equal(custom.workers.cursor.defaultEffort, "high");
  assert.equal(custom.workers.grok.defaultModel, "grok-custom");
  assert.equal(custom.workers.grok.defaultEffort, "high");
  assert.equal(custom.workers.opencode.defaultModel, "custom/custom-model");
  assert.equal(custom.workers["opencode-go"].defaultModel, "custom-go-model");
  assert.equal(custom.workers.zen.defaultModel, "custom-zen-model");
  assert.equal(custom.commander.defaultModel, "gpt-6.0-sol");
});

test("worker prompts and environment prohibit nested worker dispatch", () => {
  const prompt = buildWorkerPrompt("implement the change", "Keep edits scoped.");
  assert.match(prompt, /implement the change/);
  assert.match(prompt, /Keep edits scoped/);
  assert.match(prompt, /Do not create or delegate to subagents, subworkers, or other coding agents/);
  assert.match(prompt, /orchestrator spawn/);

  const env = workerEnvironment("devin-test", { PATH: "/bin" });
  assert.equal(env.ORCHESTRATOR_WORKER_ID, "devin-test");
  assert.match(nestedSpawnError("spawn", env), /cannot start another worker/);
  assert.match(nestedSpawnError("handoff-spawn", env), /cannot start another worker/);
  assert.equal(nestedSpawnError("status", env), null);
  assert.equal(nestedSpawnError("spawn", {}), null);

  const nested = spawnSync(
    process.execPath,
    [cli, "spawn", "devin", "--no-worktree", "--", "do not run"],
    {
      encoding: "utf8",
      env: { ...process.env, ORCHESTRATOR_WORKER_ID: "devin-parent" },
    }
  );
  assert.equal(nested.status, 2);
  assert.match(nested.stderr, /worker devin-parent cannot start another worker/);
});

test("Devin effort resolves to the listed <base>-<level> model variant", () => {
  const slugs = [
    "swe-2-high",
    "swe-2-medium",
    "swe-2-max",
    "swe-1-7",
    "swe-1-7-medium",
    "glm-5-2",
    "glm-5-2-max",
    "glm-5-2-1m",
    "glm-5-2-max-1m",
    "adaptive",
  ];
  assert.equal(applyDevinModelEffort("swe-2", "max", slugs), "swe-2-max");
  assert.equal(applyDevinModelEffort("swe-2", "medium", slugs), "swe-2-medium");
  assert.equal(applyDevinModelEffort("swe-2-max", "high", slugs), "swe-2-high");
  // dotted spelling resolves to the canonical listed slug
  assert.equal(applyDevinModelEffort("glm-5.2", "max", slugs), "glm-5-2-max");
  // context-size suffix stays last in the listed variant
  assert.equal(applyDevinModelEffort("glm-5-2-1m", "max", slugs), "glm-5-2-max-1m");
  // swe-1-7 has no -max variant; the bare slug is already the max tier
  assert.equal(applyDevinModelEffort("swe-1-7", "max", slugs), "swe-1-7");
  assert.equal(applyDevinModelEffort("adaptive", "max", slugs), "adaptive");
  // without an authoritative list, only tiered slugs are rewritten
  assert.equal(applyDevinModelEffort("swe-2", "max", null), "swe-2");
  assert.equal(applyDevinModelEffort("swe-2-max", "high", null), "swe-2-high");
});

test("opencode workers prefix bare models with the pinned provider and map effort to --variant", () => {
  const cfg = {
    workers: {
      opencode: { cli: "opencode", defaultModel: "deepseek/deepseek-v4.1-flash", auto: true, printMode: true, extraArgs: [] },
      "opencode-go": { cli: "opencode", provider: "opencode-go", defaultModel: "deepseek-v4.1-flash", auto: true, printMode: true, extraArgs: [] },
      zen: { cli: "opencode", provider: "opencode", defaultModel: "deepseek-v4.1-flash", auto: true, printMode: true, extraArgs: [] },
    },
  };
  const go = buildCommand("opencode-go", { cfg, model: "deepseek-v4.1-flash", prompt: "do x", cwd: "c" });
  assert.deepEqual(go.argv, [
    "run", "-m", "opencode-go/deepseek-v4.1-flash", "--format", "json", "--auto", "do x",
  ]);
  const zen = buildCommand("zen", { cfg, model: "glm-5.3-flash", effort: "high", prompt: "do x", cwd: "c" });
  assert.deepEqual(zen.argv, [
    "run", "-m", "opencode/glm-5.3-flash", "--variant", "high", "--format", "json", "--auto", "do x",
  ]);
  const oc = buildCommand("opencode", { cfg, model: "deepseek/deepseek-v4.1-flash", prompt: "do x", cwd: "c" });
  assert.ok(oc.argv.includes("deepseek/deepseek-v4.1-flash"));
  const bypass = buildCommand("zen", { cfg, model: "openai/gpt-5.5", prompt: "do x", cwd: "c" });
  assert.ok(bypass.argv.includes("openai/gpt-5.5"));
  const resumed = buildResumeCommand("opencode-go", {
    cfg, model: "deepseek-v4.1-flash", sessionId: "ses_abc", prompt: "go", cwd: "c",
  });
  assert.deepEqual(resumed.argv, [
    "run", "--session", "ses_abc", "-m", "opencode-go/deepseek-v4.1-flash",
    "--format", "json", "--auto", "go",
  ]);
  const interactive = buildCommand("zen", { cfg, model: "glm-5.3-flash", prompt: "do x", cwd: "c", interactive: true });
  assert.ok(interactive.argv.includes("--interactive"));
  assert.ok(!interactive.argv.includes("--auto"));
  assert.equal(
    extractSessionId("opencode", '{"type":"step_start","sessionID":"ses_f6caba079ffeUFv0Zllk3sgYsa"}'),
    "ses_f6caba079ffeUFv0Zllk3sgYsa",
  );
});

test("Grok 4.7 defaults select the requested tier and explicit older models remain allowed", () => {
  assert.equal(
    applyCursorModelEffort(
      "grok-4.7-medium",
      "xhigh",
      ["grok-4.7-medium", "grok-4.7-xhigh"]
    ),
    "grok-4.7-xhigh"
  );
  assert.equal(
    applyCursorModelEffort(
      "cursor-grok-4.6-medium",
      "xhigh",
      ["cursor-grok-4.6-medium", "cursor-grok-4.6-xhigh"]
    ),
    "cursor-grok-4.6-xhigh"
  );

  const config = {
    workers: { grok: { defaultModel: "grok-4.7", defaultEffort: "medium" } },
  };
  assert.deepEqual(pickWorkerRuntime(config, "grok", { model: "grok-4.6" }), {
    model: "grok-4.6",
    effort: "medium",
  });
  assert.deepEqual(pickWorkerRuntime(config, "grok", { model: "grok-4.5" }), {
    model: "grok-4.5",
    effort: "medium",
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

test("stream formatter makes legacy duplicated Devin progress readable", () => {
  const input = "LetLet me me inspect inspect the the files files. NowNow I have I have the the result result.";
  const html = formatStreamLog(input, { workerType: "devin", maxBlocks: 80 });
  assert.match(html, /sf-progress/);
  assert.match(html, /Let me inspect the files\./);
  assert.match(html, /Now I have the result\./);
  assert.doesNotMatch(html, /LetLet|NowNow| me me | result result/);
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
    // Dead "running" (no live pid / heartbeat) is reconciled to failed, then archiveable.
    { id: "old-running-dead", status: "running", pid: 2147483646, createdAt: new Date(now - 48 * hour).toISOString() },
    // Truly live supervisor must never be archived.
    { id: "live-running", status: "running", pid: process.pid, createdAt: new Date().toISOString() },
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
  // Fresh heartbeat so live-running is not mistaken for a dead supervisor.
  fs.writeFileSync(path.join(workers, "live-running.hb"), String(Date.now()));

  const env = { ...process.env, HOME: tempHome, USERPROFILE: tempHome };
  const preview = spawnSync(process.execPath, [cli, "archive", "--older-than", "1d", "--dry-run"], {
    env,
    encoding: "utf8",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /old-completed/);
  assert.match(preview.stdout, /legacy-failed/);
  assert.match(preview.stdout, /old-running-dead/);
  assert.doesNotMatch(preview.stdout, /recent-completed/);
  assert.doesNotMatch(preview.stdout, /live-running/);
  assert.doesNotMatch(preview.stdout, /undefined/);
  assert.equal(fs.existsSync(path.join(workers, "old-completed.json")), true);

  const archive = spawnSync(process.execPath, [cli, "archive", "--older-than", "24h"], {
    env,
    encoding: "utf8",
  });
  assert.equal(archive.status, 0, archive.stderr);
  assert.match(archive.stdout, /archived 3 workers/);
  assert.equal(fs.existsSync(path.join(workers, "old-completed.json")), false);
  assert.equal(fs.existsSync(path.join(workers, "legacy-failed.json")), false);
  assert.equal(fs.existsSync(path.join(workers, "old-running-dead.json")), false);
  assert.equal(fs.existsSync(path.join(workers, "recent-completed.json")), true);
  assert.equal(fs.existsSync(path.join(workers, "live-running.json")), true);
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
