#!/usr/bin/env bash
# Installer for the opencode-tokens-usage plugin.
#
# Two registration modes, both editing the global opencode.json `plugins`
# array (the documented Configure path, https://opencode.ai/v2/docs/build/plugins):
#
#   ./install.sh --package   register the published npm package by name
#                            ("opencode-tokens-usage") — recommended
#   ./install.sh             register this checkout by absolute path (dev)
#
# Mechanism, verified live on OpenCode v2.1.4 (see docs/discrepancies_verification.md):
#   * The server loads the plugin's `exports["."]` entry and reports the plugin
#     to the CLI, which loads `exports["./tui"]` automatically — no cli.json
#     entry is needed. If the TUI loads the package, both entries resolve from
#     the same node_modules, so runtime dependencies are shared.
#   * Config edits hot-reload in the running service; no service restart.
#     If the slash command does not appear, run /reload in the TUI.
#
# Usage:
#   ./install.sh [--package] [--config FILE] [--legacy-dir DIR]
#                [--dry-run] [--uninstall]
#
# Defaults:
#   config     = ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json
#   legacy-dir = ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/tokens-usage
#
# Local mode stores this checkout's absolute path; moving the repo breaks the
# registration — re-run ./install.sh (or switch to --package).
# Installing either mode removes the other registration so the plugin cannot
# load twice; --uninstall removes both.
set -euo pipefail

PACKAGE="opencode-tokens-usage"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v realpath >/dev/null 2>&1; then
  REPO="$(realpath "$SCRIPT_DIR")"
else
  REPO="$(cd "$SCRIPT_DIR" && pwd)"
fi

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
LEGACY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/tokens-usage"
MODE="local"
DRY_RUN=0
UNINSTALL=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

  --package        register the npm package "opencode-tokens-usage" instead of
                   this checkout (no clone or npm install needed)
  --config FILE    opencode.json to edit
                   (default: ${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json)
  --legacy-dir DIR directory of the old generated shims, removed if present
  --dry-run        print what would change, edit nothing
  --uninstall      remove the registration(s) again
  -h, --help       show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package)   MODE="package"; shift ;;
    --config)    CONFIG="$2"; shift 2 ;;
    --legacy-dir) LEGACY_DIR="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
done

if [[ "$MODE" == "package" ]]; then
  ENTRY="$PACKAGE"
else
  ENTRY="$REPO"
fi

echo "Mode:          $MODE"
echo "Entry:         $ENTRY"
echo "Config file:   $CONFIG"

if [[ "$MODE" == "local" ]] && [[ ! -f "$REPO/src/tui.tsx" || ! -f "$REPO/src/index.ts" || ! -f "$REPO/index.ts" || ! -f "$REPO/tui.tsx" ]]; then
  echo "error: plugin entry files not found (expected src/tui.tsx, src/index.ts, index.ts, tui.tsx next to install.sh)" >&2
  exit 1
fi

if [[ "$MODE" == "local" && ! -d "$REPO/node_modules/@opencode/plugin" ]]; then
  echo "note: dependencies are not installed; run 'npm install' in $REPO first" >&2
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required to edit the config JSON safely" >&2
  exit 1
fi

