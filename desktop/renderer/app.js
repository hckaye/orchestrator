// Renderer — parent-scoped tabs + terminal-first live view
import { formatStreamLog } from "./stream-format.js";

const api = window.orchestrator;

const MUX_PREFIX = "mux:";
const DEFAULT_SUB = "terminal";
const SUBTABS = ["terminal", "overview", "process", "chain", "json"];

const state = {
  summaries: [],
  groups: [],
  processes: { supervisors: [], waits: [], children: [], byWorker: {} },
  root: null,
  view: "projects", // projects | flat | processes
  filterStatus: "active",
  filterType: "all",
  search: "",
  collapsed: new Set(),
  /** Currently selected parent (repo key). Tabs are scoped to this parent. */
  activeParent: null,
  openTabs: [], // worker ids and/or mux:<repo>
  activeTab: null,
  selectedSidebarId: null, // worker id highlight
  details: new Map(),
  logs: new Map(), // id -> { path, size, text, mtimeMs, truncated, error? }
  subtab: new Map(),
  logFollow: new Map(),
  logTimer: null,
};

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// —— helpers ——
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function typeColorClass(type) {
  return `type-${type || "unknown"}`;
}

function statusChip(status) {
  const s = status || "unknown";
  return `<span class="chip ${esc(s)}">${esc(s)}</span>`;
}

