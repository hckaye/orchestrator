export const WORKER_CONTEXT_ENV = "ORCHESTRATOR_WORKER_ID";

const SPAWN_COMMANDS = new Set(["spawn", "handoff-spawn"]);

export const NO_SUBWORKERS_CONSTRAINT = [
  "## Worker delegation limit",
  "- Complete the assigned work yourself. Do not create or delegate to subagents, subworkers, or other coding agents.",
  "- Do not run `orchestrator spawn` or `orchestrator handoff-spawn`.",
].join("\n");

export function buildWorkerPrompt(task, configuredSuffix = "") {
  const parts = [String(task || "").trimEnd()];
  if (configuredSuffix) parts.push(String(configuredSuffix).trim());
  parts.push(NO_SUBWORKERS_CONSTRAINT);
  return parts.filter(Boolean).join("\n\n");
}

export function workerEnvironment(workerId, baseEnv = process.env) {
  return { ...baseEnv, [WORKER_CONTEXT_ENV]: workerId };
}

export function nestedSpawnError(command, env = process.env) {
  const parentId = env[WORKER_CONTEXT_ENV];
  if (!parentId || !SPAWN_COMMANDS.has(command)) return null;
  return `worker ${parentId} cannot start another worker`;
}
