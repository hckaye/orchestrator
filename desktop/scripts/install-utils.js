import fs from "node:fs";
import path from "node:path";

export function replaceDirectory(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // macOS framework bundles rely on relative symlinks such as
  // Versions/Current -> A. Node otherwise rewrites them to absolute links
  // pointing back into dist/, which makes the installed Electron runtime
  // fail to locate ICU and crash its renderer process.
  fs.cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}