function relativeTime(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function parentKeyOf(w) {
  if (!w) return "(no-repo)";
  return w.repo || "(no-repo)";
}

function parentName(key) {
  if (!key || key === "(no-repo)") return "(no-repo)";
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function isMuxTab(id) {
  return typeof id === "string" && id.startsWith(MUX_PREFIX);
}

function muxIdFor(parentKey) {
  return `${MUX_PREFIX}${parentKey}`;
}

function parentOfTab(tabId) {
  if (isMuxTab(tabId)) return tabId.slice(MUX_PREFIX.length);
  const w = state.summaries.find((s) => s.id === tabId);
  return w ? parentKeyOf(w) : state.activeParent;
}

function isLive(id) {
  return !!(state.processes.byWorker && state.processes.byWorker[id]?.supervisor);
}

function matchesFilters(w) {
  if (state.filterType !== "all" && w.type !== state.filterType) return false;
  const st = w.status || "";
  switch (state.filterStatus) {
    case "all":
      break;
    case "active":
      if (!w.active) return false;
      break;
    case "awaiting":
      if (!st.startsWith("awaiting")) return false;
      break;
    case "failed":
      if (st !== "failed" && st !== "failed-resumable") return false;
      break;
    default:
      if (st !== state.filterStatus) return false;
  }
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    w.id,
    w.type,
    w.model,
    w.status,
    w.task,
    w.taskPreview,
    w.repo,
    w.repoName,
    w.sessionId,
    w.branch,
    w.handoffFrom,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

function filteredSummaries() {
  return state.summaries.filter(matchesFilters);
}

/** Workers belonging to a parent, for tab expansion. */
function workersForParent(parentKey) {
  const filtered = filteredSummaries().filter((w) => parentKeyOf(w) === parentKey);
  // Always include live supervisors under this parent even if filter hid them
  const liveIds = new Set(
    (state.processes.supervisors || [])
      .map((p) => p.workerId)
      .filter((id) => {
        const w = state.summaries.find((s) => s.id === id);
        return w && parentKeyOf(w) === parentKey;
      })
  );
  const extra = state.summaries.filter(
    (w) => liveIds.has(w.id) && !filtered.some((f) => f.id === w.id)
  );
  const all = [...filtered, ...extra];
  // stable: active/live first, then updatedAt
  return all.sort((a, b) => {
    const la = isLive(a.id) || a.active ? 1 : 0;
    const lb = isLive(b.id) || b.active ? 1 : 0;
    if (la !== lb) return lb - la;
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
}

// —— parent / tab model ——
/**
 * Select a parent project. Replaces open tabs with:
 *   [mux:parent] + related workers
 * Tabs for other parents are closed.
 */
function selectParent(parentKey, { focusId = null } = {}) {
  if (!parentKey) return;
  const related = workersForParent(parentKey);
  const relatedIds = related.map((w) => w.id);
  const muxId = muxIdFor(parentKey);

  // Close everything not in the new family
  const keep = new Set([muxId, ...relatedIds]);
  for (const id of [...state.openTabs]) {
    if (!keep.has(id)) discardTabState(id);
  }

  const nextTabs = [muxId, ...relatedIds];
  state.openTabs = nextTabs;
  state.activeParent = parentKey;

  // Defaults for new tabs
  if (!state.subtab.has(muxId)) state.subtab.set(muxId, DEFAULT_SUB);
  if (!state.logFollow.has(muxId)) state.logFollow.set(muxId, true);
  for (const id of relatedIds) {
    if (!state.subtab.has(id)) state.subtab.set(id, DEFAULT_SUB);
    if (!state.logFollow.has(id)) state.logFollow.set(id, true);
  }

  // Focus: preferred worker, else first live/active, else mux
  let focus = focusId && relatedIds.includes(focusId) ? focusId : null;
  if (!focus) {
    focus =
      relatedIds.find((id) => isLive(id)) ||
      relatedIds.find((id) => state.summaries.find((s) => s.id === id)?.active) ||
      muxId;
  }
  state.activeTab = focus;
  state.selectedSidebarId = isMuxTab(focus) ? null : focus;

  // Expand group in sidebar
  state.collapsed.delete(parentKey);

  renderSidebar();
  renderTabs();
  hydrateOpenTabs();
}

function discardTabState(id) {
  state.details.delete(id);
  state.logs.delete(id);
  state.subtab.delete(id);
  state.logFollow.delete(id);
}

/**
 * Click a worker: if its parent differs, switch parent family (closing others).
 * Same parent → just focus tab (ensure it is open).
 */
function selectWorker(id) {
  if (!id || isMuxTab(id)) return;
  const w = state.summaries.find((s) => s.id === id);
  if (!w) {
    // still try open if we only have process info
    openSingleTab(id);
    return;
  }
  const parent = parentKeyOf(w);
  if (state.activeParent !== parent) {
    selectParent(parent, { focusId: id });
    return;
  }
  // same parent — ensure tab present and focus
  if (!state.openTabs.includes(id)) {
    // insert after mux
    const mux = muxIdFor(parent);
    const idx = state.openTabs.indexOf(mux);
    if (idx >= 0) state.openTabs.splice(idx + 1, 0, id);
    else state.openTabs.unshift(id);
    if (!state.subtab.has(id)) state.subtab.set(id, DEFAULT_SUB);
    if (!state.logFollow.has(id)) state.logFollow.set(id, true);
  }
  state.activeTab = id;
  state.selectedSidebarId = id;
  renderSidebar();
  renderTabs();
  ensureDetail(id);
  ensureLog(id);
}

function openSingleTab(id) {
  if (!state.openTabs.includes(id)) {
    state.openTabs.push(id);
    if (!state.subtab.has(id)) state.subtab.set(id, DEFAULT_SUB);
    if (!state.logFollow.has(id)) state.logFollow.set(id, true);
  }
  state.activeTab = id;
  state.selectedSidebarId = id;
  renderSidebar();
  renderTabs();
  ensureDetail(id);
  ensureLog(id);
}

function closeTab(id) {
  // Never fully close mux via × if it is the parent anchor — allow close but keep parent
  const idx = state.openTabs.indexOf(id);
  if (idx < 0) return;
  state.openTabs.splice(idx, 1);
  discardTabState(id);
  if (state.activeTab === id) {
    state.activeTab = state.openTabs[Math.max(0, idx - 1)] || state.openTabs[0] || null;
  }
  if (state.selectedSidebarId === id) {
    state.selectedSidebarId = isMuxTab(state.activeTab) ? null : state.activeTab;
  }
  if (!state.openTabs.length) {
    state.activeParent = null;
  }
  renderSidebar();
  renderTabs();
}

function activateTab(id) {
  if (!state.openTabs.includes(id)) return;
  state.activeTab = id;
  state.selectedSidebarId = isMuxTab(id) ? null : id;
  renderSidebar();
  renderTabs();
  if (isMuxTab(id)) {
    hydrateMuxLogs(id);
  } else {
    ensureDetail(id);
    ensureLog(id);
  }
}

function hydrateOpenTabs() {
  for (const id of state.openTabs) {
    if (isMuxTab(id)) hydrateMuxLogs(id);
    else {
      ensureDetail(id);
      ensureLog(id);
    }
  }
}

function relatedIdsForActiveParent() {
  if (!state.activeParent) return [];
  return workersForParent(state.activeParent).map((w) => w.id);
}

// —— sidebar ——
function renderSidebar() {
  const list = $("#sidebar-list");
  const stats = $("#sidebar-stats");
  const filtered = filteredSummaries();
  const liveCount = state.processes.supervisors?.length || 0;
  const activeCount = state.summaries.filter((s) => s.active).length;

  stats.innerHTML = `
    <span>${filtered.length} shown</span>
    · <span>${activeCount} active</span>
    · <span>${liveCount} live proc</span>
    · <span class="muted">${state.summaries.length} total</span>
    ${
      state.activeParent
        ? ` · <span class="parent-pill" title="${esc(state.activeParent)}">parent: ${esc(parentName(state.activeParent))}</span>`
        : ""
    }
  `;

  if (state.view === "processes") {
    renderProcessSidebar(list);
    return;
  }

  if (state.view === "flat") {
    list.innerHTML = filtered.length
      ? filtered.map((w) => workerItemHtml(w)).join("")
      : `<div class="muted" style="padding:16px">該当なし</div>`;
    bindWorkerItems(list);
    return;
  }

  // projects view — group header selects parent
  const byRepo = new Map();
  for (const w of filtered) {
    const key = parentKeyOf(w);
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: w.repo,
        repoName: w.repoName,
        workers: [],
        activeCount: 0,
      });
    }
    const g = byRepo.get(key);
    g.workers.push(w);
    if (w.active) g.activeCount += 1;
  }
  // also surface parents that only have live procs outside filter
  for (const p of state.processes.supervisors || []) {
    const w = state.summaries.find((s) => s.id === p.workerId);
    if (!w) continue;
    const key = parentKeyOf(w);
    if (!byRepo.has(key)) {
      byRepo.set(key, {
        repo: w.repo,
        repoName: w.repoName,
        workers: [],
        activeCount: 0,
      });
    }
  }

  const groups = [...byRepo.values()].sort((a, b) => {
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    return a.repoName.localeCompare(b.repoName);
  });

  if (!groups.length) {
    list.innerHTML = `<div class="muted" style="padding:16px">該当なし</div>`;
    return;
  }

  list.innerHTML = groups
    .map((g) => {
      const key = g.repo || "(no-repo)";
      const collapsed = state.collapsed.has(key) && state.activeParent !== key;
      const selected = state.activeParent === key;
      return `
        <div class="group ${collapsed ? "collapsed" : ""} ${selected ? "parent-selected" : ""}" data-repo="${esc(key)}">
          <div class="group-header-row">
            <button type="button" class="group-chevron-btn" data-toggle-repo="${esc(key)}" title="折りたたみ">▾</button>
            <button type="button" class="group-header" data-select-parent="${esc(key)}" title="親を選択して関連タブを展開">
              <span class="group-title">
                ${esc(g.repoName)}
                <span class="group-path" title="${esc(g.repo || "")}">${esc(g.repo || "—")}</span>
              </span>
              <span class="group-count ${g.activeCount ? "active" : ""}">
                ${g.activeCount ? `${g.activeCount} · ` : ""}${g.workers.length}
              </span>
            </button>
          </div>
          <div class="group-body">
            ${g.workers.map((w) => workerItemHtml(w)).join("")}
          </div>
        </div>
      `;
    })
    .join("");

  bindWorkerItems(list);
  $$("[data-select-parent]", list).forEach((btn) => {
    btn.addEventListener("click", () => selectParent(btn.dataset.selectParent));
  });
  $$("[data-toggle-repo]", list).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.toggleRepo;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      renderSidebar();
    });
  });
}

function workerItemHtml(w) {
  const live = isLive(w.id);
  const selected =
    state.selectedSidebarId === w.id ||
    (state.activeTab === w.id && state.activeParent === parentKeyOf(w));
  const inFamily = state.activeParent === parentKeyOf(w);
  return `
    <button type="button" class="worker-item ${selected ? "selected" : ""} ${inFamily ? "in-family" : ""}" data-open-id="${esc(w.id)}">
      <span class="type-dot ${typeColorClass(w.type)}" title="${esc(w.type)}"></span>
      <span class="worker-main">
        <div class="worker-id">${esc(w.id)}${live ? ' <span class="pulse" title="supervisor alive"></span>' : ""}</div>
        <div class="worker-task" title="${esc(w.taskPreview)}">${esc(w.taskPreview || "(no task)")}</div>
      </span>
      <span class="worker-meta">
        ${statusChip(w.status)}
        <span class="muted" style="font-size:10px">${esc(relativeTime(w.updatedAt || w.createdAt))}</span>
      </span>
    </button>
  `;
}

function bindWorkerItems(root) {
  $$("[data-open-id]", root).forEach((btn) => {
    btn.addEventListener("click", () => selectWorker(btn.dataset.openId));
  });
}

