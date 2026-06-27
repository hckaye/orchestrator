// models.js — model listing and effort helpers
import { execFileSync } from "node:child_process";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

const EFFORT_TIER_RE = /(?:^|[-/])(?:thinking-)?(low|medium|high|xhigh|max)(?:-fast)?(?:$|[-/])/;

export function normalizeEffort(value) {
  if (!value) return null;
  const e = String(value).trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(e)) {
    throw new Error(`invalid effort '${value}' — use ${EFFORT_LEVELS.join(", ")}`);
  }
  return e;
}

export function extractEffortFromSlug(slug) {
  if (!slug) return null;
  const codex = slug.match(/-codex-(low|medium|high|xhigh)(?:-fast)?$/i);
  if (codex) return codex[1].toLowerCase();
  const m = slug.match(/-(low|medium|high|xhigh|max)(?:-fast)?$/i);
  if (m) return m[1].toLowerCase();
  const thinking = slug.match(/-thinking-(low|medium|high|xhigh|max)(?:-fast)?$/i);
  if (thinking) return thinking[1].toLowerCase();
  if (EFFORT_TIER_RE.test(slug)) {
    const inner = slug.match(EFFORT_TIER_RE);
    return inner?.[1]?.toLowerCase() || null;
  }
  return null;
}

export function resolveEffort(type, cfg, effortOverride) {
  if (effortOverride) return normalizeEffort(effortOverride);
  const fromCfg = cfg.workers?.[type]?.defaultEffort;
  return fromCfg ? normalizeEffort(fromCfg) : null;
}

function stripEffortSuffix(model) {
  // single pass: strip exactly one trailing effort tier (with optional
  // -thinking-/-fast decorations). Looping over tiers used to eat family
  // names too, e.g. gpt-5.1-codex-max-medium -> gpt-5.1-codex ("max" is part
  // of the family, not an effort suffix to remove twice).
  const tiers = EFFORT_LEVELS.join("|");
  return model.replace(new RegExp(`-(?:thinking-)?(?:${tiers})(?:-fast)?$`, "i"), "");
}

// Cache of `cursor-agent --list-models` slugs, fetched at most once per process.
let cursorSlugCache;
export function cursorModelSlugs(cli = "cursor-agent") {
  if (cursorSlugCache !== undefined) return cursorSlugCache;
  try {
    const out = execFileSync(cli, ["--list-models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    const slugs = parseCursorListModels(out).map((r) => r.slug);
    cursorSlugCache = slugs.length ? slugs : null;
  } catch {
    cursorSlugCache = null;
  }
  return cursorSlugCache;
}

export function applyCursorModelEffort(model, effort, knownSlugs = null) {
  if (!effort || !model) return model;
  const e = normalizeEffort(effort);
  // bracket-parameterized models (e.g. claude-opus-4-8[context=1m]) accept
  // an effort override inside the brackets
  const bracket = model.match(/^([^[]+)(\[.*\])$/);
  if (bracket) {
    let params = bracket[2];
    if (/effort\s*=/.test(params)) {
      params = params.replace(/effort\s*=\s*[^,\]]+/i, `effort=${e}`);
    } else {
      params = params.replace(/\]$/, `,effort=${e}]`);
    }
    return bracket[1] + params;
  }
  const hadTier = !!extractEffortFromSlug(model);
  const wasFast = /-fast$/i.test(model);
  let base = stripEffortSuffix(model);
  if (wasFast) base = base.replace(/-fast$/i, "");
  const candidates = wasFast ? [`${base}-${e}-fast`, `${base}-${e}`] : [`${base}-${e}`];
  if (Array.isArray(knownSlugs) && knownSlugs.length) {
    for (const c of candidates) {
      if (knownSlugs.includes(c)) return c;
    }
    // this family has no such effort variant (e.g. composer-*) — keep the
    // model usable rather than inventing a slug the CLI will reject
    return model;
  }
  // no authoritative list available: only rewrite slugs that already encode
  // an effort tier (proof the family supports tiers); otherwise leave as-is
  return hadTier ? candidates[0] : model;
}

export function pickWorkerRuntime(cfg, type, { model, effort } = {}) {
  const workerCfg = cfg.workers?.[type] || {};
  const resolvedEffort = resolveEffort(type, cfg, effort);
  const baseModel = model || workerCfg.defaultModel;
  return { model: baseModel, effort: resolvedEffort };
}

function parseCursorListModels(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Available models") continue;
    const m = trimmed.match(/^(\S+)\s+-\s+(.+)$/);
    if (!m) continue;
    const slug = m[1];
    const label = m[2];
    rows.push({
      slug,
      label,
      effort: extractEffortFromSlug(slug),
      fast: /-fast$/i.test(slug) || /\bfast\b/i.test(label),
      current: /\(current\)/i.test(label),
    });
  }
  return rows;
}

