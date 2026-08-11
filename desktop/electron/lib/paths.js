// Shared paths under ~/.orchestrator
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const ROOT = path.join(os.homedir(), ".orchestrator");
export const WORKERS_DIR = path.join(ROOT, "workers");
export const LOGS_DIR = path.join(ROOT, "logs");
export const CONFIG_PATH = path.join(ROOT, "config.json");

export function ensureDirs() {
  for (const d of [ROOT, WORKERS_DIR, LOGS_DIR]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

export function workerFile(id) {
  return path.join(WORKERS_DIR, `${id}.json`);
}

export function workerSock(id, { platform = process.platform, workersDir = WORKERS_DIR } = {}) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\orchestrator-${id}`;
  }
  return path.join(workersDir, `${id}.sock`);
}

export function workerSockUsesFilesystem({ platform = process.platform } = {}) {
  return platform !== "win32";
}

export function removeWorkerSock(id, options = {}) {
  if (!workerSockUsesFilesystem(options)) return;
  try {
    fs.unlinkSync(workerSock(id, options));
  } catch {
    /* ignore */
  }
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