function renderProcessSidebar(list) {
  const procs = [
    ...(state.processes.supervisors || []).map((p) => ({ ...p, kind: "supervisor" })),
    ...(state.processes.waits || []).map((p) => ({ ...p, kind: "wait" })),
  ].sort((a, b) => a.workerId.localeCompare(b.workerId));

  if (!procs.length) {
    list.innerHTML = `<div class="muted" style="padding:16px">起動中の orchestrator プロセスはありません</div>`;
    return;
  }

  // Group processes by parent repo
  const byParent = new Map();
  for (const p of procs) {
    const w = state.summaries.find((s) => s.id === p.workerId);
    const key = w ? parentKeyOf(w) : "(unknown)";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push({ ...p, worker: w });
  }

  list.innerHTML = [...byParent.entries()]
    .map(([key, items]) => {
      const selected = state.activeParent === key;
      return `
        <div class="group ${selected ? "parent-selected" : ""}">
          <button type="button" class="group-header" data-select-parent="${esc(key)}">
            <span class="group-chevron">▸</span>
            <span class="group-title">
              ${esc(parentName(key))}
              <span class="group-path">${esc(key)}</span>
            </span>
            <span class="group-count active">${items.length}</span>
          </button>
          <div class="group-body">
            ${items
              .map((p) => {
                const sel = state.selectedSidebarId === p.workerId;
                return `
                  <button type="button" class="proc-item ${sel ? "selected" : ""}" data-open-id="${esc(p.workerId)}">
                    <div class="proc-top">
                      <span>
                        <span class="chip live">${esc(p.kind)}</span>
                        ${p.worker ? statusChip(p.worker.status) : ""}
                      </span>
                      <span class="muted" style="font-family:var(--mono);font-size:10.5px">pid ${p.pid}</span>
                    </div>
                    <div class="worker-id" style="margin-top:4px">${esc(p.workerId)}</div>
                    <div class="proc-cmd" title="${esc(p.command)}">${esc(p.command)}</div>
                  </button>
                `;
              })
              .join("")}
          </div>
        </div>
      `;
    })
    .join("");

  bindWorkerItems(list);
  $$("[data-select-parent]", list).forEach((btn) => {
    btn.addEventListener("click", () => selectParent(btn.dataset.selectParent));
  });
}

// —— tabs render ——
function renderTabs() {
  const bar = $("#tab-bar");
  const tabs = $("#tabs");
  const empty = $("#empty-state");
  const panels = $("#tab-panels");
  const parentBar = $("#parent-bar");

  if (!state.openTabs.length) {
    bar.hidden = true;
    if (parentBar) parentBar.hidden = true;
    empty.classList.remove("hidden");
    panels.innerHTML = "";
    return;
  }

  bar.hidden = false;
  empty.classList.add("hidden");
  if (parentBar) {
    parentBar.hidden = false;
    parentBar.innerHTML = state.activeParent
      ? `<span class="parent-bar-label">Parent</span>
         <span class="parent-bar-name" title="${esc(state.activeParent)}">${esc(parentName(state.activeParent))}</span>
         <span class="parent-bar-path muted">${esc(state.activeParent)}</span>
         <span class="parent-bar-count">${state.openTabs.filter((t) => !isMuxTab(t)).length} workers</span>`
      : "";
  }

  tabs.innerHTML = state.openTabs
    .map((id) => {
      const active = state.activeTab === id;
      if (isMuxTab(id)) {
        return `
          <div class="tab mux-tab ${active ? "active" : ""}" data-tab-id="${esc(id)}" title="All terminals for parent">
            <span class="mux-icon">▣</span>
            <span class="tab-label">All terminals</span>
          </div>
        `;
      }
      const w = state.summaries.find((s) => s.id === id);
      const live = isLive(id);
      return `
        <div class="tab ${active ? "active" : ""}" data-tab-id="${esc(id)}" title="${esc(id)}">
          <span class="type-dot ${typeColorClass(w?.type)}" style="width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0"></span>
          <span class="tab-label">${esc(shortId(id))}${live ? " ●" : ""}</span>
          <button type="button" class="tab-close" data-close-id="${esc(id)}" title="Close">×</button>
        </div>
      `;
    })
    .join("");

  $$("[data-tab-id]", tabs).forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close-id]")) return;
      activateTab(el.dataset.tabId);
    });
  });
  $$("[data-close-id]", tabs).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(btn.dataset.closeId);
    });
  });

  const existing = new Set($$(".panel", panels).map((p) => p.dataset.panelId));
  for (const id of state.openTabs) {
    if (!existing.has(id)) {
      const div = document.createElement("div");
      div.className = "panel";
      div.dataset.panelId = id;
      panels.appendChild(div);
    }
  }
  $$(".panel", panels).forEach((p) => {
    if (!state.openTabs.includes(p.dataset.panelId)) p.remove();
  });

  $$(".panel", panels).forEach((p) => {
    const id = p.dataset.panelId;
    const active = id === state.activeTab;
    p.classList.toggle("active", active);
    if (active) renderPanel(p, id);
  });
}

function shortId(id) {
  // type-timestamp-rand → keep readable
  if (!id) return id;
  const m = id.match(/^([a-z]+)-(\d{8})(\d{6})-([a-z0-9]+)$/i);
  if (m) return `${m[1]}-${m[3]}-${m[4]}`;
  return id.length > 28 ? id.slice(0, 26) + "…" : id;
}

// —— data fetch ——
async function ensureDetail(id) {
  if (isMuxTab(id)) return;
  try {
    const d = await api.getDetail(id);
    if (d) {
      state.details.set(id, d);
      softRefreshActiveIf(id);
    }
  } catch (e) {
    console.error(e);
  }
}

async function ensureLog(id) {
  if (isMuxTab(id)) return;
  try {
    // More raw lines for token-stream coalescing; formatter collapses them.
    const log = await api.getLog(id, { bytes: 512 * 1024, maxLines: 4000 });
    const prev = state.logs.get(id);
    state.logs.set(id, log);
    // Incremental terminal update when possible
    if (state.activeTab === id) {
      const panel = panelEl(id);
      if (!panel) return;
      const sub = state.subtab.get(id) || DEFAULT_SUB;
      if (sub === "terminal" || sub === "logs") {
        const term = $(".term-body", panel) || $(".log-box", panel);
        if (term && prev && prev.text && log.text && log.text.startsWith(prev.text.slice(-2000).slice(0, 100))) {
          // full replace is simpler and reliable for tail windows
        }
        updateTerminalBody(panel, id, log);
        return;
      }
    }
    // also refresh mux panes for this worker
    if (state.activeTab && isMuxTab(state.activeTab)) {
      const panel = panelEl(state.activeTab);
      if (panel) updateMuxPane(panel, id, log);
    }
  } catch (e) {
    console.error(e);
  }
}

