// worker.js — worker supervisor process
// Usage: node worker.js <id>
// Launched by orchestrator.js in background. Manages one CLI worker.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import * as state from "./state.js";
import { buildCommand, buildResumeCommand, extractSessionId } from "./cli-adapters.js";
import { detectFailureReason } from "./resume.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: worker.js <id>");
  process.exit(2);
}

const st = state.readState(id);
if (!st) {
  console.error(`no state for ${id}`);
  process.exit(2);
}

const cfg = state.loadConfig();
const logStream = fs.createWriteStream(state.workerLog(id), { flags: "a" });
function log(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  logStream.write(msg + "\n");
}

const isResume = st.mode === "resume" && !!st.sessionId;
const cmd = isResume
  ? buildResumeCommand(st.type, {
      cfg,
      model: st.model,
      effort: st.effort,
      sessionId: st.sessionId,
      prompt: st.prompt,
      cwd: st.worktree?.path || st.cwd,
      interactive: st.interactive,
    })
  : buildCommand(st.type, {
      cfg,
      model: st.model,
      effort: st.effort,
      prompt: st.prompt,
      cwd: st.worktree?.path || st.cwd,
      interactive: st.interactive,
    });

log(`spawn ${cmd.cliBin} ${cmd.argv.join(" ")} (pty=${cmd.usePty} resume=${isResume})`);

let child = null;
let finished = false;
let heartbeatTimer = null;
let ptyDataBuf = "";
let combinedBuf = "";
const BUF_CAP = 256 * 1024; // keep only the tail; logs hold the full output
let sessionIdFound = !!st.sessionId;
let bridgePatterns = [];
if (cmd.usePty && cfg.permissionBridge?.enabled) {
  bridgePatterns = (cfg.permissionBridge.patterns?.[st.type] || []).map((p) => ({
    regex: new RegExp(p.regex, "i"),
    type: p.type,
  }));
}

