#!/usr/bin/env node
// Build and install the desktop app on the current OS.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceDirectory } from "./install-utils.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productName = "Orchestrator";
const platform = process.platform;
const npm = platform === "win32" ? "npm.cmd" : "npm";
const npx = platform === "win32" ? "npx.cmd" : "npx";

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited with ${result.status}`);
}

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function findMacApp() {
  const candidates = [
    path.join(root, "dist", "mac-arm64", `${productName}.app`),
    path.join(root, "dist", "mac-x64", `${productName}.app`),
    path.join(root, "dist", "mac", `${productName}.app`),
  ];
  return candidates.find(exists) || null;
}

function installMac() {
  run(npx, ["electron-builder", "--mac", "dir"]);
  const app = findMacApp();
  if (!app) throw new Error("Built .app not found under dist/");
  let destination = path.join("/Applications", `${productName}.app`);
  // Replacing a running .app can leave the old executable paired with new
  // resources. Ask the existing instance to quit before copying the bundle.
  spawnSync("osascript", ["-e", `tell application "${productName}" to quit`], {
    stdio: "ignore",
  });
  try {
    replaceDirectory(app, destination);
  } catch (error) {
    console.warn(`/Applications install failed: ${error.message}`);
    destination = path.join(os.homedir(), "Applications", `${productName}.app`);
    replaceDirectory(app, destination);
  }
  spawnSync("xattr", ["-cr", destination], { stdio: "ignore" });
  run("open", ["-n", "-a", destination]);
  console.log(`Installed: ${destination}`);
}

function installWindows() {
  run(npx, ["electron-builder", "--win", "dir"]);
  const source = path.join(root, "dist", "win-unpacked");
  if (!exists(source)) throw new Error("Built win-unpacked directory not found under dist/");
  const destination = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", productName);
  replaceDirectory(source, destination);
  const exe = path.join(destination, `${productName}.exe`);
  const startMenu = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", `${productName}.lnk`);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const ps = `$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut(${quote(startMenu)}); $s.TargetPath = ${quote(exe)}; $s.WorkingDirectory = ${quote(destination)}; $s.Save()`;
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps]);
  run(exe, []);
  console.log(`Installed: ${destination}`);
}

function installLinux() {
  run(npx, ["electron-builder", "--linux", "dir"]);
  const source = path.join(root, "dist", "linux-unpacked");
  if (!exists(source)) throw new Error("Built linux-unpacked directory not found under dist/");
  const destination = path.join(os.homedir(), ".local", "opt", "orchestrator-desktop");
  replaceDirectory(source, destination);
  const desktopDir = path.join(os.homedir(), ".local", "share", "applications");
  const desktopFile = path.join(desktopDir, "orchestrator.desktop");
  fs.mkdirSync(desktopDir, { recursive: true });
  fs.writeFileSync(desktopFile, [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${productName}`,
    `Exec=${path.join(destination, `${productName}`)}`,
    `Path=${destination}`,
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=Orchestrator",
    "",
  ].join("\n"));
  fs.chmodSync(path.join(destination, productName), 0o755);
  run(path.join(destination, productName), []);
  console.log(`Installed: ${destination}`);
}

try {
  console.log(`== Orchestrator desktop install (${platform}) ==`);
  if (!exists(path.join(root, "node_modules", "electron-builder"))) run(npm, ["install"]);
  if (platform === "darwin") installMac();
  else if (platform === "win32") installWindows();
  else if (platform === "linux") installLinux();
  else throw new Error(`Unsupported platform: ${platform}`);
} catch (error) {
  console.error(`\nDesktop installation failed: ${error.message}`);
  process.exitCode = 1;
}