async function hydrateMuxLogs(muxId) {
  const parent = parentOfTab(muxId);
  const ids = workersForParent(parent).map((w) => w.id);
  await Promise.all(ids.map((id) => ensureLog(id)));
  softRefreshActiveIf(muxId);
}

function panelEl(id) {
  return $(`.panel[data-panel-id="${CSS.escape(id)}"]`);
}

function softRefreshActiveIf(id) {
  if (state.activeTab !== id) return;
  const panel = panelEl(id);
  if (!panel) return;
  // Avoid full re-render while watching the terminal stream (preserves scroll).
  if (isMuxTab(id)) {
    // only rebuild mux if panes missing
    if (!$(".mux-grid", panel)) renderPanel(panel, id);
    return;
  }
  const sub = state.subtab.get(id) || DEFAULT_SUB;
  if (sub === "terminal") {
    const log = state.logs.get(id);
    if (log && $(".term-body", panel)) {
      updateTerminalBody(panel, id, log);
      // light status chip refresh
      const chipHost = $(".panel-actions", panel);
      const s = state.summaries.find((x) => x.id === id);
      if (chipHost && s) {
        const first = chipHost.querySelector(".chip");
        if (first && !first.classList.contains("live")) {
          first.className = `chip ${s.status || "unknown"}`;
          first.textContent = s.status || "unknown";
        }
      }
      return;
    }
  }
  renderPanel(panel, id);
}

function workerTypeOf(id) {
  return state.summaries.find((s) => s.id === id)?.type || null;
}

function formatTerminalHtml(text, { live = false, workerType = null } = {}) {
  return formatStreamLog(text, { live, workerType, maxBlocks: 350 });
}

function isSessionActive(id, summary) {
  const s = summary || state.summaries.find((x) => x.id === id);
  if (isLive(id)) return true;
  const st = s?.status || "";
  return st === "running" || st === "pending" || st.startsWith("awaiting-");
}

function updateTerminalBody(panel, id, log) {
  const body = $(".term-body", panel);
  if (!body) {
    renderPanel(panel, id);
    return;
  }
  const follow = state.logFollow.get(id) !== false;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  const active = isSessionActive(id);
  body.innerHTML = formatTerminalHtml(log?.text || "", {
    live: active,
    workerType: workerTypeOf(id),
  });
  // strip stream-format's own cursor; footer spinner owns the live affordance
  $$(".term-cursor", body).forEach((el) => el.remove());
  const meta = $(".term-meta", panel);
  if (meta && log) {
    meta.textContent = metaLine(log);
  }
  syncTermFooter(panel, id);
  if (follow || atBottom) body.scrollTop = body.scrollHeight;
}

function syncTermFooter(panel, id) {
  const footer = $(".term-footer", panel);
  if (!footer) return;
  const s = state.summaries.find((x) => x.id === id);
  const active = isSessionActive(id, s);
  const spinner = $(".term-spinner-row", footer);
  if (spinner) spinner.classList.toggle("hidden", !active);
  const statusEl = $(".term-input-hint", footer);
  if (statusEl) {
    statusEl.textContent = inputHintFor(s, active);
  }
  const input = $(".term-input", footer);
  if (input) {
    input.disabled = false;
    input.placeholder = active
      ? "メッセージを送る… (Enter)"
      : s?.sessionId
        ? "フィードバックを送る (revise)… (Enter)"
        : "sessionId がないため送信できません";
    if (!s?.sessionId && !active) input.disabled = true;
  }
}

function inputHintFor(s, active) {
  if (!s) return "";
  if (active) {
    if (s.status?.startsWith("awaiting-")) return "permission / question への応答として送信";
    if (s.interactive) return "PTY に入力";
    return "実行中プロセスへ送信 (対応 CLI のみ)";
  }
  if (s.sessionId) return "完了済み → revise で再開";
  return "送信不可";
}

function updateMuxPane(panel, workerId, log) {
  const pane = $(`.mux-pane[data-worker-id="${CSS.escape(workerId)}"]`, panel);
  if (!pane) return;
  const body = $(".term-body", pane);
  if (!body) return;
  const follow = state.logFollow.get(muxIdFor(state.activeParent)) !== false;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.innerHTML = formatTerminalHtml(log?.text || "", {
    live: isLive(workerId),
    workerType: workerTypeOf(workerId),
  });
  const st = $(".mux-pane-status", pane);
  const w = state.summaries.find((s) => s.id === workerId);
  if (st && w) st.innerHTML = statusChip(w.status);
  if (follow || atBottom) body.scrollTop = body.scrollHeight;
}

function metaLine(log) {
  if (!log) return "";
  const size = log.size ? `${(log.size / 1024).toFixed(0)} KB` : "";
  const trunc = log.truncated ? "truncated · " : "";
  return `${trunc}${size}`;
}

// —— panel render ——
function renderPanel(panel, id) {
  if (isMuxTab(id)) {
    renderMuxPanel(panel, id);
    return;
  }

  const detail = state.details.get(id);
  const summary = detail?.summary || state.summaries.find((s) => s.id === id);
  const sub = state.subtab.get(id) || DEFAULT_SUB;
  const live = isLive(id);
  const proc = state.processes.byWorker?.[id];

  if (!summary && !detail) {
    panel.innerHTML = `<div class="panel-body muted">Loading ${esc(id)}…</div>`;
    return;
  }

  const s = summary || {};
  const isTerm = sub === "terminal";
  panel.innerHTML = `
    <div class="panel-header ${isTerm ? "panel-header-compact" : ""}">
      <div class="panel-title-row">
        <div>
          <h2 class="panel-title">
            ${esc(s.id || id)}
            ${live ? '<span class="pulse" title="supervisor process alive"></span>' : ""}
          </h2>
          ${
            isTerm
              ? ""
              : `<div class="panel-sub" title="${esc(s.task || "")}">${esc(s.taskPreview || s.task || "")}</div>`
          }
        </div>
        <div class="panel-actions">
          ${statusChip(s.status)}
          ${s.type ? `<span class="chip" style="border-color:var(--border)">${esc(s.type)}</span>` : ""}
          ${live ? `<span class="chip live">live</span>` : ""}
          <button type="button" class="btn ghost" data-action="refresh" data-id="${esc(id)}">Refresh</button>
          ${s.worktreePath ? `<button type="button" class="btn" data-action="open-wt" data-path="${esc(s.worktreePath)}">Worktree</button>` : ""}
          ${s.hasLog ? `<button type="button" class="btn" data-action="show-log" data-id="${esc(id)}">Log file</button>` : ""}
        </div>
      </div>
      <div class="worker-toolbar" data-worker-toolbar="${esc(id)}">
        <button type="button" class="btn tool" data-worker-action="revise" data-id="${esc(id)}" ${s.sessionId ? "" : "disabled"} title="session にフィードバックを送って再開">Revise…</button>
        <button type="button" class="btn tool" data-worker-action="resume" data-id="${esc(id)}" ${s.sessionId ? "" : "disabled"} title="中断/失敗から同じ session で再開">Resume</button>
        <button type="button" class="btn tool danger" data-worker-action="force-fail" data-id="${esc(id)}" title="プロセスを強制終了し failed にする">Kill (fail)</button>
        <button type="button" class="btn tool danger" data-worker-action="archive" data-id="${esc(id)}" title="worktree と state を削除">Archive</button>
        <span class="tool-status" data-tool-status="${esc(id)}" hidden></span>
      </div>
      <div class="subtabs">
        ${SUBTABS.map(
          (name) =>
            `<button type="button" class="subtab ${sub === name ? "active" : ""}" data-subtab="${name}" data-id="${esc(id)}">${labelSub(name)}</button>`
        ).join("")}
      </div>
    </div>
    <div class="panel-body ${isTerm ? "term-panel-body" : ""}" data-body-for="${esc(id)}">
      ${renderSubview(id, sub, detail, s, proc)}
    </div>
  `;

  bindPanelEvents(panel, id);
  if (isTerm) {
    const term = $(".term-body", panel);
    if (term && state.logFollow.get(id) !== false) term.scrollTop = term.scrollHeight;
  }
}

