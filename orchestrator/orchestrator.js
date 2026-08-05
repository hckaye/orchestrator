#!/usr/bin/env node
// orchestrator.js — commander-facing CLI front
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import * as state from "./lib/state.js";
import { buildCommand, WORKER_TYPES } from "./lib/cli-adapters.js";
import * as git from "./lib/git.js";
import { buildContinuationPrompt, canResume } from "./lib/resume.js";
import { buildHandoffBriefing, collectHandoffContext } from "./lib/handoff.js";
import { pickWorkerRuntime, listModels, formatModelsTable } from "./lib/models.js";
import {
  findArchiveCandidates,
  parseAgeMs,
} from "./lib/archive.js";
import { moduleDirectory } from "./lib/paths.js";

const HERE = moduleDirectory(import.meta.url);

function usage() {
  console.log(`orchestrator — multi-CLI worker orchestration

Usage:
  orchestrator spawn <type> [opts] -- <task>     Launch a worker in a worktree
  orchestrator revise <id> [opts] -- <feedback>   Resume a worker with review feedback
  orchestrator resume <id> [opts] [-- <message>]  Resume an interrupted/failed worker
  orchestrator handoff <id> [opts]                Print cross-agent handoff briefing
  orchestrator handoff-spawn <type> [opts] --from <id> [-- <notes>]
                                                  Spawn a new worker on the same worktree with briefing
  orchestrator resumable                          List workers that can be resumed
  orchestrator ls                                 List workers
  orchestrator status <id>                        Show worker detail
  orchestrator wait <id> [--timeout S]            Block until worker idle
  orchestrator logs <id> [--tail N]               Tail worker log
  orchestrator pending                            List workers awaiting response
  orchestrator respond <id> <answer>              Answer a permission/question prompt
  orchestrator review <id>                        Show diff stat vs base
  orchestrator diff <id>                          Full diff vs base
  orchestrator merge <id> [--into branch]         Merge worker branch into integration branch
  orchestrator integrate [--into branch]          Merge all completed workers
  orchestrator finish [--head branch] [--base b]  Push integration branch + open PR
  orchestrator archive <id>                       Remove worker state + worktree
  orchestrator archive --older-than 1d [--dry-run]
                                                  Archive all finished workers older than an age
  orchestrator models [type] [--json]             List models (with effort info)
  orchestrator config [show|set <key> <value>]    View/edit config

Worker types: ${WORKER_TYPES.join(", ")}

spawn options:
  --model <m>        Override default model for the worker type
  --effort <level>   Reasoning effort: low, medium, high, xhigh, max
  --interactive      Run in PTY mode with permission bridge (respond-able)
  --worktree <slug>  Worktree slug (default: auto from id)
  --cwd <path>       Repo root (default: $PWD)
  --no-worktree      Run in current WD without creating a worktree
  --base <branch>    Base branch for worktree (default: config baseBranch or main)

Model and effort (important):
  Always pass the model and reasoning level separately to orchestrator:
    orchestrator spawn <type> --model <base-model> --effort <level> -- <task>
  Do not append -xhigh (or another effort name) to the model yourself.
  The worker adapter translates --effort for the selected CLI:
    devin        --model <m>                         effort is not supported
    codex        --model <m> -c model_reasoning_effort="<level>"
    cursor       --model <resolved-model-id>          usually <base>-<level>
                                                       or [effort=<level>]
    claude       --model <m> --effort <level>
    grok         --model <m> --effort <level>
  In particular, Codex CLI has no --effort flag, and Cursor's effort suffix
  is an underlying model ID detail; neither is part of orchestrator syntax.
  If Cursor has no matching listed variant (for example composer-2.5), it
  keeps the requested model ID unchanged.

revise options:
  --model <m>        Override model for this revision
  --effort <level>   Override reasoning effort for this revision
  --interactive      Run in PTY mode with permission bridge

resume options:
  --model <m>        Override model for this resume
  --effort <level>   Override reasoning effort for this resume
  --interactive      Run in PTY mode with permission bridge
  --force            Resume even if supervisor still appears running
  (optional message after --; default continuation prompt)

handoff options:
  --log-tail <n>     Worker log lines to include (default: 150)
  --max-diff <n>     Max diff lines in briefing (default: 400)
  --json             Output collected context as JSON instead of markdown

handoff-spawn options:
  --from <id>        Source worker to hand off from (required)
  --model <m>        Override default model for the new worker type
  --effort <level>   Override reasoning effort for the new worker
  --interactive      Run in PTY mode with permission bridge
  --archive-source   Archive the source worker after spawning
  --log-tail <n>     Passed to handoff briefing builder
  --max-diff <n>     Passed to handoff briefing builder
  (optional commander notes after --)
`);
}

