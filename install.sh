#!/usr/bin/env bash
# POSIX entry point; the implementation lives in install.js for Windows too.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/install.js" "$@"
