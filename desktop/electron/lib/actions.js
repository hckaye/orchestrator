// Worker actions: message, revise, resume, force-fail, archive
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { workerSock, workerLog, workerFile, ROOT } from "./paths.js";
import { readState, invalidateSummaryCache } from "./workers.js";

const execFileAsync = promisify(execFile);

const TERMINAL = new Set([
  "completed",
  "failed",
  "failed-resumable",
  "merged",
  "archived",
  "handed-off",
]);

function sendSock(id, msg, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const sock = workerSock(id);
    if (!fs.existsSync(sock)) {
      settle({ ok: false, error: "no supervisor socket" });
      return;
    }
    const conn = net.connect(sock, () => {
      conn.write(JSON.stringify(msg) + "\n");
    });
    let buf = "";
    const parse = () => {
      try {
        settle(JSON.parse(buf.trim()));
      } catch {
        settle({ ok: false, error: "bad reply" });
      }
    };
    conn.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) parse();
    });
    conn.on("end", () => parse());
    conn.on("error", (e) => settle({ ok: false, error: e.message }));
    timer = setTimeout(() => settle({ ok: false, error: "timeout" }), timeoutMs);
  });
}

function appendDesktopLog(id, text) {
  try {
    fs.appendFileSync(workerLog(id), `\n[desktop] ${text}\n`);
  } catch {
    /* ignore */
  }
}

