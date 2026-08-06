import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  detectFailureReason,
  DEFAULT_RESOURCE_PATTERNS,
} from "../orchestrator/lib/resume.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// state.js binds ROOT to ~/.orchestrator at import time. For isolated tests we
// import a fresh copy after redirecting HOME (and therefore os.homedir()).
async function loadStateModule(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // state.js uses os.homedir() which reads the real home on some platforms;
  // monkey-patch for the duration of the import+use.
  const realHomedir = os.homedir;
  os.homedir = () => home;
  try {
    const href = pathToFileURL(path.join(repoRoot, "orchestrator/lib/state.js")).href;
    return await import(`${href}?t=${Date.now()}-${Math.random()}`);
  } finally {
    // keep patched while tests call into the module; caller restores
    loadStateModule._restore = () => {
      os.homedir = realHomedir;
    };
  }
}

test("detectFailureReason classifies ENOSPC / disk full as resource", () => {
  assert.equal(
    detectFailureReason("Error: ENOSPC: no space left on device, open '/tmp/x'"),
    "resource"
  );
  assert.equal(detectFailureReason("disk full while writing logs"), "resource");
  assert.equal(detectFailureReason("Disk quota exceeded"), "resource");
  assert.ok(DEFAULT_RESOURCE_PATTERNS.includes("enospc"));
});

test("detectFailureReason classifies usage-limit / quota messages as rate-limit", () => {
  assert.equal(
    detectFailureReason(
      `{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits"}`
    ),
    "rate-limit"
  );
  assert.equal(detectFailureReason("quota exceeded for this org"), "rate-limit");
  assert.equal(detectFailureReason("insufficient credits remaining"), "rate-limit");
});

test("detectFailureReason prefers resource when ENOSPC co-occurs with quota wording", () => {
  // Disk-full strings often mention "quota"; local resource wins over API quota.
  assert.equal(
    detectFailureReason("usage limit hit; also ENOSPC on log write"),
    "resource"
  );
  assert.equal(detectFailureReason("Disk quota exceeded"), "resource");
});

test("reconcileWorkerState folds exit sentinel into running state", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-term-"));
  const state = await loadStateModule(home);
  try {
    state.ensureDirs();
    const id = "codex-20260101000000-test";
    state.writeState(id, {
      id,
      type: "codex",
      status: "running",
      pid: 99999999,
      sessionId: "sess-1",
      createdAt: new Date().toISOString(),
    });
    state.writeExit(id, {
      status: "failed-resumable",
      exitCode: 1,
      signal: null,
      finishedAt: "2026-01-01T00:00:01.000Z",
      error: "ENOSPC: no space left on device",
      failureReason: "resource",
      resumable: true,
      commitSha: null,
    });

    const next = state.reconcileWorkerState(id, { write: true, markDead: false });
    assert.equal(next.status, "failed-resumable");
    assert.equal(next.failureReason, "resource");
    assert.equal(next.pid, null);
    assert.equal(next.error, "ENOSPC: no space left on device");

    // persisted
    const disk = state.readState(id);
    assert.equal(disk.status, "failed-resumable");
  } finally {
    loadStateModule._restore?.();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("reconcileWorkerState marks dead supervisor failed when no sentinel", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-dead-"));
  const state = await loadStateModule(home);
  try {
    state.ensureDirs();
    const id = "claude-20260101000000-dead";
    // pid that is almost certainly not alive
    const deadPid = 2147483646;
    state.writeState(id, {
      id,
      type: "claude",
      status: "running",
      pid: deadPid,
      sessionId: "sess-dead",
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    // stale heartbeat (none) => dead

    const next = state.reconcileWorkerState(id, { write: true, markDead: true });
    assert.ok(["failed", "failed-resumable"].includes(next.status));
    assert.equal(next.status, "failed-resumable"); // sessionId present
    assert.equal(next.failureReason, "supervisor-died");
    assert.equal(next.pid, null);
    assert.ok(state.readExit(id)?.status);
  } finally {
    loadStateModule._restore?.();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("reconcileWorkerState does not kill a live-looking supervisor", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-live-"));
  const state = await loadStateModule(home);
  try {
    state.ensureDirs();
    const id = "grok-20260101000000-live";
    state.writeState(id, {
      id,
      type: "grok",
      status: "running",
      pid: process.pid, // this test process is alive
      createdAt: new Date().toISOString(),
    });
    state.beatHeartbeat(id);

    const next = state.reconcileWorkerState(id, { write: true, markDead: true });
    assert.equal(next.status, "running");
    assert.equal(next.pid, process.pid);
  } finally {
    loadStateModule._restore?.();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("writeExit survives as compact sentinel and is readable", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orch-exit-"));
  const state = await loadStateModule(home);
  try {
    state.ensureDirs();
    const id = "cursor-20260101000000-exit";
    state.writeExit(id, {
      status: "failed",
      exitCode: 1,
      error: "ENOSPC: no space left on device",
      failureReason: "resource",
    });
    const exit = state.readExit(id);
    assert.equal(exit.status, "failed");
    assert.equal(exit.failureReason, "resource");
    // compact (no pretty indent)
    const raw = fs.readFileSync(state.workerExit(id), "utf8");
    assert.equal(raw.includes("\n  "), false);
  } finally {
    loadStateModule._restore?.();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