function listCursorAgentModels(cfg) {
  const cli = cfg.workers?.cursor?.cli || "cursor-agent";
  try {
    const out = execFileSync(cli, ["--list-models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    return parseCursorListModels(out);
  } catch (e) {
    return { error: e.message };
  }
}

function parseGrokListModels(text) {
  const rows = [];
  let defaultModel = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const defaultLine = trimmed.match(/^Default model:\s+(\S+)/i);
    if (defaultLine) {
      defaultModel = defaultLine[1];
      continue;
    }
    const modelLine = trimmed.match(/^\*\s+(\S+)(?:\s+\((default)\))?$/i);
    if (!modelLine) continue;
    rows.push({
      slug: modelLine[1],
      label: modelLine[1],
      effort: "via --effort",
      fast: false,
      current: !!modelLine[2],
    });
  }
  return rows.map((row) => ({
    ...row,
    current: row.current || row.slug === defaultModel,
  }));
}

function listGrokAgentModels(cfg) {
  const cli = cfg.workers?.grok?.cli || "grok";
  try {
    const out = execFileSync(cli, ["models"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    const rows = parseGrokListModels(out);
    return rows.length ? rows : [{
      slug: cfg.workers?.grok?.defaultModel || "grok-4.5",
      label: "Grok",
      effort: "via --effort",
      fast: false,
      current: true,
    }];
  } catch (e) {
    return { error: e.message };
  }
}

function classifySlugFamily(slug) {
  if (/^composer-/i.test(slug)) return "cursor";
  if (/^grok-/i.test(slug)) return "grok";
  if (/^gpt-|^o\d/i.test(slug) || /codex/i.test(slug)) return "codex";
  if (/^claude-/i.test(slug)) return "cursor";
  return "cursor";
}

const CLAUDE_MODELS = [
  { slug: "fable", label: "Fable (latest alias)", effort: "via --effort" },
  { slug: "claude-fable-5[1m]", label: "Fable 5 1M", effort: "via --effort" },
  { slug: "opus", label: "Opus (latest alias)", effort: "via --effort" },
  { slug: "claude-opus-4-8[1m]", label: "Opus 4.8 1M", effort: "via --effort" },
  { slug: "sonnet", label: "Sonnet (latest alias)", effort: "via --effort" },
  { slug: "claude-sonnet-5[1m]", label: "Sonnet 5 1M", effort: "via --effort" },
];

const DEVIN_MODELS = [
  { slug: "swe-1-7", label: "SWE 1.7", effort: "n/a" },
  { slug: "opus", label: "Opus (latest alias)", effort: "n/a" },
  { slug: "codex", label: "Codex (via Devin)", effort: "n/a" },
  { slug: "claude-opus-4.6", label: "Claude Opus 4.6 (via Devin)", effort: "n/a" },
  { slug: "claude-sonnet-4", label: "Claude Sonnet 4 (via Devin)", effort: "n/a" },
];

const CODEX_MODELS = [
  { slug: "gpt-5.6-luna", label: "GPT-5.6 Luna", effort: "via --effort" },
];

export function listModels(cfg, typeFilter) {
  const rows = [];
  if (!typeFilter || typeFilter === "cursor" || typeFilter === "codex") {
    const cursorRows = listCursorAgentModels(cfg);
    if (cursorRows.error) {
      rows.push({ type: "cursor", error: cursorRows.error });
    } else {
      for (const m of cursorRows) {
        const family = classifySlugFamily(m.slug);
        if (typeFilter && family !== typeFilter) continue;
        rows.push({
          type: family,
          slug: m.slug,
          label: m.label,
          effort: m.effort || (family === "codex" ? "via --effort" : "-"),
          fast: m.fast ? "yes" : "no",
          current: m.current ? "yes" : "no",
        });
      }
    }
  }

  if (!typeFilter || typeFilter === "claude") {
    for (const m of CLAUDE_MODELS) {
      rows.push({
        type: "claude",
        slug: m.slug,
        label: m.label,
        effort: m.effort,
        fast: "-",
        current: cfg.workers?.claude?.defaultModel === m.slug ? "yes" : "no",
      });
    }
    rows.push({
      type: "claude",
      slug: "(flag)",
      label: `--effort ${EFFORT_LEVELS.join("|")}`,
      effort: "per spawn",
      fast: "-",
      current: "-",
    });
  }

  if (!typeFilter || typeFilter === "devin") {
    for (const m of DEVIN_MODELS) {
      rows.push({
        type: "devin",
        slug: m.slug,
        label: m.label,
        effort: m.effort,
        fast: "-",
        current: cfg.workers?.devin?.defaultModel === m.slug ? "yes" : "no",
      });
    }
  }

  if (!typeFilter || typeFilter === "codex") {
    for (const m of CODEX_MODELS) {
      rows.push({
        type: "codex",
        slug: m.slug,
        label: m.label,
        effort: m.effort,
        fast: "-",
        current: cfg.workers?.codex?.defaultModel === m.slug ? "yes" : "no",
      });
    }
    rows.push({
      type: "codex",
      slug: "(flag)",
      label: `--effort ${EFFORT_LEVELS.join("|")} → -c model_reasoning_effort=...`,
      effort: "per spawn",
      fast: "-",
      current: cfg.workers?.codex?.defaultEffort ? `default=${cfg.workers.codex.defaultEffort}` : "-",
    });
  }

  if (!typeFilter || typeFilter === "grok") {
    const grokRows = listGrokAgentModels(cfg);
    if (grokRows.error) {
      rows.push({ type: "grok", error: grokRows.error });
    } else {
      for (const m of grokRows) {
        rows.push({
          type: "grok",
          slug: m.slug,
          label: m.label,
          effort: m.effort || "via --effort",
          fast: m.fast ? "yes" : "no",
          current: m.current || cfg.workers?.grok?.defaultModel === m.slug ? "yes" : "no",
        });
      }
    }
    rows.push({
      type: "grok",
      slug: "(flag)",
      label: `--effort ${EFFORT_LEVELS.join("|")}`,
      effort: "per spawn",
      fast: "-",
      current: cfg.workers?.grok?.defaultEffort ? `default=${cfg.workers.grok.defaultEffort}` : "-",
    });
  }

  return rows;
}

export function formatModelsTable(rows, { json } = {}) {
  if (json) return JSON.stringify(rows, null, 2);
  const printable = rows.filter((r) => !r.error);
  const errors = rows.filter((r) => r.error);
  const lines = ["TYPE\tMODEL\tEFFORT\tFAST\tCURRENT\tLABEL"];
  for (const r of printable) {
    lines.push([
      r.type,
      r.slug,
      r.effort ?? "-",
      r.fast ?? "-",
      r.current ?? "-",
      (r.label || "").replace(/\t/g, " "),
    ].join("\t"));
  }
  if (errors.length) {
    lines.push("");
    for (const e of errors) {
      lines.push(`# ${e.type}: failed to list models — ${e.error}`);
    }
  }
  return lines.join("\n");
}
