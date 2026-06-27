// Worker state reading + fs watching
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  ensureDirs,
  WORKERS_DIR,
  workerFile,
  workerLog,
  workerSock,
} from "./paths.js";

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const TERMINAL = new Set([
  "completed",
  "failed",
  "failed-resumable",
  "merged",
  "archived",
  "handed-off",
]);

const ACTIVE = new Set([
  "running",
  "pending",
  "awaiting-permission",
  "awaiting-question",
]);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function isActive(status) {
  return ACTIVE.has(status);
}

export function readState(id) {
  try {
    return JSON.parse(fs.readFileSync(workerFile(id), "utf8"));
  } catch {
    return null;
  }
}

export function listWorkerIds() {
  ensureDirs();
  return readdirSafe(WORKERS_DIR)
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp"))
    .map((f) => path.basename(f, ".json"));
}

export function summarize(state) {
  if (!state) return null;
  const task = (state.task || state.prompt || "").replace(/\s+/g, " ").trim();
  const repo = state.repo || state.cwd || null;
  const repoName = repo ? path.basename(repo) : "(no-repo)";
  return {
    id: state.id,
    type: state.type,
    model: state.model || null,
    effort: state.effort ?? null,
    status: state.status || "unknown",
    taskPreview: task.slice(0, 120),
    task,
    repo,
    repoName,
    cwd: state.cwd || null,
    base: state.base || null,
    branch: state.worktree?.branch || null,
    worktreePath: state.worktree?.path || null,
    sessionId: state.sessionId || null,
    interactive: !!state.interactive,
    handoffFrom: state.handoffFrom || null,
    handedOffTo: state.handedOffTo || null,
    revisionCount: state.revisionCount || 0,
    resumeCount: state.resumeCount || 0,
    failureReason: state.failureReason || null,
    error: state.error || null,
    exitCode: state.exitCode ?? null,
    commitSha: state.commitSha || null,
    createdAt: state.createdAt || null,
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    finishedAt: state.finishedAt || null,
    hasSock: fs.existsSync(workerSock(state.id)),
    hasLog: fs.existsSync(workerLog(state.id)),
    active: isActive(state.status),
    terminal: isTerminal(state.status),
  };
}

/** In-memory summary cache so UI refresh does not re-parse hundreds of idle workers. */
const summaryCache = new Map(); // id -> summary
let cachedIds = null;

export function invalidateSummaryCache(ids = null) {
  if (!ids) {
    summaryCache.clear();
    cachedIds = null;
    return;
  }
  for (const id of ids) summaryCache.delete(id);
}

export function listSummaries({ dirtyIds = null } = {}) {
  const ids = listWorkerIds();
  const idSet = new Set(ids);

  // drop cache entries for deleted workers
  if (cachedIds) {
    for (const id of summaryCache.keys()) {
      if (!idSet.has(id)) summaryCache.delete(id);
    }
  }
  cachedIds = ids;

  const needRead =
    dirtyIds && dirtyIds.length
      ? dirtyIds.filter((id) => idSet.has(id))
      : ids.filter((id) => !summaryCache.has(id));

  for (const id of needRead) {
    const s = summarize(readState(id));
    if (s) summaryCache.set(id, s);
    else summaryCache.delete(id);
  }

  return ids
    .map((id) => summaryCache.get(id))
    .filter(Boolean)
    .sort((a, b) => {
      // active first, then by updatedAt desc
      if (a.active !== b.active) return a.active ? -1 : 1;
      const ta = a.updatedAt || a.createdAt || "";
      const tb = b.updatedAt || b.createdAt || "";
      return tb.localeCompare(ta);
    });
}

export function getDetail(id) {
  const state = readState(id);
  if (!state) return null;
  const summary = summarize(state);
  // Handoff chain (walk back via handoffFrom)
  const chain = [];
  let cursor = state;
  const seen = new Set();
  while (cursor && cursor.handoffFrom && !seen.has(cursor.handoffFrom)) {
    seen.add(cursor.handoffFrom);
    const prev = readState(cursor.handoffFrom);
    if (!prev) break;
    chain.unshift(summarize(prev));
    cursor = prev;
  }
  // forward handoff
  const forward = [];
  cursor = state;
  seen.clear();
  while (cursor && cursor.handedOffTo && !seen.has(cursor.handedOffTo)) {
    seen.add(cursor.handedOffTo);
    const next = readState(cursor.handedOffTo);
    if (!next) break;
    forward.push(summarize(next));
    cursor = next;
  }
  // siblings: same repo, recent
  const siblings = listSummaries()
    .filter((s) => s.id !== id && s.repo && s.repo === summary.repo)
    .slice(0, 30);

  return {
    summary,
    state,
    chain: [...chain, summary, ...forward],
    siblings,
  };
}

export function readLogTail(id, { bytes = 256 * 1024, maxLines = 400 } = {}) {
  const file = workerLog(id);
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const start = Math.max(0, size - bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
      const lines = text.split("\n");
      const sliced = lines.length > maxLines ? lines.slice(-maxLines) : lines;
      return {
        path: file,
        size,
        truncated: start > 0 || lines.length > maxLines,
        text: sliced.join("\n"),
        mtimeMs: stat.mtimeMs,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return { path: file, size: 0, truncated: false, text: "", error: e.message, mtimeMs: 0 };
  }
}

export function groupByRepo(summaries) {
  const map = new Map();
  for (const s of summaries) {
    const key = s.repo || "(no-repo)";
    if (!map.has(key)) {
      map.set(key, {
        repo: s.repo,
        repoName: s.repoName,
        workers: [],
        activeCount: 0,
        totalCount: 0,
        latestAt: null,
      });
    }
    const g = map.get(key);
    g.workers.push(s);
    g.totalCount += 1;
    if (s.active) g.activeCount += 1;
    const t = s.updatedAt || s.createdAt;
    if (t && (!g.latestAt || t > g.latestAt)) g.latestAt = t;
  }
  return [...map.values()].sort((a, b) => {
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    return (b.latestAt || "").localeCompare(a.latestAt || "");
  });
}

/**
 * Watches workers dir for changes. Emits "change" with { ids? }.
 * Debounced so bulk writes do not flood the renderer.
 */
export class WorkerWatcher extends EventEmitter {
  constructor({ debounceMs = 250 } = {}) {
    super();
    this.debounceMs = debounceMs;
    this._timer = null;
    this._watcher = null;
    this._dirty = new Set();
  }

  start() {
    ensureDirs();
    if (this._watcher) return;
    try {
      this._watcher = fs.watch(WORKERS_DIR, { persistent: true }, (event, filename) => {
        if (filename && filename.endsWith(".json") && !filename.includes(".tmp")) {
          this._dirty.add(path.basename(filename, ".json"));
        }
        this._schedule();
      });
    } catch (e) {
      this.emit("error", e);
      // fallback poll
      this._poll = setInterval(() => this.emit("change", { ids: null }), 2000);
    }
  }

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const ids = [...this._dirty];
      this._dirty.clear();
      this.emit("change", { ids: ids.length ? ids : null });
    }, this.debounceMs);
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    if (this._poll) clearInterval(this._poll);
    try {
      this._watcher?.close();
    } catch {
      /* ignore */
    }
    this._watcher = null;
  }
}