// Any crash in this supervisor must still land the worker in a terminal
// status, otherwise `orchestrator wait` spins on "running" forever.
// finish() never throws and always process.exit; the trailing process.exit
// here is a belt-and-suspenders guard if finish was already entered.
process.on("uncaughtException", (e) => {
  try { log(`uncaught exception: ${e.stack || e.message}`); } catch {}
  try { finish(1, null, e?.message || String(e)); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  const msg = e?.stack || e?.message || String(e);
  try { log(`unhandled rejection: ${msg}`); } catch {}
  try { finish(1, null, e?.message || String(e)); } catch {}
  process.exit(1);
});

// Disk-full on the log stream used to become an uncaught 'error' and leave
// the worker stuck mid-finish. Swallow and finish cleanly instead.
logStream.on("error", (e) => {
  try { process.stderr.write(`[log-stream error] ${e.message}\n`); } catch {}
  if (!finished) finish(1, null, e.message || String(e));
});

// A stale exit sentinel from a previous run would make `wait` return
// immediately with the old result — clear it before going live.
state.clearRunArtifacts(id);
setState({ status: "running", pid: process.pid, startedAt: new Date().toISOString() });
state.beatHeartbeat(id);
heartbeatTimer = setInterval(() => state.beatHeartbeat(id), 3000);
heartbeatTimer.unref();

function setState(patch) {
  const cur = state.readState(id) || st;
  const next = { ...cur, ...patch };
  state.writeState(id, next);
  return next;
}

/** setState that never throws — used on the terminal path under ENOSPC. */
function setStateSafe(patch) {
  try {
    return setState(patch);
  } catch (e) {
    try { log(`setState failed: ${e.message}`); } catch {}
    return null;
  }
}

function tryExtractSessionId(text) {
  if (sessionIdFound) return;
  const sid = extractSessionId(st.type, text);
  if (sid) {
    sessionIdFound = true;
    setState({ sessionId: sid });
    log(`session id captured: ${sid}`);
  }
}

function handlePtyOutput(chunk) {
  const text = chunk.toString();
  ptyDataBuf = (ptyDataBuf + text).slice(-BUF_CAP);
  combinedBuf = (combinedBuf + text).slice(-BUF_CAP);
  tryExtractSessionId(text);
  // detect permission/question prompt
  for (const p of bridgePatterns) {
    if (p.regex.test(text)) {
      const cur = state.readState(id);
      if (cur.status === "running") {
        // capture last ~40 lines as context
        const ctx = ptyDataBuf.split("\n").slice(-40).join("\n");
        setState({
          status: p.type === "question" ? "awaiting-question" : "awaiting-permission",
          pendingPrompt: ctx,
          pendingAt: new Date().toISOString(),
        });
        log(`bridge: ${p.type} prompt detected`);
      }
      break;
    }
  }
  // if awaiting and new non-prompt output arrives, assume resolved
  const cur = state.readState(id);
  if (cur.status?.startsWith("awaiting-") && !bridgePatterns.some((p) => p.regex.test(text))) {
    // wait a beat; only flip back if it looks like progress
    if (text.trim().length > 0 && !/^\s*[yn]/i.test(text.trim())) {
      setState({ status: "running", pendingPrompt: null });
    }
  }
}

// Pre-flight: argv + env must fit in the OS exec limit (ARG_MAX, ~1MB on
// macOS). Oversized prompts (e.g. handoff briefings with big diffs) used to
// crash the supervisor with an uncaught `spawn E2BIG`, leaving the worker
// stuck at status "running". Fail cleanly instead.
const ARG_ENV_LIMIT = 900 * 1024;
const argvBytes = [cmd.cliBin, ...cmd.argv].reduce((n, a) => n + Buffer.byteLength(String(a), "utf8") + 1, 0);
const envBytes = Object.entries({ ...process.env, ...cmd.env }).reduce(
  (n, [k, v]) => n + Buffer.byteLength(k, "utf8") + Buffer.byteLength(String(v ?? ""), "utf8") + 2,
  0
);
if (argvBytes + envBytes > ARG_ENV_LIMIT) {
  finish(1, null,
    `command line too large (argv ${argvBytes} + env ${envBytes} bytes > ${ARG_ENV_LIMIT}) — ` +
    `shrink the prompt (for handoff-spawn, lower --log-tail / --max-diff)`);
}

try {
  if (cmd.usePty) {
    const pty = await import("node-pty");
    child = pty.spawn(cmd.cliBin, cmd.argv, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: st.worktree?.path || st.cwd || process.cwd(),
      env: { ...process.env, ...cmd.env },
    });
    child.onData((d) => {
      try { process.stdout.write(d); } catch {}
      try { logStream.write(d); } catch {}
      try { handlePtyOutput(d); } catch (e) {
        try { log(`pty output handler error: ${e.message}`); } catch {}
      }
    });
    child.onExit(({ exitCode, signal }) => finish(exitCode, signal));
  } else {
    // pipe stdin so desktop/CLI can inject messages while the worker is running
    child = spawn(cmd.cliBin, cmd.argv, {
      cwd: st.worktree?.path || st.cwd || process.cwd(),
      env: { ...process.env, ...cmd.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      try { process.stdout.write(d); } catch {}
      try { logStream.write(d); } catch {}
      const text = d.toString();
      combinedBuf = (combinedBuf + text).slice(-BUF_CAP);
      try { tryExtractSessionId(text); } catch (e) {
        try { log(`session extract error: ${e.message}`); } catch {}
      }
    });
    child.stderr.on("data", (d) => {
      try { process.stderr.write(d); } catch {}
      try { logStream.write(d); } catch {}
      const text = d.toString();
      combinedBuf = (combinedBuf + text).slice(-BUF_CAP);
      try { tryExtractSessionId(text); } catch (e) {
        try { log(`session extract error: ${e.message}`); } catch {}
      }
    });
    // Do NOT write state before finish — a setState ENOSPC here used to
    // prevent finish() from running and leave status stuck at "running".
    child.on("exit", (code, signal) => finish(code, signal));
    child.on("error", (e) => {
      try { log(`spawn error: ${e.message}`); } catch {}
      finish(1, null, e.message);
    });
    // `codex exec` treats a piped stdin as additional prompt input and waits for EOF before
    // starting the turn. Non-interactive workers already receive their full prompt in argv;
    // interactive workers use the PTY branch above when live input is required.
    if (st.type === "codex") {
      try { child.stdin.end(); } catch {}
    }
  }
} catch (e) {
  try { log(`spawn failed: ${e.stack || e.message}`); } catch {}
  finish(1, null, e.message || String(e));
}

function commitWorktree() {
  const cur = state.readState(id);
  const wt = cur.worktree?.path;
  if (!wt || !fs.existsSync(wt)) return null;
  try {
    const out = execSync(
      `git add -A && (git diff --cached --quiet || git -c user.email=orchestrator@local -c user.name=orchestrator commit -q -m "worker ${id} output")`,
      { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    // get commit sha
    const sha = execSync("git rev-parse HEAD", { cwd: wt, encoding: "utf8" }).trim();
    log(`auto-commit: ${sha}`);
    return sha;
  } catch (e) {
    log(`auto-commit failed: ${e.message}`);
    return null;
  }
}

function finish(code, signal, errMsg) {
  if (finished) return;
  finished = true;
  if (heartbeatTimer) {
    try { clearInterval(heartbeatTimer); } catch {}
    heartbeatTimer = null;
  }
  // Stop the child if it is still around (e.g. we are finishing due to a
  // supervisor-side crash like ENOSPC while the CLI is mid-turn).
  try {
    if (child) {
      if (typeof child.kill === "function") child.kill("SIGTERM");
      else if (child.pid) process.kill(child.pid, "SIGTERM");
    }
  } catch {}

  let cur = st;
  try { cur = state.readState(id) || st; } catch { cur = st; }

  const resultTail = (() => {
    try {
      return (combinedBuf || ptyDataBuf || "").split("\n").slice(-60).join("\n");
    } catch {
      return "";
    }
  })();

  let status = code === 0 && !signal ? "completed" : "failed";
  let commitSha = null;
  let failureReason = null;
  const errText = errMsg || null;

  if (status === "completed") {
    try { commitSha = commitWorktree(); } catch (e) {
      try { log(`auto-commit threw: ${e.message}`); } catch {}
    }
  } else {
    const output = [errText, resultTail, combinedBuf, ptyDataBuf].filter(Boolean).join("\n");
    try { failureReason = detectFailureReason(output, cfg); } catch {}
    if (cur.sessionId && failureReason) {
      status = "failed-resumable";
    }
  }

  const finishedAt = new Date().toISOString();
  const exitPayload = {
    status,
    exitCode: code ?? (signal ? 1 : 0),
    signal: signal || null,
    finishedAt,
    error: errText,
    failureReason: failureReason || null,
    resumable: !!cur.sessionId,
    commitSha,
  };

  // Write the exit sentinel FIRST — it is the durable record `wait` trusts.
  // Compact + ENOSPC fallback live in writeExit; never let a throw escape.
  try {
    state.writeExit(id, exitPayload);
  } catch (e) {
    try { log(`exit sentinel write failed: ${e.message}`); } catch {}
  }
  try { fs.unlinkSync(state.workerHeartbeat(id)); } catch {}

  // Full state write is best-effort. Under ENOSPC this may fail; wait/ls still
  // settle from the exit sentinel (or dead-supervisor detection).
  setStateSafe({
    status,
    exitCode: exitPayload.exitCode,
    signal: exitPayload.signal,
    finishedAt,
    error: errText,
    failureReason: failureReason || null,
    resumable: !!cur.sessionId,
    commitSha,
    resultTail: resultTail || null,
    pid: null,
  });

  try {
    log(`finished status=${status} code=${code} signal=${signal} reason=${failureReason || "-"} commit=${commitSha}`);
  } catch {}
  try { logStream.end(); } catch {}
  try { server?.close(); } catch {}
  try { fs.unlinkSync(state.workerSock(id)); } catch {}

  // Always terminate this process. A surviving supervisor with status still
  // "running" makes `wait` hang forever via pidAlive.
  process.exit(status === "completed" ? 0 : 1);
}

function canWriteToWorker() {
  if (!child) return false;
  if (cmd.usePty) return typeof child.write === "function";
  return !!(child.stdin && !child.stdin.destroyed && child.stdin.writable);
}

/** Write text into the running CLI (PTY or piped stdin). */
function writeToWorker(payload) {
  if (!child) return { ok: false, error: "no child process" };
  try {
    if (cmd.usePty && typeof child.write === "function") {
      child.write(payload);
      return { ok: true, via: "pty" };
    }
    if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
      child.stdin.write(payload);
      return { ok: true, via: "stdin" };
    }
    return { ok: false, error: "worker input is not writable" };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// IPC socket for respond/input/kill
const server = net.createServer((conn) => {
  let buf = "";
  // reply then end the connection — the client reads until newline/EOF
  const reply = (obj) => { try { conn.end(JSON.stringify(obj) + "\n"); } catch {} };
  conn.on("error", () => {});
  conn.on("data", (d) => {
    buf += d.toString();
    if (!buf.endsWith("\n")) return;
    const line = buf.trim();
    buf = "";
    let msg;
    try { msg = JSON.parse(line); } catch { reply({ ok: false, error: "bad json" }); return; }
    if (msg.cmd === "respond" || msg.cmd === "input" || msg.cmd === "message") {
      // respond: permission bridge answer; input/message: free-form text to the CLI
      const raw = msg.answer ?? msg.text ?? msg.message ?? "";
      const text = String(raw);
      if (!text) {
        reply({ ok: false, error: "empty message" });
        return;
      }
      const payload = text.endsWith("\n") ? text : text + "\n";
      const written = writeToWorker(payload);
      if (!written.ok) {
        reply(written);
        return;
      }
      if (msg.cmd === "respond") {
        setState({ status: "running", pendingPrompt: null });
      }
      log(`bridge: ${msg.cmd} sent: ${JSON.stringify(text).slice(0, 500)}`);
      reply({ ok: true, via: written.via });
    } else if (msg.cmd === "kill") {
      try { child?.kill("SIGTERM"); } catch {}
      reply({ ok: true });
    } else if (msg.cmd === "ping") {
      reply({
        ok: true,
        status: (state.readState(id) || {}).status,
        interactive: !!cmd.usePty,
        canInput: canWriteToWorker(),
      });
    } else {
      reply({ ok: false, error: "unknown cmd" });
    }
  });
});
try { fs.unlinkSync(state.workerSock(id)); } catch {}
server.listen(state.workerSock(id));
server.on("error", (e) => log(`sock error: ${e.message}`));

// keep alive
process.on("SIGTERM", () => { try { child?.kill("SIGTERM"); } catch {} });
