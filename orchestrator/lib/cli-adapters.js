// cli-adapters.js — build argv for each worker CLI
// Returns { argv, env, usePty, promptInjection }
// printMode=true  -> non-interactive (-p), auto-approve via flags (no hang risk)
// printMode=false -> interactive PTY, permission bridge active

import { applyCursorModelEffort, cursorModelSlugs } from "./models.js";

// When an effort is explicitly resolved for this run, drop any effort flags
// baked into config extraArgs — otherwise the CLI's last-flag-wins parsing
// silently overrides the requested effort.
function extraArgsWithoutEffort(extra) {
  const out = [];
  for (let i = 0; i < (extra?.length || 0); i++) {
    const a = String(extra[i]);
    if (a === "--effort") { i++; continue; }
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
  argv.push("--model", model);
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

export const WORKER_TYPES = ["devin", "codex", "cursor", "claude", "grok"];

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
  argv.push("--model", model);
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
    default:
      return null;
  }
}
