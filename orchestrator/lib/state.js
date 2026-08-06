// state.js — worker state file management
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const ROOT = path.join(os.homedir(), ".orchestrator");
export const WORKERS_DIR = path.join(ROOT, "workers");
export const LOGS_DIR = path.join(ROOT, "logs");
export const CONFIG_PATH = path.join(ROOT, "config.json");

export function ensureDirs() {
  for (const d of [ROOT, WORKERS_DIR, LOGS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function loadConfig() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function workerFile(id) {
  return path.join(WORKERS_DIR, `${id}.json`);
}

export function workerSock(id) {
  return path.join(WORKERS_DIR, `${id}.sock`);
}

export function workerLog(id) {
  return path.join(LOGS_DIR, `${id}.log`);
}

export function workerHeartbeat(id) {
  return path.join(WORKERS_DIR, `${id}.hb`);
}

export function workerExit(id) {
  return path.join(WORKERS_DIR, `${id}.exit.json`);
}

/** Touch the heartbeat file. Called by the supervisor on an interval. */
export function beatHeartbeat(id) {
  try { fs.writeFileSync(workerHeartbeat(id), String(Date.now())); } catch {}
}

/** ms since the last heartbeat, or Infinity if none exists. */
export function heartbeatAge(id) {
  try {
    return Date.now() - fs.statSync(workerHeartbeat(id)).mtimeMs;
  } catch {
    return Infinity;
  }
}

export const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "failed-resumable",
  "merged",
  "archived",
  "handed-off",
];

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Write JSON as atomically as the filesystem allows.
 * On ENOSPC (or any tmp+rename failure), fall back to a direct overwrite so a
 * tiny terminal/exit record can still land when the disk is nearly full.
 */
function writeJsonFile(file, obj, { compact = false } = {}) {
  const body = compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    // last resort: in-place write (still better than losing the result)
    try {
      fs.writeFileSync(file, body);
      return;
    } catch (e2) {
      const err = e2?.code === "ENOSPC" || e?.code === "ENOSPC" ? e2 : e2;
      throw err;
    }
  }
}

/**
 * Terminal-result sentinel, written by the supervisor in finish() before the
 * (larger, merge-based) state write. Survives even if the state write races
 * or fails, so `wait` can always recover the true outcome.
 *
 * Uses compact JSON so the write is more likely to succeed under ENOSPC.
 */
export function writeExit(id, obj) {
  writeJsonFile(workerExit(id), obj, { compact: true });
}

export function readExit(id) {
  try {
    return JSON.parse(fs.readFileSync(workerExit(id), "utf8"));
  } catch {
    return null;
  }
}

/** Remove per-run liveness/exit artifacts (before relaunch or on archive). */
export function clearRunArtifacts(id) {
  for (const f of [workerExit(id), workerHeartbeat(id)]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but is owned by someone else
    return e.code === "EPERM";
  }
}

/**
 * Best-effort liveness for a non-terminal worker.
 * - pending (no pid yet): alive for a short startup grace window
 * - has pid: alive if heartbeat is fresh OR the pid still exists
 * - otherwise: alive only while a heartbeat is fresh
 */
export function isSupervisorAliveLocal(s, { heartbeatStaleMs = 15000, pendingGraceMs = 60000 } = {}) {
  if (!s || isTerminalStatus(s.status)) return false;
  if (s.pid) {
    return heartbeatAge(s.id) < heartbeatStaleMs || pidAlive(s.pid);
  }
  if (s.status === "pending") {
    const born = new Date(s.createdAt || 0).getTime();
    return Number.isFinite(born) && Date.now() - born < pendingGraceMs;
  }
  return heartbeatAge(s.id) < heartbeatStaleMs;
}

/**
 * Fold exit-sentinel / dead-supervisor into state so ls/status/desktop/wait
 * never leave a dead run stuck at "running".
 *
 * @param {string} id
 * @param {{ write?: boolean, markDead?: boolean, heartbeatStaleMs?: number }} [opts]
 *   write     — persist reconciled state (default true)
 *   markDead  — if supervisor looks dead and no sentinel, mark failed (default true)
 */
export function reconcileWorkerState(id, opts = {}) {
  const write = opts.write !== false;
  const markDead = opts.markDead !== false;
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? 15000;

  const s = readState(id);
  if (!s) return null;
  if (isTerminalStatus(s.status)) return s;

  const exit = readExit(id);
  if (exit?.status && isTerminalStatus(exit.status)) {
    const next = { ...s, ...exit, pid: null };
    if (write) {
      try { writeState(id, next); } catch { /* ENOSPC etc. — caller still gets next */ }
    }
    return next;
  }

  if (!markDead) return s;
  if (isSupervisorAliveLocal(s, { heartbeatStaleMs })) return s;

  // Prefer last known activity for finishedAt so long-dead "running" leftovers
  // become eligible for archive --older-than rather than aging from "now".
  let finishedAt = s.finishedAt || null;
  if (!finishedAt) {
    try {
      finishedAt = new Date(fs.statSync(workerHeartbeat(id)).mtimeMs).toISOString();
    } catch {
      finishedAt = s.startedAt || s.updatedAt || s.createdAt || new Date().toISOString();
    }
  }

  const next = {
    ...s,
    pid: null,
    status: s.sessionId ? "failed-resumable" : "failed",
    exitCode: s.exitCode ?? 1,
    failureReason: s.failureReason || "supervisor-died",
    error: s.error || "worker supervisor exited without recording a result",
    finishedAt,
    resumable: !!s.sessionId,
  };
  if (write) {
    try {
      writeExit(id, {
        status: next.status,
        exitCode: next.exitCode,
        signal: next.signal || null,
        finishedAt: next.finishedAt,
        error: next.error,
        failureReason: next.failureReason,
        resumable: next.resumable,
        commitSha: next.commitSha || null,
      });
    } catch { /* ignore */ }
    try { writeState(id, next); } catch { /* ignore */ }
    try { fs.unlinkSync(workerHeartbeat(id)); } catch { /* ignore */ }
  }
  return next;
}

export function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(workerFile(id), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(id, state) {
  ensureDirs();
  const full = { ...state, updatedAt: new Date().toISOString() };
  // Prefer atomic write; fall back to in-place on ENOSPC so terminal status
  // can still be recorded when the disk is nearly full.
  writeJsonFile(workerFile(id), full, { compact: false });
}

export function listWorkers() {
  ensureDirs();
  return fs
    .readdirSync(WORKERS_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".exit.json") && !f.includes(".tmp"))
    .map((f) => path.basename(f, ".json"));
}

export function genId(prefix) {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${t}-${r}`;
}
