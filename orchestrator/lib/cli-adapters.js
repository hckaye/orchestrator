// cli-adapters.js — build argv for each worker CLI
// Returns { argv, env, usePty, promptInjection }
// printMode=true  -> non-interactive (-p), auto-approve via flags (no hang risk)
// printMode=false -> interactive PTY, permission bridge active

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import {
  applyCursorModelEffort,
  applyDevinModelEffort,
  cursorModelSlugs,
  devinModelSlugs,
} from "./models.js";

// On Windows, worker CLIs installed via npm are extensionless shims plus a
// .cmd wrapper, and neither spawn() nor node-pty can execute a .cmd directly.
// where.exe resolves the name on PATH, but if the hit is a .cmd/.bat shim we
// still cannot spawn it — so read the shim and peel out the real target:
// an .exe invoked as "%~dp0\...\x.exe" %* (opencode), or a node entry point
// invoked as node "%~dp0\...\x.js" %*. Returns { command, prefix } where
// prefix args go before the built argv.
export function resolveCliBin(bin, { platform = process.platform } = {}) {
  const passthrough = { command: bin, prefix: [] };
  if (platform !== "win32") return passthrough;
  if (/\.(exe|com|cmd|bat)$/i.test(bin) || bin.includes("\\") || bin.includes("/")) {
    return passthrough;
  }
  let candidates;
  try {
    candidates = execSync(`where.exe ${bin}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return passthrough;
  }
  const exe = candidates.find((l) => /\.(exe|com)$/i.test(l));
  if (exe) return { command: exe, prefix: [] };
  const shim = candidates.find((l) => /\.(cmd|bat)$/i.test(l));
  if (!shim) return passthrough;
  let shimText;
  try {
    shimText = fs.readFileSync(shim, "utf8");
  } catch {
    return passthrough;
  }
  const shimDir = path.dirname(shim);
  const dp0Target = (m) => path.join(shimDir, m[1].replace(/^[\\/]+/, ""));
  // npm shims expand the shim dir as %~dp0 or via SET dp0=%~dp0 → "%dp0%\...".
  // Prefer a .js entry: node-based shims also quote a "%dp0%\node.exe" loader,
  // and "node x.js" is exactly what the shim runs.
  const jsDp0 = shimText.match(/"%~?dp0%?([^"]+\.(?:js|mjs|cjs))"/i);
  if (jsDp0) {
    const target = dp0Target(jsDp0);
    if (fs.existsSync(target)) return { command: process.execPath, prefix: [target] };
  }
  const jsAbs = shimText.match(/"([A-Za-z]:[^"]+\.(?:js|mjs|cjs))"/i);
  if (jsAbs && fs.existsSync(jsAbs[1])) return { command: process.execPath, prefix: [jsAbs[1]] };
  const exeDp0 = shimText.match(/"%~?dp0%?([^"]+\.exe)"/i);
  if (exeDp0) {
    const target = dp0Target(exeDp0);
    if (fs.existsSync(target)) return { command: target, prefix: [] };
  }
  const exeAbs = shimText.match(/"([A-Za-z]:[^"]+\.exe)"/i);
  if (exeAbs && fs.existsSync(exeAbs[1])) return { command: exeAbs[1], prefix: [] };
  return passthrough;
}

// When an effort is explicitly resolved for this run, drop any effort flags
// baked into config extraArgs — otherwise the CLI's last-flag-wins parsing
// silently overrides the requested effort.
function extraArgsWithoutEffort(extra) {
  const out = [];
  for (let i = 0; i < (extra?.length || 0); i++) {
    const a = String(extra[i]);
    if (a === "--effort" || a === "--variant") { i++; continue; }
    if ((a === "-c" || a === "--config") && /^model_reasoning_effort\s*=/.test(String(extra[i + 1] ?? ""))) { i++; continue; }
    out.push(extra[i]);
  }
  return out;
}

function pushExtraArgs(argv, cfg, effort) {
  if (!cfg.extraArgs?.length) return;
  argv.push(...(effort ? extraArgsWithoutEffort(cfg.extraArgs) : cfg.extraArgs));
}

export function buildCommand(type, opts) {
  const cfg = opts.cfg.workers?.[type];
  if (!cfg) throw new Error(`Unknown worker type: ${type}`);

  const model = opts.model || cfg.defaultModel;
  const effort = opts.effort || null;
  const prompt = opts.prompt;
  const cwd = opts.cwd;
  const interactive = !!opts.interactive;

  switch (type) {
    case "devin":
      return devin(cfg, model, effort, prompt, cwd, interactive);
    case "claude":
      return claude(cfg, model, effort, prompt, cwd, interactive);
    case "codex":
      return codex(cfg, model, effort, prompt, cwd, interactive);
    case "cursor":
      return cursor(cfg, model, effort, prompt, cwd, interactive);
    case "grok":
      return grok(cfg, model, effort, prompt, cwd, interactive);
    case "opencode":
    case "opencode-go":
    case "zen":
      return opencode(cfg, model, effort, prompt, cwd, interactive);
    default:
      throw new Error(`Unknown worker type: ${type}`);
  }
}

function devin(cfg, model, effort, prompt, cwd, interactive) {
  const argv = [];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt);
  } else {
    argv.push("--", prompt);
  }
  // Devin encodes effort in the model slug (swe-2-max); resolve against the
  // installed CLI's model list so families without variants stay unchanged.
  const effectiveModel = effort
    ? applyDevinModelEffort(model, effort, devinModelSlugs(cfg.cli))
    : model;
  argv.push("--model", effectiveModel);
  argv.push("--permission-mode", interactive ? "auto" : cfg.permissionMode || "dangerous");
  if (cfg.extraArgs?.length) argv.push(...cfg.extraArgs);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function claude(cfg, model, effort, prompt, cwd, interactive) {
  const argv = [];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt, "--output-format", "stream-json", "--verbose");
  } else {
    argv.push(prompt);
  }
  argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (cfg.permissionMode) argv.push("--permission-mode", cfg.permissionMode);
  pushExtraArgs(argv, cfg, effort);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function codex(cfg, model, effort, prompt, cwd, interactive) {
  // Keep options before the positional prompt, matching `codex exec --help`.
  const argv = ["exec"];
  argv.push("--model", model);
  if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
  if (!interactive && cfg.printMode) {
    argv.push("--json");
  }
  if (!interactive && cfg.bypassApprovals) {
    argv.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (cfg.sandbox) {
    argv.push("-s", cfg.sandbox);
  }
  if (cwd) argv.push("-C", cwd);
  pushExtraArgs(argv, cfg, effort);
  argv.push(prompt);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function cursor(cfg, model, effort, prompt, cwd, interactive) {
  const argv = [];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt, "--output-format", "stream-json");
  } else {
    argv.push(prompt);
  }
  const effectiveModel = effort ? applyCursorModelEffort(model, effort, cursorModelSlugs(cfg.cli)) : model;
  argv.push("--model", effectiveModel);
  if (!interactive) {
    if (cfg.yolo) argv.push("--yolo");
    if (cfg.trust) argv.push("--trust");
  }
  if (cwd) argv.push("--workspace", cwd);
  if (cfg.extraArgs?.length) argv.push(...cfg.extraArgs);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function grok(cfg, model, effort, prompt, cwd, interactive) {
  const argv = [];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt, "--output-format", "streaming-json");
  } else {
    argv.push(prompt);
  }
  argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (!interactive && cfg.alwaysApprove !== false) {
    argv.push("--always-approve");
  } else if (interactive && cfg.permissionMode) {
    argv.push("--permission-mode", cfg.permissionMode);
  }
  pushExtraArgs(argv, cfg, effort);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

// opencode / opencode-go / zen all drive the `opencode` binary. cfg.provider
// pins a hosted provider (opencode-go = OpenCode Go, opencode = Zen); bare
// model ids get that prefix, already-qualified provider/model ids pass through.
function opencodeModel(cfg, model) {
  return cfg.provider && !model.includes("/") ? `${cfg.provider}/${model}` : model;
}

function opencode(cfg, model, effort, prompt, cwd, interactive) {
  const argv = ["run"];
  argv.push("-m", opencodeModel(cfg, model));
  if (effort) argv.push("--variant", effort);
  if (interactive) {
    argv.push("--interactive");
  } else {
    if (cfg.printMode) argv.push("--format", "json");
    if (cfg.auto !== false) argv.push("--auto");
  }
  pushExtraArgs(argv, cfg, effort);
  argv.push(prompt);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

export const WORKER_TYPES = ["devin", "codex", "cursor", "claude", "grok", "opencode", "opencode-go", "zen"];

// --- Resume support: re-spawn a worker on its existing session with feedback ---

export function buildResumeCommand(type, opts) {
  const cfg = opts.cfg.workers?.[type];
  if (!cfg) throw new Error(`Unknown worker type: ${type}`);
  if (!opts.sessionId) throw new Error(`buildResumeCommand: missing sessionId`);
  const model = opts.model || cfg.defaultModel;
  const effort = opts.effort || null;
  const prompt = opts.prompt;
  const cwd = opts.cwd;
  const interactive = !!opts.interactive;
  switch (type) {
    case "devin":   return resumeDevin(cfg, model, effort, opts.sessionId, prompt, cwd, interactive);
    case "claude":  return resumeClaude(cfg, model, effort, opts.sessionId, prompt, cwd, interactive);
    case "codex":   return resumeCodex(cfg, model, effort, opts.sessionId, prompt, cwd, interactive);
    case "cursor":  return resumeCursor(cfg, model, effort, opts.sessionId, prompt, cwd, interactive);
    case "grok":    return resumeGrok(cfg, model, effort, opts.sessionId, prompt, cwd, interactive);
    case "opencode":
    case "opencode-go":
    case "zen":     return resumeOpencode(cfg, model, effort, opts.sessionId, prompt, cwd, interactive);
    default: throw new Error(`Unknown worker type: ${type}`);
  }
}

function resumeDevin(cfg, model, effort, sessionId, prompt, cwd, interactive) {
  const argv = ["-r", sessionId];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt);
  } else {
    argv.push("--", prompt);
  }
  const effectiveModel = effort
    ? applyDevinModelEffort(model, effort, devinModelSlugs(cfg.cli))
    : model;
  argv.push("--model", effectiveModel);
  argv.push("--permission-mode", interactive ? "auto" : cfg.permissionMode || "dangerous");
  if (cfg.extraArgs?.length) argv.push(...cfg.extraArgs);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function resumeClaude(cfg, model, effort, sessionId, prompt, cwd, interactive) {
  const argv = ["-r", sessionId];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt, "--output-format", "stream-json", "--verbose");
  } else {
    argv.push(prompt);
  }
  argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (cfg.permissionMode) argv.push("--permission-mode", cfg.permissionMode);
  pushExtraArgs(argv, cfg, effort);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function resumeCodex(cfg, model, effort, sessionId, prompt, cwd, interactive) {
  // `codex exec resume --help` places options before the session/prompt args.
  const argv = ["exec", "resume"];
  argv.push("--model", model);
  if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
  if (!interactive && cfg.printMode) {
    argv.push("--json");
  }
  if (!interactive && cfg.bypassApprovals) {
    argv.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (cfg.sandbox) {
    argv.push("-s", cfg.sandbox);
  }
  // resume subcommand has no -C; session cwd is reused from the original exec.
  pushExtraArgs(argv, cfg, effort);
  argv.push(sessionId, prompt);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function resumeCursor(cfg, model, effort, chatId, prompt, cwd, interactive) {
  const argv = ["--resume", chatId];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt, "--output-format", "stream-json");
  } else {
    argv.push(prompt);
  }
  const effectiveModel = effort ? applyCursorModelEffort(model, effort, cursorModelSlugs(cfg.cli)) : model;
  argv.push("--model", effectiveModel);
  if (!interactive) {
    if (cfg.yolo) argv.push("--yolo");
    if (cfg.trust) argv.push("--trust");
  }
  if (cwd) argv.push("--workspace", cwd);
  if (cfg.extraArgs?.length) argv.push(...cfg.extraArgs);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function resumeGrok(cfg, model, effort, sessionId, prompt, cwd, interactive) {
  const argv = ["--resume", sessionId];
  if (!interactive && cfg.printMode) {
    argv.push("-p", prompt, "--output-format", "streaming-json");
  } else {
    argv.push(prompt);
  }
  argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (!interactive && cfg.alwaysApprove !== false) {
    argv.push("--always-approve");
  } else if (interactive && cfg.permissionMode) {
    argv.push("--permission-mode", cfg.permissionMode);
  }
  pushExtraArgs(argv, cfg, effort);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

function resumeOpencode(cfg, model, effort, sessionId, prompt, cwd, interactive) {
  const argv = ["run", "--session", sessionId];
  argv.push("-m", opencodeModel(cfg, model));
  if (effort) argv.push("--variant", effort);
  if (interactive) {
    argv.push("--interactive");
  } else {
    if (cfg.printMode) argv.push("--format", "json");
    if (cfg.auto !== false) argv.push("--auto");
  }
  pushExtraArgs(argv, cfg, effort);
  argv.push(prompt);
  return { argv, env: {}, usePty: interactive, cliBin: cfg.cli };
}

const SESSION_ID_JSON = /"(?:session_id|sessionId)"\s*:\s*"([^"]+)"/i;

function matchSessionIdJson(text) {
  const m = text.match(SESSION_ID_JSON);
  return m ? m[1] : null;
}

// Extract session/chat ID from a stdout chunk. Returns string or null.
// Each CLI emits a different shape; we scan buffered text for known patterns.
export function extractSessionId(type, text) {
  if (!text) return null;
  switch (type) {
    case "claude": {
      const m = text.match(/"type"\s*:\s*"system"[^\n]*?"subtype"\s*:\s*"init"[^\n]*?"session_id"\s*:\s*"([0-9a-f-]{36})"/i);
      if (m) return m[1];
      return matchSessionIdJson(text);
    }
    case "devin": {
      const sid = matchSessionIdJson(text);
      if (sid) return sid;
      const m = text.match(/session[_-]?id[:\s]+([0-9a-f-]{8,})/i);
      if (m) return m[1];
      const m2 = text.match(/"sessionId"\s*:\s*"([^"]+)"/i);
      return m2 ? m2[1] : null;
    }
    case "codex": {
      const sid = matchSessionIdJson(text);
      if (sid) return sid;
      const m2 = text.match(/"thread_id"\s*:\s*"([0-9a-f-]{36})"/i);
      return m2 ? m2[1] : null;
    }
    case "cursor": {
      const init = text.match(/"type"\s*:\s*"system"[^\n]*?"subtype"\s*:\s*"init"[^\n]*?"session_id"\s*:\s*"([0-9a-f-]{36})"/i);
      if (init) return init[1];
      const sid = matchSessionIdJson(text);
      if (sid) return sid;
      const m = text.match(/"chatId"\s*:\s*"([0-9a-fA-F-]{8,})"/i);
      if (m) return m[1];
      const m2 = text.match(/"chat_id"\s*:\s*"([0-9a-fA-F-]{8,})"/i);
      return m2 ? m2[1] : null;
    }
    case "grok":
      return matchSessionIdJson(text);
    case "opencode":
    case "opencode-go":
    case "zen": {
      const m = text.match(/"sessionID"\s*:\s*"(ses_[^"]+)"/i);
      if (m) return m[1];
      return matchSessionIdJson(text);
    }
    default:
      return null;
  }
}
