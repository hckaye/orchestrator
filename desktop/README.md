# Orchestrator Desktop

Electron UI for watching **orchestrator** workers, live processes, and their parent project context.

## Install the desktop app

```bash
cd desktop
npm install
npm run install:app
```

The command detects the current OS, builds the app, installs it for the current user, and launches it. It installs an `.app` on macOS, a Start Menu application on Windows, or a `.desktop` launcher on Linux.

To create distributable packages on the matching OS:

```bash
npm run dist:mac    # DMG and ZIP
npm run dist:win    # NSIS installer and portable EXE
npm run dist:linux  # AppImage, deb, and tar.gz
```

Rebuild/reinstall after code changes with the same `npm run install:app`.

## Dev

```bash
cd desktop
npm install
npm start
```

## What you see

| Area | Purpose |
|------|---------|
| **Sidebar → Projects** | Parent = repository. Click header to expand related worker tabs |
| **Sidebar → Workers** | Flat list with status / type filters |
| **Sidebar → Processes** | Live supervisors / CLI / wait, grouped by parent |
| **Tab scope** | Selecting a parent replaces all tabs with that family's workers; other parents' tabs close |
| **All terminals** | Multiplex live logs for every worker under the parent |
| **Terminal (default)** | Terminal-style realtime log follow for one worker |
| **Overview / Process / Chain / JSON** | Metadata, process tree, handoff chain, raw state |

Data is read from `~/.orchestrator/workers/*.json` and the process table. No daemon is required; the app watches the state directory and rescans processes every few seconds.

## Shortcuts

- **⌘W / Ctrl+W** — close active tab
- **↻** (title bar) — force refresh

## Notes

- “Parent session” here means the **project context** (repo / cwd / base branch) that spawned the worker, plus **handoff chains** (`handoffFrom` → current → `handedOffTo`). Orchestrator does not currently store a commander session id on each worker.
- Live process detection matches `node …/worker.js <id>` and `orchestrator wait <id>`.
