// resume.js — detect resumable failures and build continuation prompts

export const DEFAULT_RATE_LIMIT_PATTERNS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "too many requests",
  "429",
  "quota exceeded",
  "usage limit",
  "capacity",
  "overloaded",
  "resource_exhausted",
];

export const DEFAULT_TRANSIENT_PATTERNS = [
  "econnreset",
  "socket hang up",
  "503 service unavailable",
  "502 bad gateway",
  "504 gateway timeout",
  "temporarily unavailable",
  "connection reset",
  "network error",
  "timeout",
];

export function failurePatterns(cfg) {
  return {
    rateLimit: cfg.resume?.rateLimitPatterns || DEFAULT_RATE_LIMIT_PATTERNS,
    transient: cfg.resume?.transientPatterns || DEFAULT_TRANSIENT_PATTERNS,
  };
}

function matchesAny(text, patterns) {
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (typeof p !== "string" || !p) continue;
    if (p.length <= 4 && /^\d+$/.test(p)) {
      if (new RegExp(`\\b${p}\\b`).test(text)) return true;
      continue;
    }
    if (lower.includes(p.toLowerCase())) return true;
    try {
      if (new RegExp(p, "i").test(text)) return true;
    } catch {
      // ignore invalid regex in config
    }
  }
  return false;
}

export function detectFailureReason(text, cfg = {}) {
  if (!text) return null;
  const { rateLimit, transient } = failurePatterns(cfg);
  if (matchesAny(text, rateLimit)) return "rate-limit";
  if (matchesAny(text, transient)) return "transient";
  return null;
}

export function hasSession(state) {
  return !!state?.sessionId;
}

export function isResumeEligibleStatus(status) {
  return ["failed", "failed-resumable", "running"].includes(status);
}

export function canResume(state) {
  if (!hasSession(state)) return false;
  return isResumeEligibleStatus(state.status);
}

export function buildContinuationPrompt(state, cfg, userMessage) {
  const reason = state.failureReason;
  const baseTask = state.task || state.prompt || "";
  const custom = userMessage?.trim();

  if (custom) {
    return custom;
  }

  if (reason === "rate-limit") {
    return (
      cfg.resume?.rateLimitPrompt ||
      "Your previous run stopped due to a rate limit or quota error. Continue the original task from where you left off. Do not restart from scratch. Complete any remaining work, commit locally, and end with DONE: or BLOCKED:."
    );
  }

  if (reason === "transient") {
    return (
      cfg.resume?.transientPrompt ||
      "Your previous run was interrupted by a transient network or service error. Continue the original task from where you left off. Do not restart from scratch. Complete any remaining work, commit locally, and end with DONE: or BLOCKED:."
    );
  }

  const generic =
    cfg.resume?.continuationPrompt ||
    "Your previous run was interrupted before completion. Continue the original task from where you left off. Do not restart from scratch. Complete any remaining work, commit locally, and end with DONE: or BLOCKED:.";

  if (baseTask && !generic.includes(baseTask.slice(0, 40))) {
    return `${generic}\n\nOriginal task:\n${baseTask}`;
  }
  return generic;
}
