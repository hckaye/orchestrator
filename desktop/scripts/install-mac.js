#!/usr/bin/env node
// Build Orchestrator.app and install into /Applications (fallback: ~/Applications)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const productName = "Orchestrator";

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...opts,
  });
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function findBuiltApp() {
  const candidates = [
    path.join(root, "dist", "mac-arm64", `${productName}.app`),
    path.join(root, "dist", "mac", `${productName}.app`),
    path.join(root, "dist", `${productName}.app`),
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  // search dist
  const dist = path.join(root, "dist");
  if (!exists(dist)) return null;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return null;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === `${productName}.app` && fs.statSync(full).isDirectory()) return full;
      try {
        if (fs.statSync(full).isDirectory() && !name.endsWith(".app")) {
          const hit = walk(full, depth + 1);
          if (hit) return hit;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  };
  return walk(dist);
}

function copyApp(src, destDir) {
  const dest = path.join(destDir, `${productName}.app`);
  fs.mkdirSync(destDir, { recursive: true });
  // replace existing
  if (exists(dest)) {
    console.log(`Removing existing ${dest}`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  console.log(`Installing ${src} → ${dest}`);
  // ditto preserves resource forks / codesign better on macOS
  const r = spawnSync("ditto", [src, dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`ditto failed with ${r.status}`);
  return dest;
}

console.log("== Orchestrator desktop install ==");
console.log(`root: ${root}`);

// ensure deps
if (!exists(path.join(root, "node_modules", "electron-builder"))) {
  run("npm", ["install"]);
}

// package
run("npx", ["electron-builder", "--mac", "dir"]);

const appPath = findBuiltApp();
if (!appPath) {
  console.error("Built .app not found under dist/");
  process.exit(1);
}
console.log(`Built: ${appPath}`);

const homeApps = path.join(os.homedir(), "Applications");
const systemApps = "/Applications";

let installed = null;
// Prefer /Applications; fall back to ~/Applications on permission error
try {
  installed = copyApp(appPath, systemApps);
} catch (e) {
  console.warn(`/Applications install failed: ${e.message}`);
  console.warn("Falling back to ~/Applications");
  installed = copyApp(appPath, homeApps);
}

// Clear quarantine so Gatekeeper doesn't block first launch of unsigned local build
spawnSync("xattr", ["-cr", installed], { stdio: "inherit" });

// Optional: add to Dock? skip — user can keep in Applications

console.log("");
console.log(`Installed: ${installed}`);
console.log("Launch with Spotlight (⌘Space → Orchestrator) or:");
console.log(`  open ${JSON.stringify(installed)}`);

// open the app
spawnSync("open", ["-a", installed], { stdio: "inherit" });