function parseArgs(argv) {
  const out = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._ = out._.concat(argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.opts[key] = true;
      } else {
        out.opts[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function isSupervisorAlive(id) {
  const r = await sendSock(id, { cmd: "ping" });
  return !!r.ok;
}

const TERMINAL_STATUSES = ["completed", "failed", "failed-resumable", "merged", "archived", "handed-off"];

// Read a worker's state, folding in the exit sentinel if the supervisor
// finished but its final state write was lost. Keeps ls/status/resumable
// truthful even when no `wait` is running to do the reconciliation.
function readReconciledState(id) {
  const s = state.readState(id);
  if (!s || TERMINAL_STATUSES.includes(s.status)) return s;
  const exit = state.readExit(id);
  if (!exit?.status) return s;
  const next = { ...s, ...exit, pid: null };
  state.writeState(id, next);
  return next;
}

function sendSock(id, msg) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { conn.destroy(); } catch {}
      resolve(v);
    };
    const sock = state.workerSock(id);
    const conn = net.connect(sock, () => {
      conn.write(JSON.stringify(msg) + "\n");
    });
    let buf = "";
    const parse = () => {
      try { settle(JSON.parse(buf.trim())); } catch { settle({ ok: false, error: "bad reply" }); }
    };
    // resolve on the first complete line — older workers never close the
    // connection after replying, so waiting for "end" alone always timed out
    conn.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) parse(); });
    conn.on("end", () => parse());
    conn.on("error", (e) => settle({ ok: false, error: e.message }));
    timer = setTimeout(() => settle({ ok: false, error: "timeout" }), 5000);
  });
}

function relaunchWorker(id, nextState, logLabel) {
  // a stale exit sentinel / heartbeat from the previous run would make
  // `wait` return the old result instantly — clear before relaunching
  state.clearRunArtifacts(id);
  state.writeState(id, nextState);
  const workerLog = state.workerLog(id);
  const logFd = fs.openSync(workerLog, "a");
  const child = spawn(process.execPath, [path.join(HERE, "lib", "worker.js"), id], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: HERE,
  });
  child.unref();
  fs.appendFileSync(workerLog, `\n=== orchestrator ${logLabel} ${id} pid=${child.pid} ===\n`);
  return id;
}

function clearTerminalState(stateObj) {
  return {
    ...stateObj,
    pid: null,
    exitCode: null,
    signal: null,
    finishedAt: null,
    error: null,
    resultTail: null,
    failureReason: null,
  };
}

function archiveWorkerState(id, workerState = null) {
  const s = workerState || state.readState(id);
  if (!s) return false;
  if (s.repo && s.worktree) {
    const slug = path.basename(s.worktree.path);
    git.removeWorktree(s.repo, slug);
  }
  try { fs.unlinkSync(state.workerFile(id)); } catch {}
  try { fs.unlinkSync(state.workerSock(id)); } catch {}
  state.clearRunArtifacts(id);
  return true;
}

