#!/usr/bin/env bash
# install.sh — install the orchestrator tool + skill on this machine.
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ORCH_HOME="${ORCH_HOME:-$HOME/.orchestrator}"
CLAUDE_SKILL_DIR="$HOME/.claude/skills/orchestrator"
CLAUDE_HANDOFF_SKILL_DIR="$HOME/.claude/skills/orchestrator-handoff"
DEVIN_SKILL_DIR="$HOME/.config/devin/skills/orchestrator"
DEVIN_HANDOFF_SKILL_DIR="$HOME/.config/devin/skills/orchestrator-handoff"
CODEX_SKILL_DIR="$HOME/.codex/skills/orchestrator"
CODEX_HANDOFF_SKILL_DIR="$HOME/.codex/skills/orchestrator-handoff"
GROK_SKILL_DIR="$HOME/.grok/skills/orchestrator"
GROK_HANDOFF_SKILL_DIR="$HOME/.grok/skills/orchestrator-handoff"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

echo "==> Installing orchestrator to $ORCH_HOME"
mkdir -p "$ORCH_HOME" "$ORCH_HOME/lib" "$ORCH_HOME/logs" "$ORCH_HOME/workers"

cp "$SCRIPT_DIR/orchestrator/orchestrator.js" "$ORCH_HOME/orchestrator.js"
chmod +x "$ORCH_HOME/orchestrator.js"
cp "$SCRIPT_DIR/orchestrator/lib/"*.js "$ORCH_HOME/lib/"
cp "$SCRIPT_DIR/orchestrator/package.json" "$ORCH_HOME/package.json"

# config: preserve existing user config, only seed on first install
if [ ! -f "$ORCH_HOME/config.json" ]; then
  cp "$SCRIPT_DIR/orchestrator/config.example.json" "$ORCH_HOME/config.json"
  echo "    seeded config.json from example (edit at $ORCH_HOME/config.json)"
else
  echo "    kept existing config.json"
fi

# Add newly supported worker types without overwriting user configuration.
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
let changed = false;
cfg.workers ||= {};
if (!cfg.workers.grok) {
  cfg.workers.grok = {
    cli: "grok",
    defaultModel: "grok-4.5",
    permissionMode: "default",
    alwaysApprove: true,
    printMode: true,
    extraArgs: [],
  };
  changed = true;
}
cfg.permissionBridge ||= {};
cfg.permissionBridge.patterns ||= {};
if (!cfg.permissionBridge.patterns.grok) {
  cfg.permissionBridge.patterns.grok = [
    { regex: "Allow|approve|permission|Do you want to", type: "permission" },
    { regex: "\\?\\s*$", type: "question" },
  ];
  changed = true;
}
if (changed) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
' "$ORCH_HOME/config.json"

echo "==> Installing node dependencies (node-pty) in $ORCH_HOME"
( cd "$ORCH_HOME" && npm install --silent --no-audit --no-fund )

echo "==> Linking CLI to $BIN_DIR/orchestrator"
mkdir -p "$BIN_DIR"
ln -sf "$ORCH_HOME/orchestrator.js" "$BIN_DIR/orchestrator"

echo "==> Installing skill to $CLAUDE_SKILL_DIR"
mkdir -p "$CLAUDE_SKILL_DIR"
cp "$SCRIPT_DIR/skill/SKILL.md" "$CLAUDE_SKILL_DIR/SKILL.md"

echo "==> Installing handoff skill to $CLAUDE_HANDOFF_SKILL_DIR"
mkdir -p "$CLAUDE_HANDOFF_SKILL_DIR"
cp "$SCRIPT_DIR/skill/handoff/SKILL.md" "$CLAUDE_HANDOFF_SKILL_DIR/SKILL.md"

echo "==> Installing skill to $DEVIN_SKILL_DIR"
mkdir -p "$DEVIN_SKILL_DIR"
cp "$SCRIPT_DIR/skill/SKILL.md" "$DEVIN_SKILL_DIR/SKILL.md"

echo "==> Installing handoff skill to $DEVIN_HANDOFF_SKILL_DIR"
mkdir -p "$DEVIN_HANDOFF_SKILL_DIR"
cp "$SCRIPT_DIR/skill/handoff/SKILL.md" "$DEVIN_HANDOFF_SKILL_DIR/SKILL.md"

echo "==> Installing skill to $CODEX_SKILL_DIR"
mkdir -p "$CODEX_SKILL_DIR"
cp "$SCRIPT_DIR/skill/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md"

echo "==> Installing handoff skill to $CODEX_HANDOFF_SKILL_DIR"
mkdir -p "$CODEX_HANDOFF_SKILL_DIR"
cp "$SCRIPT_DIR/skill/handoff/SKILL.md" "$CODEX_HANDOFF_SKILL_DIR/SKILL.md"

echo "==> Installing skill to $GROK_SKILL_DIR"
mkdir -p "$GROK_SKILL_DIR"
cp "$SCRIPT_DIR/skill/SKILL.md" "$GROK_SKILL_DIR/SKILL.md"

echo "==> Installing handoff skill to $GROK_HANDOFF_SKILL_DIR"
mkdir -p "$GROK_HANDOFF_SKILL_DIR"
cp "$SCRIPT_DIR/skill/handoff/SKILL.md" "$GROK_HANDOFF_SKILL_DIR/SKILL.md"

# PATH check
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""
     echo "WARNING: $BIN_DIR is not in your PATH."
     echo "  Add this to your shell rc (~/.zshrc or ~/.bashrc):"
     echo "    export PATH=\"$BIN_DIR:\$PATH\""
     ;;
esac

# Sanity check
echo ""
echo "==> Verifying"
if command -v orchestrator >/dev/null 2>&1; then
  echo "  orchestrator: $(command -v orchestrator)"
  orchestrator --help >/dev/null 2>&1 && echo "  CLI runs OK" || echo "  CLI ran but exited non-zero (may still be usable)"
else
  echo "  orchestrator not on PATH yet — open a new shell or 'source ~/.zshrc'"
fi

for cli in devin claude codex cursor-agent grok; do
  if command -v "$cli" >/dev/null 2>&1; then
    echo "  worker CLI $cli: $(command -v "$cli")"
  else
    echo "  worker CLI $cli: NOT FOUND (install it if you want to use that worker type)"
  fi
done

echo ""
echo "Done. Skill names: 'orchestrator', 'orchestrator-handoff'. Tool front: 'orchestrator --help'."
