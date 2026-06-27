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
  // atomic write: readers polling this file must never see a partial JSON
  const file = workerFile(id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(full, null, 2));
  fs.renameSync(tmp, file);
}

export function listWorkers() {
  ensureDirs();
  return fs
    .readdirSync(WORKERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.basename(f, ".json"));
}

export function genId(prefix) {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${t}-${r}`;
}
