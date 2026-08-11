export function buildOrchestratorInvocation(bin, argv, {
  execPath = process.execPath,
  env = process.env,
  electron = Boolean(process.versions.electron),
} = {}) {
  const isJs = bin.endsWith(".js");
  const command = isJs ? execPath : bin;
  const args = isJs ? [bin, ...argv] : argv;

  // In a packaged Electron app process.execPath points at the app executable,
  // not a standalone Node binary. This flag makes Electron execute the CLI
  // script instead of opening another desktop window.
  const childEnv = isJs && electron
    ? { ...env, ELECTRON_RUN_AS_NODE: "1" }
    : env;

  return { command, args, env: childEnv };
}
