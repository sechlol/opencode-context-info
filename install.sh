#!/usr/bin/env bash
# Thin wrapper: all installer logic lives in scripts/install.ts.
#
#   ./install.sh              add this checkout to the global opencode.json
#   ./install.sh --uninstall  remove it again
#
# The entry is an absolute path: keep the repo where it is, or re-run this
# script after moving it. opencode.json hot-reloads on save; run /reload in the
# TUI if /tokens_usage does not show up.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec node --experimental-strip-types --disable-warning=ExperimentalWarning "$DIR/scripts/install.ts" "$@"
