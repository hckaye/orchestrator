// Discover live orchestrator-related processes on this machine
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Parse `ps` output into process records related to orchestrator workers.
 * Returns:
 *  - supervisors: worker.js <id>
 *  - waits: orchestrator wait <id>
 *  - clis: child CLIs (best-effort via ppid matching)
 */
export async function listOrchestratorProcesses() {
  let stdout = "";
  try {
    // pid, ppid, %cpu, %mem, etime, command
    const r = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,%mem=,etime=,command="], {
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    stdout = r.stdout || "";
  } catch (e) {
    return { supervisors: [], waits: [], children: [], error: e.message, scannedAt: new Date().toISOString() };
  }

  const rows = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // pid ppid cpu mem etime command...
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      mem: Number(m[4]),
      etime: m[5],
      command: m[6],
    });
  }

  const supervisors = [];
  const waits = [];

  for (const p of rows) {
    // node .../worker.js <id>
    const wm = p.command.match(/worker\.js\s+([a-z]+-\d{14}-[a-z0-9]+)/i);
    if (wm) {
      supervisors.push({
        kind: "supervisor",
        workerId: wm[1],
        pid: p.pid,
        ppid: p.ppid,
        cpu: p.cpu,
        mem: p.mem,
        etime: p.etime,
        command: p.command,
      });
      continue;
    }
    // orchestrator wait <id>  or  node .../orchestrator.js wait <id>
    const waitM = p.command.match(
      /(?:orchestrator(?:\.js)?|orchestrator)\s+wait\s+([a-z]+-\d{14}-[a-z0-9]+)/i
    );
    if (waitM) {
      waits.push({
        kind: "wait",
        workerId: waitM[1],
        pid: p.pid,
        ppid: p.ppid,
        cpu: p.cpu,
        mem: p.mem,
        etime: p.etime,
        command: p.command,
      });
    }
  }

  // Children of supervisors (CLI processes)
  const supPids = new Set(supervisors.map((s) => s.pid));
  const children = rows
    .filter((p) => supPids.has(p.ppid))
    .map((p) => {
      const parent = supervisors.find((s) => s.pid === p.ppid);
      return {
        kind: "cli",
        workerId: parent?.workerId || null,
        pid: p.pid,
        ppid: p.ppid,
        cpu: p.cpu,
        mem: p.mem,
        etime: p.etime,
        command: p.command,
        cliName: guessCliName(p.command),
      };
    });

  // Index by worker id
  const byWorker = {};
  for (const s of supervisors) {
    byWorker[s.workerId] = byWorker[s.workerId] || { supervisor: null, wait: null, children: [] };
    byWorker[s.workerId].supervisor = s;
  }
  for (const w of waits) {
    byWorker[w.workerId] = byWorker[w.workerId] || { supervisor: null, wait: null, children: [] };
    byWorker[w.workerId].wait = w;
  }
  for (const c of children) {
    if (!c.workerId) continue;
    byWorker[c.workerId] = byWorker[c.workerId] || { supervisor: null, wait: null, children: [] };
    byWorker[c.workerId].children.push(c);
  }

  return {
    supervisors,
    waits,
    children,
    byWorker,
    scannedAt: new Date().toISOString(),
  };
}

function guessCliName(command) {
  const lower = command.toLowerCase();
  if (/\bdevin\b/.test(lower)) return "devin";
  if (/\bcodex\b/.test(lower)) return "codex";
  if (/\bcursor-agent\b|\bcursor\b/.test(lower)) return "cursor";
  if (/\bclaude\b/.test(lower)) return "claude";
  if (/\bgrok\b/.test(lower)) return "grok";
  // first token that looks like a binary
  const parts = command.trim().split(/\s+/);
  const bin = parts.find((p) => !p.includes("=") && !p.startsWith("-") && !p.endsWith("node"));
  return bin ? bin.split("/").pop() : "child";
}

/**
 * Best-effort parse of supervisor pid from the worker log header lines.
 */
export function parseSupervisorPidFromLog(logText) {
  if (!logText) return null;
  const lines = logText.split("\n").slice(-200);
  let last = null;
  for (const line of lines) {
    const m = line.match(/orchestrator\s+(?:spawn|revise|resume|handoff-spawn)\s+\S+\s+pid=(\d+)/i);
    if (m) last = Number(m[1]);
  }
  return last;
}
