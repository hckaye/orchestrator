#!/usr/bin/env node
// Cross-platform installer for the orchestrator CLI.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();
const orchHome = process.env.ORCH_HOME || path.join(home, ".orchestrator");
const binDir = process.env.BIN_DIR || path.join(home, ".local", "bin");
const skillsSource = process.env.SKILLS_SOURCE || "hckaye/orchestrator";
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const npxCommand = isWindows ? "npx.cmd" : "npx";

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: scriptDir,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(`${command} exited with ${result.status}`);
  }
}

function copy(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function updateConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = false;
  config.workers ||= {};
  if (!config.workers.grok) {
    config.workers.grok = {
      cli: "grok",
      defaultModel: "grok-4.5",
      permissionMode: "default",
      alwaysApprove: true,
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  }
  config.permissionBridge ||= {};
  config.permissionBridge.patterns ||= {};
  if (!config.permissionBridge.patterns.grok) {
    config.permissionBridge.patterns.grok = [
      { regex: "Allow|approve|permission|Do you want to", type: "permission" },
      { regex: "\\?\\s*$", type: "question" },
    ];
    changed = true;
  }
  if (changed) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function installCommandShim() {
  fs.mkdirSync(binDir, { recursive: true });
  if (isWindows) {
    const shim = path.join(binDir, "orchestrator.cmd");
    fs.writeFileSync(shim, `@echo off\r\nnode "${path.join(orchHome, "orchestrator.js")}" %*\r\n`);
    return shim;
  }
  const target = path.join(binDir, "orchestrator");
  try { fs.unlinkSync(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(path.join(orchHome, "orchestrator.js"), target);
  return target;
}

function addWindowsPath() {
  if (!isWindows) return;
  const escaped = binDir.replaceAll("'", "''");
  const script = [
    "$p = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$parts = @($p -split ';' | Where-Object { $_ })",
    `if (-not ($parts -contains '${escaped}')) { [Environment]::SetEnvironmentVariable('Path', (($parts + '${escaped}') -join ';'), 'User') }`,
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function printPathHint() {
  if (process.env.PATH?.split(path.delimiter).includes(binDir)) return;
  console.warn(`\nWARNING: ${binDir} is not in PATH.`);
  if (isWindows) {
    console.warn("The installer added it to your user PATH. Open a new PowerShell/Command Prompt to reload PATH.");
  } else {
    console.warn(`  export PATH="${binDir}:$PATH"`);
  }
}

function verify() {
  const cliNames = ["devin", "claude", "codex", "cursor-agent", "grok"];
  for (const cli of cliNames) {
    const command = isWindows ? "where.exe" : "which";
    const result = spawnSync(command, [cli], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    console.log(`  worker CLI ${cli}: ${result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : "NOT FOUND"}`);
  }
}

try {
  console.log(`==> Installing orchestrator to ${orchHome}`);
  fs.mkdirSync(path.join(orchHome, "lib"), { recursive: true });
  fs.mkdirSync(path.join(orchHome, "logs"), { recursive: true });
  fs.mkdirSync(path.join(orchHome, "workers"), { recursive: true });
  copy(path.join(scriptDir, "orchestrator", "orchestrator.js"), path.join(orchHome, "orchestrator.js"));
  for (const file of fs.readdirSync(path.join(scriptDir, "orchestrator", "lib"))) {
    if (file.endsWith(".js")) copy(path.join(scriptDir, "orchestrator", "lib", file), path.join(orchHome, "lib", file));
  }
  copy(path.join(scriptDir, "orchestrator", "package.json"), path.join(orchHome, "package.json"));
  if (!isWindows) fs.chmodSync(path.join(orchHome, "orchestrator.js"), 0o755);

  const configPath = path.join(orchHome, "config.json");
  if (!fs.existsSync(configPath)) {
    copy(path.join(scriptDir, "orchestrator", "config.example.json"), configPath);
    console.log(`    seeded config.json (edit at ${configPath})`);
  } else {
    console.log("    kept existing config.json");
  }
  updateConfig(configPath);

  console.log("==> Installing node dependencies (node-pty)");
  run(npmCommand, ["install", "--silent", "--no-audit", "--no-fund"], { cwd: orchHome });
  const shim = installCommandShim();
  addWindowsPath();
  console.log(`==> Installed CLI: ${shim}`);

  console.log(`==> Installing skills from ${skillsSource}`);
  run(npxCommand, ["--yes", "skills", "add", skillsSource, "--skill", "orchestrator", "--skill", "orchestrator-handoff", "--agent", "*", "--global", "--copy", "--full-depth", "--yes"]);
  printPathHint();
  console.log("\n==> Verifying worker CLIs");
  verify();
  console.log("\nDone. Run `orchestrator --help` to get started.");
} catch (error) {
  console.error(`\nInstallation failed: ${error.message}`);
  process.exitCode = 1;
}