# Edit the config's plugins array atomically. Modes: add | remove.
# Prints: added | already-registered | removed | absent
# Exits 2 if the config exists but is not valid JSON (never corrupt it).
edit_config() {
  local mode="$1"
  python3 - "$CONFIG" "$ENTRY" "$REPO" "$PACKAGE" "$mode" <<'PYEOF'
import json, os, sys, tempfile, stat

cfg, entry, repo, package, mode = sys.argv[1:6]
raw = open(cfg, encoding="utf-8").read() if os.path.exists(cfg) else "{}"
try:
    doc = json.loads(raw) if raw.strip() else {}
except Exception as exc:
    print(f"error: {cfg} is not valid JSON ({exc}); refusing to modify it", file=sys.stderr)
    sys.exit(2)
if not isinstance(doc, dict):
    print(f"error: {cfg} does not contain a JSON object; refusing to modify it", file=sys.stderr)
    sys.exit(2)

def matches(item, target):
    return item == target or (isinstance(item, dict) and item.get("package") == target)

def set_plugins(entries):
    if entries:
        doc["plugins"] = entries
    else:
        doc.pop("plugins", None)

def save():
    st = os.stat(cfg) if os.path.exists(cfg) else None
    directory = os.path.dirname(cfg) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
            fh.write("\n")
        if st is not None:
            os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.replace(tmp, cfg)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

plugins = doc.get("plugins")
if plugins is None:
    plugins = []
if not isinstance(plugins, list):
    print(f"error: {cfg}: 'plugins' is not an array; refusing to modify it", file=sys.stderr)
    sys.exit(2)

if mode == "add":
    already = any(matches(e, entry) for e in plugins)
    # Drop both known registrations, then add the requested one, so the plugin
    # can never be registered twice (once by path, once by package name).
    kept = [e for e in plugins if not any(matches(e, t) for t in (repo, package))]
    if not any(matches(e, entry) for e in kept):
        kept.append(entry)
    set_plugins(kept)
    save()
    print("already-registered" if already else "added")
else:
    kept = [e for e in plugins if not any(matches(e, t) for t in (repo, package))]
    if len(kept) == len(plugins):
        print("absent")
        sys.exit(0)
    set_plugins(kept)
    save()
    print("removed")
PYEOF
}

# Remove the legacy generated-shim directory — but only if it really is ours
# (contains the marker the old installer wrote). Never touch foreign dirs.
clean_legacy() {
  if [[ ! -d "$LEGACY_DIR" ]]; then
    echo "Legacy shim dir: none ($LEGACY_DIR)"
    return 0
  fi
  if grep -qE "Generated by opencode-context-info/install\.sh|opencode-context-info/src/" "$LEGACY_DIR/index.ts" 2>/dev/null \
     || grep -qE "Generated by opencode-context-info/install\.sh|opencode-context-info/src/" "$LEGACY_DIR/tui.tsx" 2>/dev/null; then
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "[dry-run] would remove legacy shim dir: $LEGACY_DIR"
    else
      rm -rf "$LEGACY_DIR"
      echo "Removed legacy shim dir: $LEGACY_DIR"
    fi
  else
    echo "WARNING: $LEGACY_DIR does not look generated by this installer; leaving it in place." >&2
  fi
}

if [[ "$UNINSTALL" == "1" ]]; then
  if [[ ! -f "$CONFIG" ]]; then
    echo "Nothing to uninstall: $CONFIG does not exist."
  elif [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] would remove '$PACKAGE' and '$REPO' from $CONFIG plugins"
  else
    case "$(edit_config remove)" in
      removed) echo "Removed plugin registration from $CONFIG" ;;
      absent)  echo "Plugin registration not present in $CONFIG" ;;
      *) echo "error: config not modified" >&2; exit 1 ;;
    esac
  fi
  clean_legacy
  echo "Done. Config hot-reloads; use /reload in the TUI if needed."
  exit 0
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[dry-run] would register in $CONFIG plugins:"
  echo "  \"$ENTRY\""
  clean_legacy
  exit 0
fi

mkdir -p "$(dirname "$CONFIG")"
case "$(edit_config add)" in
  added)             echo "Registered plugin in $CONFIG" ;;
  already-registered) echo "Already registered in $CONFIG (no change)" ;;
  *) echo "error: config not modified" >&2; exit 1 ;;
esac
clean_legacy
if [[ "$MODE" == "local" ]]; then
  echo "Done. The config hot-reloads — run /reload in the TUI if /tokens_usage is not listed."
else
  echo "Done. OpenCode installs the package and the config hot-reloads — run /reload in the TUI if /tokens_usage is not listed."
fi
