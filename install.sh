#!/usr/bin/env bash
# Installer for the opencode-tokens-usage CLI plugin.
#
# Registers the plugin path in the user's OpenCode config (opencode.json).
# OpenCode loads the `./tui` export of a plugin package listed there, which is
# the form verified to load on v2.1.4 (local paths in cli.json are NOT loaded
# by the CLI reconciliation in 2.1.4).
#
# Usage:
#   ./install.sh [--target DIR] [--dry-run] [--uninstall]
#
# Defaults:
#   target = ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json
#
# Notes:
#   - Close OpenCode before running: opencode rewrites its config itself and
#     racing it can lose edits.
#   - Do NOT also register this plugin in cli.json — loading it from both
#     configs double-loads the TUI entry (duplicate /tokens_usage commands).
#   - If OPENCODE_CONFIG_CONTENT is set, it REPLACES the file's plugins array
#     for the session — the installer warns and prints the manual snippet.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
ENTRY="${SCRIPT_DIR}"

DRY_RUN=0
UNINSTALL=0
TARGET="$DEFAULT_TARGET"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1 (see --help)" >&2
      exit 1
      ;;
  esac
done

# Resolve entry to a real path for dedup checks and stable registration.
if command -v realpath >/dev/null 2>&1; then
  ENTRY="$(realpath "$SCRIPT_DIR")"
else
  ENTRY="$(cd "$SCRIPT_DIR" && pwd)"
fi

echo "Config target: $TARGET"
echo "Plugin entry:  $ENTRY"

if [[ ! -f "$SCRIPT_DIR/src/tui.tsx" || ! -f "$SCRIPT_DIR/src/index.ts" ]]; then
  echo "error: plugin sources not found next to install.sh (expected src/tui.tsx and src/index.ts)" >&2
  exit 1
fi

# Warn about a duplicate registration in cli.json (double-load of the TUI entry).
CLI_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/cli.json"
if [[ -f "$CLI_CONFIG" ]] && grep -q "opencode-tokens-usage\|opencode-context-info" "$CLI_CONFIG" 2>/dev/null; then
  cat >&2 <<EOF
WARNING: this plugin also appears in $CLI_CONFIG.
Loading it from BOTH cli.json and opencode.json double-loads the TUI entry
(duplicate /tokens_usage commands). Remove the cli.json entry:
  ./install.sh --target $CLI_CONFIG --uninstall
EOF
fi

if [[ -n "${OPENCODE_CONFIG_CONTENT:-}" ]]; then
  cat >&2 <<EOF
WARNING: OPENCODE_CONFIG_CONTENT is set. It REPLACES the plugins array from
$TARGET while defined, so an entry added here may be ignored. Add the entry
to the variable's JSON instead:

  "plugins": [ ...existing..., "$ENTRY" ]
EOF
fi

write_fresh() {
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugins": [\n    "%s"\n  ]\n}\n' "$ENTRY" > "$TARGET"
  chmod 600 "$TARGET" 2>/dev/null || true
}

if [[ ! -f "$TARGET" ]]; then
  if [[ "$UNINSTALL" == "1" ]]; then
    echo "Nothing to uninstall: $TARGET does not exist."
    exit 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] would create $TARGET with:"
    printf '%s\n' "{\"plugins\": [\"$ENTRY\"]}"
    exit 0
  fi
  mkdir -p "$(dirname "$TARGET")"
  write_fresh
  echo "Created $TARGET"
  echo "Done. Start OpenCode and run /tokens_usage."
  exit 0
fi

# Refuse to rewrite a JSONC file we cannot parse — print the snippet instead.
if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$TARGET" >/dev/null 2>&1; then
  cat >&2 <<EOF
WARNING: $TARGET is not valid JSON (comments or trailing commas).
Refusing to rewrite it. Add this entry to its "plugins" array manually:

  "plugins": [
    ...,
    "$ENTRY"
  ]

Then restart OpenCode.
EOF
  exit 2
fi

BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
TMP="$TARGET.tmp.$$"

MODE=0
if [[ "$UNINSTALL" == "1" ]]; then
  MODE=1
fi

CHANGED=0
python3 - "$TARGET" "$ENTRY" "$MODE" "$TMP" <<'PY' && CHANGED=1 || CHANGED=$?
import json
import os
import sys

target, entry, uninstall, tmp = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
NOOP = 3
with open(target) as f:
    data = json.load(f)

plugins = data.get("plugins", [])
if not isinstance(plugins, list):
    print("error: 'plugins' in config is not an array; edit it manually", file=sys.stderr)
    sys.exit(1)


def norm(p):
    p = str(p)
    if p.startswith("file://"):
        p = p[len("file://"):]
    return os.path.normpath(p)


def matches(item):
    if isinstance(item, str):
        return norm(item) == wanted
    if isinstance(item, dict):
        return norm(item.get("package", "")) == wanted
    return False


wanted = norm(entry)

present = [i for i, item in enumerate(plugins) if matches(item)]
if uninstall:
    if not present:
        print(f"Entry not present in {target}; nothing to do.")
        sys.exit(NOOP)
    data["plugins"] = [p for i, p in enumerate(plugins) if i not in present]
    action = "removed"
else:
    if present:
        print(f"Entry already present in {target}; nothing to do.")
        sys.exit(NOOP)
    data["plugins"] = plugins + [entry]
    action = "added"

with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"Entry {action} ({len(data['plugins'])} plugin(s) total).")
sys.exit(0)
PY

if [[ "$CHANGED" == "3" ]]; then
  # Nothing changed (already present / not present) — clean exit.
  exit 0
fi

if [[ "$CHANGED" != "1" ]]; then
  echo "error: config update failed (exit $CHANGED)" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] changes for $TARGET:"
  python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get('plugins', []), indent=2))" "$TMP"
  rm -f "$TMP"
  exit 0
fi

cp "$TARGET" "$BACKUP"
chmod --reference="$TARGET" "$TMP" 2>/dev/null || chmod 600 "$TMP" 2>/dev/null || true
if mv "$TMP" "$TARGET"; then
  # validate the result; restore on failure
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$TARGET" >/dev/null 2>&1; then
    echo "Backup written to $BACKUP"
    echo "Done. Start OpenCode and run /tokens_usage."
  else
    echo "error: result failed validation; restoring backup" >&2
    mv "$BACKUP" "$TARGET"
    exit 1
  fi
else
  echo "error: atomic replace failed" >&2
  rm -f "$TMP"
  exit 1
fi
