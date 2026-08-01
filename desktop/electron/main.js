// Electron main process — orchestrator session monitor
import { app, BrowserWindow, ipcMain, shell, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as workers from "./lib/workers.js";
import { listOrchestratorProcesses } from "./lib/processes.js";
import {
  sendWorkerMessage,
  pingWorker,
  reviseWorker,
  resumeWorker,
  forceFailWorker,
  archiveWorker,
  archiveOldWorkers,
} from "./lib/actions.js";
import { ROOT } from "./lib/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes("--enable-logging");

let mainWindow = null;
let watcher = null;
let processTimer = null;
let lastProcessSnapshot = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Orchestrator Sessions",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1115" : "#f4f5f7",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function refreshProcesses() {
  try {
    lastProcessSnapshot = await listOrchestratorProcesses();
    send("processes:update", lastProcessSnapshot);
  } catch (e) {
    send("processes:update", {
      supervisors: [],
      waits: [],
      children: [],
      byWorker: {},
      error: e.message,
      scannedAt: new Date().toISOString(),
    });
  }
}

function pushWorkersSnapshot(dirtyIds = null) {
  const summaries = workers.listSummaries({ dirtyIds });
  const groups = workers.groupByRepo(summaries);
  send("workers:update", {
    summaries,
    groups,
    root: ROOT,
    at: new Date().toISOString(),
  });
}

function setupIpc() {
  ipcMain.handle("workers:list", () => {
    workers.invalidateSummaryCache();
    const summaries = workers.listSummaries();
    return {
      summaries,
      groups: workers.groupByRepo(summaries),
      root: ROOT,
      at: new Date().toISOString(),
    };
  });

  ipcMain.handle("workers:detail", (_e, id) => {
    if (!id || typeof id !== "string") return null;
    return workers.getDetail(id);
  });

  ipcMain.handle("workers:log", (_e, id, opts) => {
    if (!id || typeof id !== "string") return null;
    return workers.readLogTail(id, opts || {});
  });

  ipcMain.handle("processes:list", async () => {
    lastProcessSnapshot = await listOrchestratorProcesses();
    return lastProcessSnapshot;
  });

  ipcMain.handle("shell:openPath", async (_e, target) => {
    if (!target || typeof target !== "string") return { ok: false };
    const err = await shell.openPath(target);
    return { ok: !err, error: err || null };
  });

  ipcMain.handle("shell:showItem", (_e, target) => {
    if (!target || typeof target !== "string") return { ok: false };
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle("app:getInfo", () => ({
    root: ROOT,
    version: app.getVersion(),
    platform: process.platform,
  }));

  ipcMain.handle("workers:sendMessage", async (_e, id, message, opts) => {
    if (!id || typeof id !== "string") return { ok: false, error: "bad id" };
    return sendWorkerMessage(id, message, opts || {});
  });

  ipcMain.handle("workers:ping", async (_e, id) => {
    if (!id || typeof id !== "string") return { ok: false };
    return pingWorker(id);
  });

  ipcMain.handle("workers:revise", async (_e, id, feedback) => {
    if (!id || typeof id !== "string") return { ok: false, error: "bad id" };
    return reviseWorker(id, feedback);
  });

  ipcMain.handle("workers:resume", async (_e, id, message) => {
    if (!id || typeof id !== "string") return { ok: false, error: "bad id" };
    return resumeWorker(id, message || "");
  });

  ipcMain.handle("workers:forceFail", async (_e, id) => {
    if (!id || typeof id !== "string") return { ok: false, error: "bad id" };
    return forceFailWorker(id);
  });

  ipcMain.handle("workers:archive", async (_e, id) => {
    if (!id || typeof id !== "string") return { ok: false, error: "bad id" };
    return archiveWorker(id);
  });

  ipcMain.handle("workers:archiveOld", async (_e, opts) => {
    if (opts?.dryRun) {
      return {
        ok: true,
        candidates: workers.listArchiveCandidates(),
      };
    }
    return archiveOldWorkers();
  });
}

app.whenReady().then(() => {
  setupIpc();
  createWindow();

  watcher = new workers.WorkerWatcher({ debounceMs: 300 });
  watcher.on("change", ({ ids }) => {
    if (ids?.length) workers.invalidateSummaryCache(ids);
    else workers.invalidateSummaryCache();
    pushWorkersSnapshot(ids);
  });
  watcher.on("error", (e) => console.error("watcher error", e));
  watcher.start();

  // initial push after load
  mainWindow.webContents.once("did-finish-load", () => {
    workers.invalidateSummaryCache();
    pushWorkersSnapshot();
    refreshProcesses();
  });

  processTimer = setInterval(refreshProcesses, 2500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  watcher?.stop();
  if (processTimer) clearInterval(processTimer);
});