function writeStateFile(id, stateObj) {
  const full = { ...stateObj, updatedAt: new Date().toISOString() };
  const file = workerFile(id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
  fs.renameSync(tmp, file);
  invalidateSummaryCache([id]);
}

function findOrchestratorBin() {
  const candidates = [
    path.join(ROOT, "orchestrator.js"),
    path.join(os.homedir(), ".local", "bin", "orchestrator"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Run orchestrator CLI and capture stdout/stderr.
 * @param {string[]} argv  e.g. ["revise", id, "--", "msg"]
 */
function runOrchestrator(argv, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const bin = findOrchestratorBin();
    if (!bin) {
      resolve({ ok: false, error: "orchestrator CLI not found under ~/.orchestrator" });
      return;
    }
    const isJs = bin.endsWith(".js");
    const cmd = isJs ? process.execPath : bin;
    const args = isJs ? [bin, ...argv] : argv;
    const child = spawn(cmd, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        error: "timeout",
        stdout,
        stderr,
      });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: code === 0 ? null : stderr.trim() || stdout.trim() || `exit ${code}`,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}

async function killSupervisorProcess(id) {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    const re = new RegExp(`worker\\.js\\s+${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const line of stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      if (re.test(m[2])) {
        try {
          process.kill(Number(m[1]), "SIGTERM");
        } catch {
          /* ignore */
        }
        return { killed: true, pid: Number(m[1]) };
      }
    }
  } catch {
    /* ignore */
  }
  return { killed: false };
}

/**
 * Send a message to a worker (live input or revise fallback).
 */
export async function sendWorkerMessage(id, message, { forceRevise = false } = {}) {
  const text = String(message || "").trim();
  if (!id || !text) return { ok: false, error: "empty id or message" };

  const st = readState(id);
  if (!st) return { ok: false, error: "worker not found" };

  appendDesktopLog(id, `user → ${text.replace(/\n/g, "\\n")}`);

  if (forceRevise) {
    return reviseWorker(id, text);
  }

  const status = st.status || "";
  const awaiting = status.startsWith("awaiting-");

  const live = await sendSock(id, {
    cmd: awaiting ? "respond" : "input",
    answer: text,
    text,
  });
  if (live.ok) {
    return { ok: true, mode: awaiting ? "respond" : "input", via: live.via };
  }

  if (TERMINAL.has(status) || status === "pending") {
    if (!st.sessionId) {
      return {
        ok: false,
        error: live.error
          ? `${live.error}; no sessionId for revise`
          : "no sessionId — cannot revise",
      };
    }
    return reviseWorker(id, text);
  }

  return {
    ok: false,
    error:
      (live.error || "could not write to worker") +
      (st.sessionId
        ? " — mid-run print mode may ignore stdin; wait then revise, or use Force revise"
        : ""),
    canReviseLater: !!st.sessionId,
  };
}

export async function reviseWorker(id, feedback) {
  const text = String(feedback || "").trim();
  if (!text) return { ok: false, error: "feedback is required for revise" };
  const st = readState(id);
  if (!st) return { ok: false, error: "worker not found" };
  if (!st.sessionId) return { ok: false, error: "no sessionId — cannot revise" };

  // If still running, force-fail first so revise can relaunch cleanly
  if (!TERMINAL.has(st.status) && st.status !== "pending") {
    await forceFailWorker(id, { reason: "desktop-revise-preempt", silent: true });
    // brief wait for state settle
    await new Promise((r) => setTimeout(r, 400));
  }

  appendDesktopLog(id, `revise → ${text.replace(/\n/g, "\\n").slice(0, 400)}`);
  const r = await runOrchestrator(["revise", id, "--", text]);
  if (r.ok) {
    invalidateSummaryCache([id]);
    return { ok: true, mode: "revise", id: r.stdout || id };
  }
  return { ok: false, error: r.error || "revise failed", stderr: r.stderr };
}

export async function resumeWorker(id, message = "") {
  const st = readState(id);
  if (!st) return { ok: false, error: "worker not found" };
  if (!st.sessionId) return { ok: false, error: "no sessionId — cannot resume" };

  const argv = ["resume", id, "--force"];
  const msg = String(message || "").trim();
  if (msg) argv.push("--", msg);

  appendDesktopLog(id, `resume${msg ? ` → ${msg.slice(0, 200)}` : ""}`);
  const r = await runOrchestrator(argv);
  if (r.ok) {
    invalidateSummaryCache([id]);
    return { ok: true, mode: "resume", id: r.stdout || id };
  }
  return { ok: false, error: r.error || "resume failed", stderr: r.stderr };
}

/**
 * Force-terminate worker and mark status failed (resumable if sessionId exists).
 */
export async function forceFailWorker(id, { reason = "desktop-force-kill", silent = false } = {}) {
  const st = readState(id);
  if (!st) return { ok: false, error: "worker not found" };

  if (TERMINAL.has(st.status) && st.status !== "pending") {
    // already terminal — still allow re-marking running leftovers
    if (["failed", "failed-resumable", "completed", "merged", "archived", "handed-off"].includes(st.status)) {
      if (!silent && st.status !== "failed" && st.status !== "failed-resumable") {
        return { ok: false, error: `already ${st.status}` };
      }
    }
  }

  const sockKill = await sendSock(id, { cmd: "kill" });
  const procKill = await killSupervisorProcess(id);

  // Give supervisor a moment to write terminal status via finish()
  await new Promise((r) => setTimeout(r, 600));

  let cur = readState(id) || st;
  if (!TERMINAL.has(cur.status) || cur.status === "pending" || cur.status === "running" || cur.status?.startsWith("awaiting-")) {
    const next = {
      ...cur,
      status: cur.sessionId ? "failed-resumable" : "failed",
      exitCode: cur.exitCode ?? 1,
      signal: cur.signal || "SIGTERM",
      finishedAt: new Date().toISOString(),
      error: cur.error || "force-terminated from desktop",
      failureReason: reason,
      resumable: !!cur.sessionId,
    };
    writeStateFile(id, next);
    cur = next;
  }

  try {
    fs.unlinkSync(workerSock(id));
  } catch {
    /* ignore */
  }

  if (!silent) appendDesktopLog(id, `force-fail reason=${reason}`);
  invalidateSummaryCache([id]);
  return {
    ok: true,
    mode: "force-fail",
    status: cur.status,
    sockKill: !!sockKill.ok,
    procKill: !!procKill.killed,
  };
}

export async function archiveWorker(id) {
  const st = readState(id);
  if (!st) return { ok: false, error: "worker not found" };

  // Kill if still live so archive doesn't leave orphan processes
  if (!TERMINAL.has(st.status) || st.status === "pending" || isLiveSock(id)) {
    await forceFailWorker(id, { reason: "desktop-archive-preempt", silent: true });
    await new Promise((r) => setTimeout(r, 300));
  }

  appendDesktopLog(id, "archive");
  const r = await runOrchestrator(["archive", id]);
  if (r.ok) {
    invalidateSummaryCache([id]);
    return { ok: true, mode: "archive", message: r.stdout || `archived ${id}` };
  }
  return { ok: false, error: r.error || "archive failed", stderr: r.stderr };
}

function isLiveSock(id) {
  return fs.existsSync(workerSock(id));
}

export async function pingWorker(id) {
  return sendSock(id, { cmd: "ping" });
}

export { sendSock };