function renderMuxPanel(panel, muxId) {
  const parent = parentOfTab(muxId);
  const workers = workersForParent(parent);
  const follow = state.logFollow.get(muxId) !== false;

  panel.innerHTML = `
    <div class="panel-header panel-header-compact">
      <div class="panel-title-row">
        <div>
          <h2 class="panel-title">All terminals · ${esc(parentName(parent))}</h2>
          <div class="panel-sub">${workers.length} workers · live stream of parent + sub workers</div>
        </div>
        <div class="panel-actions">
          <label class="muted follow-label">
            <input type="checkbox" data-log-follow ${follow ? "checked" : ""} /> follow
          </label>
          <button type="button" class="btn ghost" data-action="refresh-mux">Refresh</button>
        </div>
      </div>
    </div>
    <div class="panel-body mux-grid-body">
      ${
        workers.length
          ? `<div class="mux-grid cols-${Math.min(workers.length, 3)}">
              ${workers.map((w) => muxPaneHtml(w)).join("")}
            </div>`
          : `<div class="muted" style="padding:24px">この親に紐づく worker がありません（フィルタを確認）</div>`
      }
    </div>
  `;

  $$(".mux-pane-head", panel).forEach((head) => {
    head.addEventListener("click", () => {
      const id = head.closest(".mux-pane")?.dataset.workerId;
      if (id) selectWorker(id);
    });
  });
  const followEl = $("[data-log-follow]", panel);
  if (followEl) {
    followEl.addEventListener("change", () => {
      state.logFollow.set(muxId, followEl.checked);
    });
  }
  $("[data-action='refresh-mux']", panel)?.addEventListener("click", () => {
    hydrateMuxLogs(muxId);
  });

  // scroll all panes to bottom if follow
  if (follow) {
    $$(".term-body", panel).forEach((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

function muxPaneHtml(w) {
  const log = state.logs.get(w.id);
  const live = isLive(w.id);
  return `
    <div class="mux-pane" data-worker-id="${esc(w.id)}">
      <button type="button" class="mux-pane-head">
        <span class="type-dot ${typeColorClass(w.type)}"></span>
        <span class="mux-pane-id">${esc(shortId(w.id))}</span>
        <span class="mux-pane-status">${statusChip(w.status)}</span>
        ${live ? '<span class="pulse"></span>' : ""}
      </button>
      <div class="term-window mux-term">
        <div class="term-body">${formatTerminalHtml(log?.text || (log ? "" : "…"), {
          live,
          workerType: w.type,
        })}</div>
      </div>
    </div>
  `;
}

function bindPanelEvents(panel, id) {
  $$("[data-subtab]", panel).forEach((btn) => {
    btn.addEventListener("click", () => {
      state.subtab.set(id, btn.dataset.subtab);
      if (btn.dataset.subtab === "terminal" || btn.dataset.subtab === "logs") ensureLog(id);
      renderPanel(panel, id);
    });
  });
  $$("[data-action]", panel).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      if (action === "refresh") {
        await Promise.all([ensureDetail(id), ensureLog(id)]);
        renderPanel(panel, id);
      } else if (action === "open-wt" && btn.dataset.path) {
        await api.openPath(btn.dataset.path);
      } else if (action === "show-log") {
        const log = state.logs.get(id) || (await api.getLog(id));
        if (log?.path) await api.showItem(log.path);
      }
    });
  });
  $$("[data-open-id]", panel).forEach((btn) => {
    btn.addEventListener("click", () => selectWorker(btn.dataset.openId));
  });
  const follow = $("[data-log-follow]", panel);
  if (follow) {
    follow.addEventListener("change", () => {
      state.logFollow.set(id, follow.checked);
    });
  }
  const clearBtn = $("[data-clear-term]", panel);
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      const body = $(".term-body", panel);
      if (body) body.innerHTML = "";
    });
  }
  bindTermSend(panel, id);
  bindWorkerToolbar(panel, id);
}

function setToolStatus(panel, id, kind, text) {
  const el = $(`[data-tool-status="${CSS.escape(id)}"]`, panel);
  if (!el) return;
  el.hidden = !text;
  el.className = `tool-status ${kind || ""}`;
  el.textContent = text || "";
}

function bindWorkerToolbar(panel, id) {
  $$("[data-worker-action]", panel).forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const action = btn.dataset.workerAction;
      await runWorkerAction(panel, id, action);
    });
  });
}