function workerRuntimeFromArgs(cfg, type, opts, fallbackState) {
  try {
    return pickWorkerRuntime(cfg, type, {
      model: opts.model || fallbackState?.model,
      effort: opts.effort ?? fallbackState?.effort,
    });
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) { usage(); process.exit(0); }
  const cfg = state.loadConfig();
  const args = parseArgs(rest);

  switch (cmd) {
    case "spawn": {
      const type = args._[0];
      if (!WORKER_TYPES.includes(type)) { console.error(`unknown type: ${type}`); process.exit(2); }
      const task = args._.slice(1).join(" ").trim();
      if (!task) { console.error("no task provided after --"); process.exit(2); }
      const cwd = args.opts.cwd || process.cwd();
      const repo = git.repoRoot(cwd);
      const base = args.opts.base || cfg.baseBranch || "main";
      const id = state.genId(type);
      const slug = args.opts.worktree || id;
      const prompt = task + (cfg.promptSuffix || "");
      let wt = null;
      if (!args.opts["no-worktree"]) {
        if (!repo) { console.error("not a git repo and --no-worktree not set"); process.exit(2); }
        wt = git.createWorktree(repo, slug, base);
      }
      const initState = {
        id, type,
        ...workerRuntimeFromArgs(cfg, type, args.opts),
        prompt, task, cwd, repo, base,
        worktree: wt, interactive: !!args.opts.interactive,
        status: "pending", createdAt: new Date().toISOString(),
      };
      state.writeState(id, initState);
      // launch worker.js detached
      const workerLog = state.workerLog(id);
      const logFd = fs.openSync(workerLog, "a");
      const child = spawn(process.execPath, [path.join(HERE, "lib", "worker.js"), id], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: HERE,
      });
      child.unref();
      fs.appendFileSync(workerLog, `\n=== orchestrator spawn ${id} pid=${child.pid} ===\n`);
      console.log(id);
      break;
    }
    case "revise": {
      // orchestrator revise <id> [--model <m>] [--interactive] -- <feedback>
      const id = args._[0];
      const s = state.readState(id);
      if (!s) { console.error("not found"); process.exit(1); }
      if (!s.sessionId) {
        console.error("no sessionId captured for this worker — cannot resume. Re-spawn instead.");
        process.exit(1);
      }
      const feedback = args._.slice(1).join(" ").trim();
      if (!feedback) { console.error("no feedback provided after --"); process.exit(2); }
      const revisePrompt = feedback + (cfg.promptSuffix || "");
      const nextState = clearTerminalState({
        ...s,
        mode: "resume",
        prompt: revisePrompt,
        feedback,
        status: "pending",
        interactive: args.opts.interactive ? true : s.interactive,
        ...workerRuntimeFromArgs(cfg, s.type, args.opts, s),
        revisionCount: (s.revisionCount || 0) + 1,
        revisedAt: new Date().toISOString(),
      });
      relaunchWorker(id, nextState, `revise rev=${nextState.revisionCount}`);
      console.log(id);
      break;
    }
    case "resume": {
      const id = args._[0];
      const s = readReconciledState(id);
      if (!s) { console.error("not found"); process.exit(1); }
      if (!s.sessionId) {
        console.error("no sessionId captured for this worker — cannot resume. Re-spawn instead.");
        process.exit(1);
      }
      if (!canResume(s)) {
        console.error(`worker status '${s.status}' is not resumable. Use revise for completed workers.`);
        process.exit(1);
      }
      if (s.status === "running" && !args.opts.force) {
        const alive = s.pid
          ? state.heartbeatAge(id) < 15000 || state.pidAlive(s.pid)
          : await isSupervisorAlive(id);
        if (alive) {
          console.error("worker supervisor still running. Use --force if you believe it is stuck.");
          process.exit(1);
        }
      }
      const userMessage = args._.slice(1).join(" ").trim();
      const continuation = buildContinuationPrompt(s, cfg, userMessage);
      const resumePrompt = continuation + (cfg.promptSuffix || "");
      const nextState = clearTerminalState({
        ...s,
        mode: "resume",
        prompt: resumePrompt,
        status: "pending",
        interactive: args.opts.interactive ? true : s.interactive,
        ...workerRuntimeFromArgs(cfg, s.type, args.opts, s),
        resumeCount: (s.resumeCount || 0) + 1,
        resumedAt: new Date().toISOString(),
      });
      relaunchWorker(id, nextState, `resume n=${nextState.resumeCount}`);
      console.log(id);
      break;
    }
    case "handoff": {
      const id = args._[0];
      const s = state.readState(id);
      if (!s) { console.error("not found"); process.exit(1); }
      const handoffOpts = {
        logTail: parseInt(args.opts["log-tail"] || "150", 10),
        maxDiffLines: parseInt(args.opts["max-diff"] || "400", 10),
        extra: args._.slice(1).join(" ").trim(),
      };
      if (args.opts.json) {
        console.log(JSON.stringify(collectHandoffContext(s, handoffOpts), null, 2));
      } else {
        console.log(buildHandoffBriefing(s, handoffOpts));
      }
      break;
    }
    case "handoff-spawn": {
      const type = args._[0];
      if (!WORKER_TYPES.includes(type)) { console.error(`unknown type: ${type}`); process.exit(2); }
      const fromId = args.opts.from;
      if (!fromId) { console.error("--from <id> is required"); process.exit(2); }
      const source = state.readState(fromId);
      if (!source) { console.error("source worker not found"); process.exit(1); }
      if (!source.worktree?.path) {
        console.error("source worker has no worktree — cannot hand off in place");
        process.exit(1);
      }
      const extra = args._.slice(1).join(" ").trim();
      const handoffOpts = {
        logTail: parseInt(args.opts["log-tail"] || "150", 10),
        maxDiffLines: parseInt(args.opts["max-diff"] || "400", 10),
        extra,
      };
      const briefing = buildHandoffBriefing(source, handoffOpts);
      const prompt = briefing + (cfg.promptSuffix || "");
      const id = state.genId(type);
      const initState = {
        id,
        type,
        ...workerRuntimeFromArgs(cfg, type, args.opts),
        prompt,
        task: briefing,
        cwd: source.cwd,
        repo: source.repo,
        base: source.base,
        worktree: source.worktree,
        interactive: !!args.opts.interactive,
        status: "pending",
        createdAt: new Date().toISOString(),
        handoffFrom: fromId,
      };
      state.writeState(id, initState);
      const workerLog = state.workerLog(id);
      const logFd = fs.openSync(workerLog, "a");
      const child = spawn(process.execPath, [path.join(HERE, "lib", "worker.js"), id], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: HERE,
      });
      child.unref();
      fs.appendFileSync(workerLog, `\n=== orchestrator handoff-spawn ${id} from=${fromId} pid=${child.pid} ===\n`);
      if (args.opts["archive-source"]) {
        state.writeState(fromId, { ...source, status: "handed-off", handedOffTo: id });
        try { fs.unlinkSync(state.workerSock(fromId)); } catch {}
      }
      console.log(id);
      break;
    }
    case "resumable": {
      const ids = state.listWorkers();
      const rows = ids.map((id) => readReconciledState(id)).filter((s) => s && canResume(s));
      if (!rows.length) { console.log("(none resumable)"); break; }
      console.log("ID\tTYPE\tSTATUS\tREASON\tTASK");
      for (const s of rows) {
        console.log(`${s.id}\t${s.type}\t${s.status}\t${s.failureReason || "-"}\t${s.task?.slice(0, 50) || ""}`);
      }
      break;
    }
    case "ls":
    case "list": {
      const ids = state.listWorkers();
      if (!ids.length) { console.log("(no workers)"); break; }
      const rows = ids
        .map((id) => readReconciledState(id))
        .filter(Boolean)
        .map((s) => `${s.id}\t${s.type}\t${s.status}\t${s.worktree?.branch || "-"}\t${s.task?.slice(0, 50) || ""}`);
      console.log("ID\tTYPE\tSTATUS\tBRANCH\tTASK");
      console.log(rows.join("\n"));
      break;
    }
    case "status": {
      const id = args._[0];
      const s = readReconciledState(id);
      if (!s) { console.error("not found"); process.exit(1); }
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "wait": {
      const id = args._[0];
      const timeout = (parseInt(args.opts.timeout, 10) || 0) * 1000;
      const start = Date.now();
      const TERMINAL = ["completed", "failed", "failed-resumable", "merged", "archived", "handed-off"];
      // If the state file says running but an exit sentinel exists, the
      // supervisor finished but its final state write was lost — the sentinel
      // is the durable record, so reconcile from it.
      const settleFromExit = (s, exit) => {
        if (!TERMINAL.includes(s.status)) {
          state.writeState(id, { ...s, ...exit, pid: null });
        }
        console.log(exit.status);
        process.exit(0);
      };
      let missingReads = 0;
      let deadChecks = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const s = state.readState(id);
        if (!s) {
          // tolerate a transient unreadable state file before giving up
          if (++missingReads >= 3) { console.error("not found"); process.exit(1); }
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        missingReads = 0;
        if (TERMINAL.includes(s.status)) { console.log(s.status); process.exit(0); }
        const exit = state.readExit(id);
        if (exit?.status) settleFromExit(s, exit);
        // liveness: the supervisor records its pid and touches a heartbeat
        // file every 3s. It is alive if either signal holds (heartbeat covers
        // pid reuse; pid covers a briefly-blocked event loop). Only when both
        // are gone — and still no exit sentinel — is the worker declared dead.
        let alive;
        if (s.pid) {
          alive = state.heartbeatAge(id) < 15000 || state.pidAlive(s.pid);
        } else if (s.status === "pending") {
          // supervisor not up yet; give it a startup grace period
          const born = new Date(s.createdAt || 0).getTime();
          alive = Date.now() - born < 60000;
        } else {
          // pre-pid-era worker: fall back to the IPC socket ping
          alive = await isSupervisorAlive(id);
        }
        if (alive) {
          deadChecks = 0;
        } else if (++deadChecks >= 3) {
          // one last look — the supervisor may have exited cleanly between checks
          const lastExit = state.readExit(id);
          if (lastExit?.status) settleFromExit(s, lastExit);
          state.writeState(id, {
            ...s,
            pid: null,
            status: "failed",
            failureReason: s.failureReason || "supervisor-died",
            error: s.error || "worker supervisor exited without recording a result",
            finishedAt: new Date().toISOString(),
            resumable: !!s.sessionId,
          });
          console.log("failed");
          process.exit(0);
        }
        if (timeout && Date.now() - start > timeout) { console.log("timeout"); process.exit(124); }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case "logs": {
      const id = args._[0];
      const tail = parseInt(args.opts.tail || "50", 10);
      const file = state.workerLog(id);
      try {
        const data = fs.readFileSync(file, "utf8");
        const lines = data.split("\n");
        console.log(lines.slice(-tail).join("\n"));
      } catch { console.error("no logs"); process.exit(1); }
      break;
    }
    case "pending": {
      const ids = state.listWorkers();
      const pend = ids.map((id) => state.readState(id)).filter((s) => s?.status?.startsWith("awaiting-"));
      if (!pend.length) { console.log("(none pending)"); break; }
      for (const s of pend) {
        console.log(`${s.id}\t${s.status}\t${s.type}`);
        if (s.pendingPrompt) console.log(`  prompt: ${s.pendingPrompt.split("\n").slice(-3).join(" | ")}`);
      }
      break;
    }
    case "respond": {
      const id = args._[0];
      const answer = args._.slice(1).join(" ");
      const r = await sendSock(id, { cmd: "respond", answer });
      console.log(JSON.stringify(r));
      break;
    }
    case "kill": {
      const id = args._[0];
      const r = await sendSock(id, { cmd: "kill" });
      console.log(JSON.stringify(r));
      break;
    }
    case "review": {
      const id = args._[0];
      const s = state.readState(id);
      if (!s?.repo || !s.worktree?.branch) { console.error("no worktree branch"); process.exit(1); }
      console.log(git.diffStat(s.repo, s.worktree.branch, s.base));
      break;
    }
    case "diff": {
      const id = args._[0];
      const s = state.readState(id);
      if (!s?.repo || !s.worktree?.branch) { console.error("no worktree branch"); process.exit(1); }
      console.log(git.diffFull(s.repo, s.worktree.branch, s.base));
      break;
    }
    case "merge": {
      const id = args._[0];
      const s = state.readState(id);
      if (!s?.repo || !s.worktree?.branch) { console.error("no worktree branch"); process.exit(1); }
      const into = args.opts.into || (cfg.integrationBranch || "integrate/${task}").replace("${task}", s.id);
      const r = git.mergeWorkerIntoIntegration(s.repo, s.worktree.branch, into, s.base || cfg.baseBranch);
      if (r.ok) {
        state.writeState(id, { ...s, status: "merged", integrationBranch: into });
        console.log(`merged ${s.worktree.branch} -> ${into}`);
      } else {
        console.error(`merge failed: ${r.error || r.output}`);
        process.exit(1);
      }
      break;
    }
    case "integrate": {
      const ids = state.listWorkers();
      const done = ids.map((id) => readReconciledState(id)).filter((s) => s?.status === "completed");
      if (!done.length) { console.log("(no completed workers to integrate)"); break; }
      const into = args.opts.into || (cfg.integrationBranch || "integrate/batch");
      for (const s of done) {
        const r = git.mergeWorkerIntoIntegration(s.repo, s.worktree.branch, into, s.base || cfg.baseBranch);
        if (r.ok) {
          state.writeState(s.id, { ...s, status: "merged", integrationBranch: into });
          console.log(`merged ${s.id} -> ${into}`);
        } else {
          console.error(`merge failed for ${s.id}: ${r.error || r.output}`);
        }
      }
      break;
    }
    case "finish": {
      const ids = state.listWorkers();
      const merged = ids.map((id) => state.readState(id)).filter((s) => s?.status === "merged");
      if (!merged.length) { console.log("(no merged workers)"); break; }
      const head = args.opts.head || merged[0].integrationBranch;
      const base = args.opts.base || cfg.baseBranch || "main";
      const repo = merged[0].repo;
      const r = git.pushAndPR(repo, head, base, `Integration: ${merged.map((m) => m.id).join(", ")}`);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case "archive": {
      const id = args._[0];
      if (args.opts["older-than"] !== undefined) {
        if (id) {
          console.error("do not combine a worker id with --older-than");
          process.exit(2);
        }
        const olderThanMs = parseAgeMs(args.opts["older-than"]);
        if (!olderThanMs) {
          console.error("invalid --older-than value; use a duration such as 24h or 1d");
          process.exit(2);
        }
        const now = Date.now();
        const candidates = findArchiveCandidates(
          state.listWorkers().map((workerId) => readReconciledState(workerId)).filter(Boolean),
          { olderThanMs, now }
        );
        if (!candidates.length) {
          console.log(args.opts["dry-run"] ? "(no matching workers)" : "archived 0 workers");
          break;
        }
        if (args.opts["dry-run"]) {
          for (const candidate of candidates) {
            console.log(`${candidate.id}\t${candidate.status}\t${candidate.finishedAt || candidate.updatedAt}`);
          }
          console.log(`would archive ${candidates.length} workers`);
          break;
        }
        let archived = 0;
        for (const candidate of candidates) {
          // Re-read immediately before deletion so a resumed worker is never
          // archived based on a stale list snapshot.
          const current = readReconciledState(candidate.id);
          const fresh = findArchiveCandidates(current ? [current] : [], { olderThanMs, now });
          if (!fresh.length) continue;
          if (archiveWorkerState(candidate.id, current)) {
            archived += 1;
            console.log(`archived ${candidate.id}`);
          }
        }
        console.log(`archived ${archived} workers`);
        break;
      }
      if (!id) {
        console.error("worker id or --older-than is required");
        process.exit(2);
      }
      const s = state.readState(id);
      if (!s) { console.error("not found"); process.exit(1); }
      archiveWorkerState(id, s);
      console.log(`archived ${id}`);
      break;
    }
    case "models": {
      const typeFilter = args._[0];
      if (typeFilter && !WORKER_TYPES.includes(typeFilter)) {
        console.error(`unknown type: ${typeFilter}`);
        process.exit(2);
      }
      const rows = listModels(cfg, typeFilter || null);
      console.log(formatModelsTable(rows, { json: !!args.opts.json }));
      break;
    }
    case "config": {
      const sub = args._[0];
      if (!sub || sub === "show") { console.log(JSON.stringify(cfg, null, 2)); break; }
      if (sub === "set") {
        const [k, v] = args._.slice(1);
        // shallow set via dotted path
        const parts = k.split(".");
        let obj = cfg;
        for (let i = 0; i < parts.length - 1; i++) { obj[parts[i]] = obj[parts[i]] || {}; obj = obj[parts[i]]; }
        obj[parts.at(-1)] = v;
        state.saveConfig(cfg);
        console.log("ok");
        break;
      }
      usage(); process.exit(2);
    }
    case "help":
    case "--help":
    case "-h":
    default:
      usage();
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
