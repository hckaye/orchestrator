import fs from "node:fs";
import path from "node:path";

const NPM_COMMANDS = new Set(["npm", "npx"]);
const DEVIN_DEFAULT_MODEL = "swe-2";
const DEVIN_DEFAULT_EFFORT = "high";
const PREVIOUS_DEVIN_DEFAULT_EFFORT = "max";
const PREVIOUS_DEVIN_DEFAULT_MODELS = new Set(["glm-5.2", "glm-5-2"]);
const CURSOR_DEFAULT_MODEL = "cursor-grok-4.6-medium";
const CURSOR_DEFAULT_EFFORT = "medium";
const PREVIOUS_CURSOR_DEFAULT_MODEL = "composer-2.5";
const GROK_DEFAULT_MODEL = "grok-4.6";
const GROK_DEFAULT_EFFORT = "medium";
const PREVIOUS_GROK_DEFAULT_MODEL = "grok-4.5";
const OPENCODE_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const OPENCODE_GO_DEFAULT_MODEL = "deepseek-v4.1-flash";
const ZEN_DEFAULT_MODEL = "deepseek-v4.1-flash";
const COMMANDER_DEFAULT_MODEL = "claude-fable-5-1[1m]";
const PREVIOUS_COMMANDER_DEFAULT_MODEL = "claude-fable-5[1m]";

const WORKER_AGENT_TARGETS = [
  { command: "devin", agent: "devin" },
  { command: "claude", agent: "claude-code" },
  { command: "codex", agent: "codex" },
  { command: "cursor-agent", agent: "cursor" },
  { command: "grok", agent: "grok" },
  { command: "opencode", agent: "opencode" },
];

export function detectInstalledSkillAgents(commandExists) {
  return WORKER_AGENT_TARGETS
    .filter(({ command }) => commandExists(command))
    .map(({ agent }) => agent);
}

export function buildSkillsInstallArgs(source, agents) {
  if (agents.length === 0) return null;
  return [
    "--yes",
    "skills",
    "add",
    source,
    "--skill",
    "orchestrator",
    "--skill",
    "orchestrator-handoff",
    "--agent",
    ...agents,
    "--global",
    "--copy",
    "--full-depth",
    "--yes",
  ];
}

export function updateConfigDefaults(config) {
  let changed = false;
  config.workers ||= {};
  if (!config.workers.devin) {
    config.workers.devin = {
      cli: "devin",
      defaultModel: DEVIN_DEFAULT_MODEL,
      defaultEffort: DEVIN_DEFAULT_EFFORT,
      permissionMode: "dangerous",
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  } else if (
    !config.workers.devin.defaultModel ||
    PREVIOUS_DEVIN_DEFAULT_MODELS.has(config.workers.devin.defaultModel)
  ) {
    config.workers.devin.defaultModel = DEVIN_DEFAULT_MODEL;
    changed = true;
  }
  if (
    !config.workers.devin.defaultEffort ||
    (config.workers.devin.defaultModel === DEVIN_DEFAULT_MODEL &&
      config.workers.devin.defaultEffort === PREVIOUS_DEVIN_DEFAULT_EFFORT)
  ) {
    config.workers.devin.defaultEffort = DEVIN_DEFAULT_EFFORT;
    changed = true;
  }
  if (!config.workers.cursor) {
    config.workers.cursor = {
      cli: "cursor-agent",
      defaultModel: CURSOR_DEFAULT_MODEL,
      defaultEffort: CURSOR_DEFAULT_EFFORT,
      yolo: true,
      trust: true,
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  } else if (
    !config.workers.cursor.defaultModel ||
    config.workers.cursor.defaultModel === PREVIOUS_CURSOR_DEFAULT_MODEL
  ) {
    config.workers.cursor.defaultModel = CURSOR_DEFAULT_MODEL;
    config.workers.cursor.defaultEffort = CURSOR_DEFAULT_EFFORT;
    changed = true;
  }
  if (!config.workers.grok) {
    config.workers.grok = {
      cli: "grok",
      defaultModel: GROK_DEFAULT_MODEL,
      defaultEffort: GROK_DEFAULT_EFFORT,
      permissionMode: "default",
      alwaysApprove: true,
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  } else if (
    !config.workers.grok.defaultModel ||
    config.workers.grok.defaultModel === PREVIOUS_GROK_DEFAULT_MODEL
  ) {
    config.workers.grok.defaultModel = GROK_DEFAULT_MODEL;
    changed = true;
  }
  if (!config.workers.grok.defaultEffort) {
    config.workers.grok.defaultEffort = GROK_DEFAULT_EFFORT;
    changed = true;
  }
  if (!config.workers.opencode) {
    config.workers.opencode = {
      cli: "opencode",
      defaultModel: OPENCODE_DEFAULT_MODEL,
      auto: true,
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  }
  if (!config.workers["opencode-go"]) {
    config.workers["opencode-go"] = {
      cli: "opencode",
      provider: "opencode-go",
      defaultModel: OPENCODE_GO_DEFAULT_MODEL,
      auto: true,
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  }
  if (!config.workers.zen) {
    config.workers.zen = {
      cli: "opencode",
      provider: "opencode",
      defaultModel: ZEN_DEFAULT_MODEL,
      auto: true,
      printMode: true,
      extraArgs: [],
    };
    changed = true;
  }
  if (config.commander?.defaultModel === PREVIOUS_COMMANDER_DEFAULT_MODEL) {
    config.commander.defaultModel = COMMANDER_DEFAULT_MODEL;
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
  for (const type of ["opencode", "opencode-go", "zen"]) {
    if (!config.permissionBridge.patterns[type]) {
      config.permissionBridge.patterns[type] = [
        { regex: "Allow|approve|permission|permit|proceed", type: "permission" },
        { regex: "\\?\\s*$", type: "question" },
      ];
      changed = true;
    }
  }
  return changed;
}

/**
 * Resolve npm/npx to their JavaScript entry point on Windows.
 *
 * Recent Node.js releases reject spawning .cmd files directly with EINVAL.
 * Running the bundled CLI with node also avoids cmd.exe quoting issues.
 */
export function resolveNpmInvocation(name, args, options = {}) {
  if (!NPM_COMMANDS.has(name)) throw new Error(`Unsupported npm command: ${name}`);

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: name, args };

  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? fs.existsSync;
  const pathApi = path.win32;
  const cliName = `${name}-cli.js`;
  const candidates = [];

  if (env.npm_execpath) {
    candidates.push(pathApi.join(pathApi.dirname(env.npm_execpath), cliName));
  }

  const commandDirectories = [
    pathApi.dirname(execPath),
    ...(env.PATH || "").split(";").filter(Boolean),
  ];
  for (const directory of commandDirectories) {
    candidates.push(pathApi.join(directory, "node_modules", "npm", "bin", cliName));
  }

  const cliPath = candidates.find((candidate, index) =>
    candidates.indexOf(candidate) === index && existsSync(candidate)
  );
  if (!cliPath) {
    throw new Error(
      `Could not locate ${cliName}. Reinstall Node.js with npm included, or add npm to PATH.`
    );
  }

  return { command: execPath, args: [cliPath, ...args] };
}