async function runWorkerAction(panel, id, action) {
  const s = state.summaries.find((x) => x.id === id);
  const termInput = $(`[data-term-input="${CSS.escape(id)}"]`, panel);

  if (action === "revise") {
    let feedback = termInput?.value?.trim() || "";
    if (!feedback) {
      feedback = window.prompt(
        "Revise feedback（worker への修正指示）:",
        ""
      );
    }
    if (!feedback || !feedback.trim()) return;
    if (
      isSessionActive(id, s) &&
      !window.confirm("実行中です。いったん fail 扱いにしてから revise します。続行しますか？")
    ) {
      return;
    }
    setToolStatus(panel, id, "pending", "revising…");
    const res = await api.revise(id, feedback.trim());
    if (res?.ok) {
      if (termInput) termInput.value = "";
      setToolStatus(panel, id, "ok", "revise 開始");
      await afterWorkerMutation(id, panel);
    } else {
      setToolStatus(panel, id, "err", res?.error || "revise failed");
    }
    return;
  }

  if (action === "resume") {
    if (!window.confirm(`Resume ${id}？\n（同じ session で継続）`)) return;
    const msg = termInput?.value?.trim() || "";
    setToolStatus(panel, id, "pending", "resuming…");
    const res = await api.resume(id, msg);
    if (res?.ok) {
      if (termInput && msg) termInput.value = "";
      setToolStatus(panel, id, "ok", "resume 開始");
      await afterWorkerMutation(id, panel);
    } else {
      setToolStatus(panel, id, "err", res?.error || "resume failed");
    }
    return;
  }

  if (action === "force-fail") {
    if (
      !window.confirm(
        `Kill (fail) ${id}？\nプロセスを強制終了し status=failed にします。\nsessionId があれば後から resume/revise 可能です。`
      )
    ) {
      return;
    }
    setToolStatus(panel, id, "pending", "killing…");
    const res = await api.forceFail(id);
    if (res?.ok) {
      setToolStatus(panel, id, "ok", `failed (${res.status || "ok"})`);
      await afterWorkerMutation(id, panel);
    } else {
      setToolStatus(panel, id, "err", res?.error || "kill failed");
    }
    return;
  }

  if (action === "archive") {
    if (
      !window.confirm(
        `Archive ${id}？\nworktree と state を削除します（ログは残ります）。\nこの操作は取り消せません。`
      )
    ) {
      return;
    }
    setToolStatus(panel, id, "pending", "archiving…");
    const res = await api.archive(id);
    if (res?.ok) {
      setToolStatus(panel, id, "ok", "archived");
      // close tab — worker gone
      closeTab(id);
      // refresh list
      try {
        const w = await api.listWorkers();
        applyWorkersPayload(w);
      } catch {
        /* ignore */
      }
    } else {
      setToolStatus(panel, id, "err", res?.error || "archive failed");
    }
  }
}

async function afterWorkerMutation(id, panel) {
  try {
    const w = await api.listWorkers();
    applyWorkersPayload(w);
  } catch {
    /* ignore */
  }
  await Promise.all([ensureDetail(id), ensureLog(id)]);
  const p = panel || panelEl(id);
  if (p && state.activeTab === id) renderPanel(p, id);
}

function bindTermSend(panel, id) {
  const form = $(`[data-send-form="${CSS.escape(id)}"]`, panel);
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "1";

  const doSend = async (forceRevise) => {
    const input = $(".term-input", form);
    const statusEl = $(`[data-send-status="${CSS.escape(id)}"]`, panel);
    if (!input || input.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    input.disabled = true;
    $$(".term-send-btn", form).forEach((b) => {
      b.disabled = true;
    });
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "term-send-status pending";
      statusEl.textContent = forceRevise ? "revising…" : "sending…";
    }
    try {
      const res = forceRevise
        ? await api.revise(id, text)
        : await api.sendMessage(id, text);
      if (res?.ok) {
        input.value = "";
        if (statusEl) {
          statusEl.className = "term-send-status ok";
          statusEl.textContent =
            res.mode === "revise"
              ? "revise で再開しました"
              : res.mode === "respond"
                ? "応答を送信しました"
                : `送信しました${res.via ? ` (${res.via})` : ""}`;
        }
        setTimeout(() => ensureLog(id), 300);
        if (forceRevise || res.mode === "revise") {
          await afterWorkerMutation(id, panel);
        }
      } else {
        if (statusEl) {
          statusEl.className = "term-send-status err";
          statusEl.textContent = res?.error || "送信に失敗しました";
        }
      }
    } catch (err) {
      if (statusEl) {
        statusEl.className = "term-send-status err";
        statusEl.textContent = err.message || String(err);
      }
    } finally {
      const s = state.summaries.find((x) => x.id === id);
      const active = isSessionActive(id, s);
      const canSend = active || !!s?.sessionId;
      input.disabled = !canSend;
      $$(".term-send-btn", form).forEach((b) => {
        if (b.dataset.forceRevise != null) b.disabled = !s?.sessionId;
        else b.disabled = !canSend;
      });
      input.focus();
    }
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await doSend(false);
  });
  const forceBtn = $(`[data-force-revise="${CSS.escape(id)}"]`, form);
  if (forceBtn) {
    forceBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await doSend(true);
    });
  }
}

function labelSub(name) {
  return {
    terminal: "Terminal",
    overview: "Overview",
    process: "Process",
    chain: "Chain",
    json: "JSON",
  }[name] || name;
}

function renderSubview(id, sub, detail, s, proc) {
  switch (sub) {
    case "terminal":
      return renderTerminal(id, s);
    case "process":
      return renderProcessView(id, s, proc);
    case "chain":
      return renderChainView(id, detail, s);
    case "json":
      return `<div class="json-box">${esc(JSON.stringify(detail?.state || s, null, 2))}</div>`;
    case "overview":
      return renderOverview(id, detail, s, proc);
    default:
      return renderTerminal(id, s);
  }
}

function renderTerminal(id, s) {
  const log = state.logs.get(id);
  const follow = state.logFollow.get(id) !== false;
  const active = isSessionActive(id, s);
  const parent = s ? parentKeyOf(s) : state.activeParent;
  const parentWorker = s?.handoffFrom
    ? state.summaries.find((x) => x.id === s.handoffFrom)
    : null;
  const canSend = active || !!s?.sessionId;

  if (!log) {
    return `
      <div class="term-window">
        <div class="term-chrome">
          <span class="term-dots"><i></i><i></i><i></i></span>
          <span class="term-title">${esc(id)} — loading…</span>
        </div>
        <div class="term-body"><span class="term-dim">connecting to log stream…</span></div>
        ${termFooterHtml(id, s, active, canSend)}
      </div>
    `;
  }

  const bodyHtml = formatTerminalHtml(log.text || "", {
    live: active,
    workerType: s?.type || workerTypeOf(id),
  }).replace(/<span class="term-cursor"><\/span>/g, "");

  return `
    <div class="term-window">
      <div class="term-chrome">
        <span class="term-dots"><i></i><i></i><i></i></span>
        <span class="term-title">
          ${esc(s?.type || "worker")}@${esc(shortId(id))}
          ${active ? " · live" : ""}
        </span>
        <span class="term-meta">${esc(metaLine(log))}</span>
        <label class="term-follow">
          <input type="checkbox" data-log-follow ${follow ? "checked" : ""} /> follow
        </label>
      </div>
      ${
        parentWorker
          ? `<div class="term-parent-banner">
               parent worker:
               <button type="button" class="linkish" data-open-id="${esc(parentWorker.id)}">${esc(shortId(parentWorker.id))}</button>
               ${statusChip(parentWorker.status)}
               <span class="term-dim">${esc((parentWorker.taskPreview || "").slice(0, 80))}</span>
             </div>`
          : parent
            ? `<div class="term-parent-banner">
                 parent project: <span class="term-accent">${esc(parentName(parent))}</span>
                 <span class="term-dim">${esc(parent)}</span>
               </div>`
            : ""
      }
      <div class="term-body">${bodyHtml}</div>
      <div class="term-task-bar" title="${esc(s?.task || "")}">
        <span class="term-dim">task</span> ${esc((s?.taskPreview || s?.task || "").slice(0, 160))}
      </div>
      ${termFooterHtml(id, s, active, canSend)}
    </div>
  `;
}

