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

// Cache of `devin models list` slugs, fetched at most once per process.
let devinSlugCache;
export function devinModelSlugs(cli = "devin") {
  if (devinSlugCache !== undefined) return devinSlugCache;
  try {
    const out = execFileSync(cli, ["models", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    const slugs = parseDevinModelsList(out);
    devinSlugCache = slugs.length ? slugs : null;
  } catch {
    devinSlugCache = null;
  }
  return devinSlugCache;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// `devin models list` prints family headers at column 0 and indented rows of
// "<slug>  <label>". Aliases lines ("aliases: swe") and wrapped label
// continuations are filtered out by the slug shape check.
function parseDevinModelsList(text) {
  const slugs = [];
  for (const line of String(text).replace(ANSI_RE, "").split("\n")) {
    const m = line.match(/^\s+(\S+?)\s{2,}\S/);
    if (!m) continue;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(m[1])) continue;
    slugs.push(m[1]);
  }
  return slugs;
}

// Devin has no effort flag; effort is a model-slug suffix (swe-2-max).
// Rewrite to the listed <base>-<level> variant when one exists; leave the
// model unchanged otherwise (e.g. adaptive, swe-1-6 have no such variants).
export function applyDevinModelEffort(model, effort, knownSlugs = null) {
  if (!effort || !model) return model;
  const e = normalizeEffort(effort);
  const base = stripEffortSuffix(model);
  const candidates = [`${base}-${e}`];
  // context-size suffixes stay last in the listed slug (glm-5-2-max-1m)
  const ctx = base.match(/^(.*?)-(1m)$/i);
  if (ctx) candidates.push(`${ctx[1]}-${e}-${ctx[2]}`);
  if (Array.isArray(knownSlugs) && knownSlugs.length) {
    // users may write dotted spellings (glm-5.2) where the listed slug uses
    // dashes (glm-5-2); normalize before comparing and return the canonical
    // listed slug
    const norm = (s) => s.toLowerCase().replace(/\./g, "-");
    for (const c of candidates) {
      const hit = knownSlugs.find((s) => norm(s) === norm(c));
      if (hit) return hit;
    }
    return model;
  }
  // no authoritative list: rewrite only slugs already carrying a tier
  return extractEffortFromSlug(model) ? candidates[0] : model;
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
      slug: cfg.workers?.grok?.defaultModel || "grok-4.6",
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
  { slug: "claude-fable-5-1[1m]", label: "Fable 5.1 1M", effort: "via --effort" },
  { slug: "opus", label: "Opus (latest alias)", effort: "via --effort" },
  { slug: "claude-opus-5", label: "Opus 5.0", effort: "via --effort" },
  { slug: "claude-opus-4-8[1m]", label: "Opus 4.8 1M", effort: "via --effort" },
  { slug: "sonnet", label: "Sonnet (latest alias)", effort: "via --effort" },
  { slug: "claude-sonnet-5[1m]", label: "Sonnet 5 1M", effort: "via --effort" },
];

const DEVIN_MODELS = [
  { slug: "swe-2", label: "SWE-2", effort: "via model suffix" },
  { slug: "glm-5.2", label: "GLM 5.2", effort: "via model suffix" },
  { slug: "swe-1-7", label: "SWE 1.7", effort: "via model suffix" },
  { slug: "opus", label: "Opus (latest alias)", effort: "via model suffix" },
  { slug: "codex", label: "Codex (via Devin)", effort: "via model suffix" },
  { slug: "claude-opus-4.6", label: "Claude Opus 4.6 (via Devin)", effort: "via model suffix" },
  { slug: "claude-sonnet-4", label: "Claude Sonnet 4 (via Devin)", effort: "via model suffix" },
];

const CODEX_MODELS = [
  { slug: "gpt-5.6-luna", label: "GPT-5.6 Luna", effort: "via --effort" },
  { slug: "gpt-5.6-terra", label: "GPT-5.6 Terra", effort: "via --effort" },
  { slug: "gpt-5.6-sol", label: "GPT-5.6 Sol", effort: "via --effort" },
  { slug: "gpt-6-astra", label: "GPT-6 Astra", effort: "via --effort" },
];

// opencode workers take a full provider/model id — the provider is whatever
// the user's opencode install has configured (deepseek, zhipuai, openai, ...).
const OPENCODE_MODELS = [
  { slug: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", effort: "via --variant" },
  { slug: "zhipuai/glm-5.3-flash", label: "GLM-5.3 Flash", effort: "via --variant" },
  { slug: "opencode/big-pickle", label: "Big Pickle (Zen free)", effort: "via --variant" },
];

// opencode-go / zen workers pin a provider; slugs here are the bare model ids
// the adapter prefixes with opencode-go/ or opencode/.
const OPENCODE_GO_MODELS = [
  { slug: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", effort: "via --variant" },
  { slug: "glm-5.3-flash", label: "GLM-5.3 Flash", effort: "via --variant" },
  { slug: "deepseek-v4-pro", label: "DeepSeek V4 Pro", effort: "via --variant" },
  { slug: "kimi-k3", label: "Kimi K3", effort: "via --variant" },
];

const ZEN_MODELS = [
  { slug: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", effort: "via --variant" },
  { slug: "glm-5.3-flash", label: "GLM-5.3 Flash", effort: "via --variant" },
  { slug: "deepseek-v4-flash", label: "DeepSeek V4 Flash", effort: "via --variant" },
  { slug: "deepseek-v4-pro", label: "DeepSeek V4 Pro", effort: "via --variant" },
  { slug: "kimi-k3", label: "Kimi K3", effort: "via --variant" },
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
    rows.push({
      type: "devin",
      slug: "(flag)",
      label: `--effort ${EFFORT_LEVELS.join("|")} → <base>-<level> model variant`,
      effort: "per spawn",
      fast: "-",
      current: cfg.workers?.devin?.defaultEffort ? `default=${cfg.workers.devin.defaultEffort}` : "-",
    });
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

  const OPENCODE_LISTS = {
    opencode: OPENCODE_MODELS,
    "opencode-go": OPENCODE_GO_MODELS,
    zen: ZEN_MODELS,
  };
  for (const type of Object.keys(OPENCODE_LISTS)) {
    if (typeFilter && typeFilter !== type) continue;
    for (const m of OPENCODE_LISTS[type]) {
      rows.push({
        type,
        slug: m.slug,
        label: m.label,
        effort: m.effort,
        fast: "-",
        current: cfg.workers?.[type]?.defaultModel === m.slug ? "yes" : "no",
      });
    }
    rows.push({
      type,
      slug: "(flag)",
      label: `--effort ${EFFORT_LEVELS.join("|")} → --variant <level>`,
      effort: "per spawn",
      fast: "-",
      current: cfg.workers?.[type]?.defaultEffort ? `default=${cfg.workers[type].defaultEffort}` : "-",
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