function termFooterHtml(id, s, active, canSend) {
  return `
    <div class="term-footer" data-worker-id="${esc(id)}">
      <div class="term-spinner-row ${active ? "" : "hidden"}" aria-live="polite">
        <span class="term-spinner" aria-hidden="true"></span>
        <span class="term-spinner-label">
          ${esc(s?.status || "running")}
          <span class="term-spinner-dots"></span>
        </span>
      </div>
      <form class="term-input-row" data-send-form="${esc(id)}">
        <span class="term-input-prompt">&gt;</span>
        <input
          type="text"
          class="term-input"
          data-term-input="${esc(id)}"
          autocomplete="off"
          spellcheck="false"
          ${canSend ? "" : "disabled"}
          placeholder="${
            active
              ? "メッセージを送る… (Enter)  /  Revise にも使えます"
              : s?.sessionId
                ? "フィードバック (Enter で revise)…"
                : "sessionId がないため送信できません"
          }"
        />
        <button type="submit" class="term-send-btn" ${canSend ? "" : "disabled"} title="実行中なら入力、停止中なら revise">Send</button>
        <button type="button" class="term-send-btn secondary" data-force-revise="${esc(id)}" ${s?.sessionId ? "" : "disabled"} title="必ず revise で送る">Revise</button>
      </form>
      <div class="term-input-hint">${esc(inputHintFor(s, active))}</div>
      <div class="term-send-status" data-send-status="${esc(id)}" hidden></div>
    </div>
  `;
}

function renderOverview(id, detail, s, proc) {
  const rows = [
    ["Status", s.status],
    ["Type / Model", [s.type, s.model, s.effort != null ? `effort=${s.effort}` : null].filter(Boolean).join(" · ")],
    ["Session ID", s.sessionId || "—"],
    ["Repo", s.repo || "—"],
    ["Branch", s.branch || "—"],
    ["Base", s.base || "—"],
    ["Worktree", s.worktreePath || "—"],
    ["Created", fmtTs(s.createdAt)],
    ["Updated", fmtTs(s.updatedAt)],
    ["Finished", fmtTs(s.finishedAt)],
    ["Revisions", String(s.revisionCount || 0)],
    ["Resumes", String(s.resumeCount || 0)],
    ["Commit", s.commitSha || "—"],
    ["Exit", s.exitCode != null ? String(s.exitCode) : "—"],
    ["Failure", s.failureReason || s.error || "—"],
    ["Supervisor", proc?.supervisor ? `pid ${proc.supervisor.pid} · cpu ${proc.supervisor.cpu}%` : "not running"],
    ["Waiters", proc?.wait ? `pid ${proc.wait.pid}` : "—"],
    ["CLI children", proc?.children?.length ? proc.children.map((c) => `${c.cliName}#${c.pid}`).join(", ") : "—"],
  ];

  return `
    <div class="kv-grid">
      ${rows
        .map(
          ([k, v]) => `
        <div class="kv">
          <div class="k">${esc(k)}</div>
          <div class="v">${esc(v)}</div>
        </div>`
        )
        .join("")}
    </div>
    <div class="section-title">Task</div>
    <div class="task-box">${esc(s.task || detail?.state?.task || "(empty)")}</div>
    ${
      detail?.state?.feedback
        ? `<div class="section-title">Latest feedback (revise)</div>
           <div class="task-box">${esc(detail.state.feedback)}</div>`
        : ""
    }
  `;
}

function renderProcessView(id, s, proc) {
  if (!proc?.supervisor && !proc?.wait && !(proc?.children?.length)) {
    return `
      <p class="muted">
        この worker に紐づく起動中プロセスは見つかりません。
        状態は <code>${esc(s.status || "?")}</code>、
        socket ${s.hasSock ? "あり" : "なし"}。
      </p>
    `;
  }
  const rows = [];
  if (proc.supervisor) rows.push(procRow("supervisor", proc.supervisor, false));
  for (const c of proc.children || []) rows.push(procRow(`cli · ${c.cliName}`, c, true));
  if (proc.wait) rows.push(procRow("orchestrator wait", proc.wait, false));
  return `
    <div class="section-title">Process tree (live)</div>
    <div class="proc-tree">${rows.join("")}</div>
  `;
}

function procRow(label, p, child) {
  return `
    <div class="row ${child ? "child" : ""}">
      <div>
        <div class="label">${esc(label)}</div>
        <div>pid ${p.pid}</div>
      </div>
      <div>
        <div class="label">cpu / mem</div>
        <div>${p.cpu}% / ${p.mem}%</div>
      </div>
      <div>
        <div class="label">etime ${esc(p.etime || "")}</div>
        <div class="cmd" title="${esc(p.command)}">${esc(p.command)}</div>
      </div>
    </div>
  `;
}

function renderChainView(id, detail, s) {
  const chain = detail?.chain || [s];
  const siblings = (detail?.siblings || []).slice(0, 20);

  const chainHtml =
    chain.length <= 1
      ? `<p class="muted">handoff チェーンはありません。</p>`
      : `<div class="chain">
          ${chain
            .map((node, i) => {
              const cur = node.id === id;
              return `
                ${i ? `<span class="chain-arrow">→</span>` : ""}
                <button type="button" class="chain-node ${cur ? "current" : ""}" data-open-id="${esc(node.id)}">
                  <div class="id">${esc(node.id)}</div>
                  <div class="st">${statusChip(node.status)} <span class="muted">${esc(node.type)}</span></div>
                </button>
              `;
            })
            .join("")}
        </div>`;

  return `
    <div class="section-title">Parent context (project)</div>
    <div class="kv-grid">
      <div class="kv"><div class="k">Repository</div><div class="v">${esc(s.repo || "—")}</div></div>
      <div class="kv"><div class="k">CWD</div><div class="v">${esc(s.cwd || "—")}</div></div>
      <div class="kv"><div class="k">Base branch</div><div class="v">${esc(s.base || "—")}</div></div>
      <div class="kv"><div class="k">Handoff from</div><div class="v">${esc(s.handoffFrom || "—")}</div></div>
    </div>
    <div class="section-title">Handoff chain</div>
    ${chainHtml}
    <div class="section-title">Siblings in same project</div>
    ${
      siblings.length
        ? `<div class="sibling-list">
            ${siblings
              .map(
                (sib) => `
              <button type="button" class="sibling-btn" data-open-id="${esc(sib.id)}">
                <span>
                  <span class="worker-id">${esc(sib.id)}</span>
                  <span class="muted" style="margin-left:8px">${esc((sib.taskPreview || "").slice(0, 60))}</span>
                </span>
                ${statusChip(sib.status)}
              </button>`
              )
              .join("")}
          </div>`
        : `<p class="muted">同リポジトリの他 worker はありません。</p>`
    }
  `;
}

function fmtTs(iso) {
  if (!iso) return "—";
  try {
    return `${new Date(iso).toLocaleString()} (${relativeTime(iso)})`;
  } catch {
    return iso;
  }
}

// —— live badge / polling ——
function updateLiveBadge() {
  const n = state.processes.supervisors?.length || 0;
  const badge = $("#live-badge");
  badge.textContent = n ? `${n} live` : "idle";
  badge.classList.toggle("has-live", n > 0);
}

function startLogPolling() {
  if (state.logTimer) clearInterval(state.logTimer);
  state.logTimer = setInterval(() => {
    if (!state.activeTab) return;
    if (isMuxTab(state.activeTab)) {
      const parent = parentOfTab(state.activeTab);
      const ids = workersForParent(parent).map((w) => w.id);
      // poll live/active first
      const priority = ids.filter((id) => isLive(id) || state.summaries.find((s) => s.id === id)?.active);
      const rest = ids.filter((id) => !priority.includes(id));
      [...priority, ...rest].slice(0, 12).forEach((id) => ensureLog(id));
      return;
    }
    const sub = state.subtab.get(state.activeTab) || DEFAULT_SUB;
    if (sub === "terminal" || sub === "logs") {
      ensureLog(state.activeTab);
    }
  }, 900);
}

// —— data wiring ——
function applyWorkersPayload(payload) {
  if (!payload) return;
  state.summaries = payload.summaries || [];
  state.groups = payload.groups || [];
  state.root = payload.root || state.root;

  // If a parent is selected, keep tabs in sync with related workers (add new, drop gone-from-filter only if we want)
  if (state.activeParent) {
    syncParentTabs();
  }

  renderSidebar();
  renderTabs();
  if (state.activeTab && !isMuxTab(state.activeTab)) {
    ensureDetail(state.activeTab);
  }
}

/**
 * When parent is active, ensure new related workers appear as tabs,
 * and tabs for workers no longer in the related set (and not mux) can stay
 * if still open — only auto-add, don't auto-close on filter noise.
 * Exception: workers whose parent repo changed shouldn't stay — rare.
 */
function syncParentTabs() {
  const parent = state.activeParent;
  if (!parent) return;
  const related = workersForParent(parent).map((w) => w.id);
  const muxId = muxIdFor(parent);
  const relatedSet = new Set(related);

  // Keep user-opened orphans only if still same parent
  const orphans = state.openTabs.filter((id) => {
    if (isMuxTab(id) || relatedSet.has(id)) return false;
    const w = state.summaries.find((s) => s.id === id);
    return w && parentKeyOf(w) === parent;
  });

  for (const id of related) {
    if (!state.subtab.has(id)) state.subtab.set(id, DEFAULT_SUB);
    if (!state.logFollow.has(id)) state.logFollow.set(id, true);
  }
  if (!state.subtab.has(muxId)) state.subtab.set(muxId, DEFAULT_SUB);

  state.openTabs = [muxId, ...related, ...orphans];

  if (state.activeTab && !state.openTabs.includes(state.activeTab)) {
    state.activeTab = muxId;
  }
}

function applyProcessesPayload(payload) {
  if (!payload) return;
  state.processes = payload;
  updateLiveBadge();
  renderSidebar();
  if (state.activeTab) {
    const panel = panelEl(state.activeTab);
    const sub = isMuxTab(state.activeTab)
      ? "terminal"
      : state.subtab.get(state.activeTab) || DEFAULT_SUB;
    if (panel && (sub === "process" || sub === "overview" || sub === "terminal" || isMuxTab(state.activeTab))) {
      // for terminal, prefer soft log update; process badge needs re-render occasionally
      if (sub === "process" || sub === "overview") renderPanel(panel, state.activeTab);
      else if (isMuxTab(state.activeTab)) {
        // update live pulses on mux headers only
        $$(".mux-pane", panel).forEach((pane) => {
          const id = pane.dataset.workerId;
          const pulse = $(".pulse", pane);
          const live = isLive(id);
          if (live && !pulse) {
            $(".mux-pane-head", pane)?.insertAdjacentHTML("beforeend", '<span class="pulse"></span>');
          } else if (!live && pulse) pulse.remove();
        });
      }
    }
  }
}

// —— controls ——
function bindControls() {
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderSidebar();
  });
  $("#filter-status").addEventListener("change", (e) => {
    state.filterStatus = e.target.value;
    if (state.activeParent) selectParent(state.activeParent, {
      focusId: isMuxTab(state.activeTab) ? null : state.activeTab,
    });
    else renderSidebar();
  });
  $("#filter-type").addEventListener("change", (e) => {
    state.filterType = e.target.value;
    if (state.activeParent) selectParent(state.activeParent, {
      focusId: isMuxTab(state.activeTab) ? null : state.activeTab,
    });
    else renderSidebar();
  });
  $$(".seg").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      $$(".seg").forEach((b) => b.classList.toggle("active", b === btn));
      renderSidebar();
    });
  });
  $("#btn-refresh").addEventListener("click", async () => {
    const [w, p] = await Promise.all([api.listWorkers(), api.listProcesses()]);
    applyWorkersPayload(w);
    applyProcessesPayload(p);
    hydrateOpenTabs();
  });

  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "w" && state.activeTab) {
      e.preventDefault();
      if (!isMuxTab(state.activeTab)) closeTab(state.activeTab);
    }
  });
}

async function init() {
  bindControls();
  startLogPolling();

  api.onWorkersUpdate(applyWorkersPayload);
  api.onProcessesUpdate(applyProcessesPayload);

  try {
    const [w, p, info] = await Promise.all([
      api.listWorkers(),
      api.listProcesses(),
      api.getInfo(),
    ]);
    state.root = info?.root;
    applyWorkersPayload(w);
    applyProcessesPayload(p);

    // Auto-select parent of first active worker
    const first = (w.summaries || []).find((s) => s.active);
    if (first) selectParent(parentKeyOf(first), { focusId: first.id });
  } catch (e) {
    console.error("init failed", e);
    $("#sidebar-list").innerHTML = `<div style="padding:16px;color:var(--red)">Failed to load: ${esc(e.message)}</div>`;
  }
}

init();
