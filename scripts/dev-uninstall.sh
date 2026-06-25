#!/usr/bin/env bash
# dev-uninstall.sh — DEV-ONLY: wipe all on-disk state for tokenplan-usage-hud
# so /plugin install can re-fetch a clean copy from the marketplace.
#
# This script does NOT touch:
#   - ~/.claude/settings.json (statusLine, env, etc.)
#   - Any other plugin's cache, marketplace, or installed_plugins.json entry
#
# It DOES delete:
#   - The tokenplan-usage-hud row from installed_plugins.json
#   - cache/tokenplan-usage-hud/tokenplan-usage-hud/<version>/*
#   - marketplaces/tokenplan-usage-hud/* and marketplaces/cwf818-tokenplan-usage-hud/*
#   - The tokenplan-usage-hud entry from known_marketplaces.json
#
# A timestamped backup of installed_plugins.json and known_marketplaces.json is
# written next to the originals, so you can restore if something goes wrong.
#
# Usage:
#   scripts/dev-uninstall.sh           # actually delete
#   scripts/dev-uninstall.sh --dry-run # show what would be deleted, no changes
#
# After this script, the user can re-run:
#   /plugin marketplace add cwf818/tokenplan-usage-hud
#   /plugin install tokenplan-usage-hud@tokenplan-usage-hud
#   /reload-plugins
#   /tokenplan-usage-hud:install
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ] || [ "${1:-}" = "-n" ]; then
  DRY_RUN=1
elif [ -n "${1:-}" ]; then
  echo "dev-uninstall.sh: unknown argument: $1" >&2
  echo "  usage: dev-uninstall.sh [--dry-run]" >&2
  exit 2
fi

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="${CLAUDE_ROOT}/plugins"

# Paths this script touches.
CACHE_DIR="${PLUGINS_DIR}/cache/tokenplan-usage-hud"
MARKETPLACE_DIR="${PLUGINS_DIR}/marketplaces/tokenplan-usage-hud"
TMP_MARKETPLACE_DIR="${PLUGINS_DIR}/marketplaces/cwf818-tokenplan-usage-hud"
INSTALLED_JSON="${PLUGINS_DIR}/installed_plugins.json"
KNOWN_JSON="${PLUGINS_DIR}/known_marketplaces.json"

TS=$(date +%Y%m%dT%H%M%S)

# Collect what we'll do.
ACTIONS=()
EXISTING=0

if [ -d "$CACHE_DIR" ]; then
  EXISTING=1
  ACTIONS+=("rm -rf ${CACHE_DIR}")
fi
if [ -d "$MARKETPLACE_DIR" ]; then
  EXISTING=1
  ACTIONS+=("rm -rf ${MARKETPLACE_DIR}")
fi
if [ -d "$TMP_MARKETPLACE_DIR" ]; then
  EXISTING=1
  ACTIONS+=("rm -rf ${TMP_MARKETPLACE_DIR}")
fi
if [ -f "$INSTALLED_JSON" ] && grep -q '"tokenplan-usage-hud@tokenplan-usage-hud"' "$INSTALLED_JSON"; then
  EXISTING=1
  ACTIONS+=("node -e strip tokenplan row from ${INSTALLED_JSON}")
fi
if [ -f "$KNOWN_JSON" ] && grep -q '"tokenplan-usage-hud"' "$KNOWN_JSON"; then
  EXISTING=1
  ACTIONS+=("node -e strip tokenplan row from ${KNOWN_JSON}")
fi

if [ "$EXISTING" = 0 ]; then
  echo "dev-uninstall.sh: nothing to remove — tokenplan-usage-hud is not on disk"
  exit 0
fi

echo "dev-uninstall.sh: plan"
for a in "${ACTIONS[@]}"; do
  echo "  $a"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "dev-uninstall.sh: --dry-run, no changes made"
  exit 0
fi

# Back up the JSON files we will edit. The cache and marketplace directories
# are by design re-creatable from the marketplace, so we don't back them up.
if [ -f "$INSTALLED_JSON" ] && grep -q '"tokenplan-usage-hud@tokenplan-usage-hud"' "$INSTALLED_JSON"; then
  cp "$INSTALLED_JSON" "${INSTALLED_JSON}.bak.${TS}"
  echo "dev-uninstall.sh: backup ${INSTALLED_JSON} -> ${INSTALLED_JSON}.bak.${TS}"
fi
if [ -f "$KNOWN_JSON" ] && grep -q '"tokenplan-usage-hud"' "$KNOWN_JSON"; then
  cp "$KNOWN_JSON" "${KNOWN_JSON}.bak.${TS}"
  echo "dev-uninstall.sh: backup ${KNOWN_JSON} -> ${KNOWN_JSON}.bak.${TS}"
fi

# Cache and marketplace directories: rm -rf.
if [ -d "$CACHE_DIR" ]; then
  rm -rf "$CACHE_DIR"
  echo "dev-uninstall.sh: removed ${CACHE_DIR}"
fi
if [ -d "$MARKETPLACE_DIR" ]; then
  rm -rf "$MARKETPLACE_DIR"
  echo "dev-uninstall.sh: removed ${MARKETPLACE_DIR}"
fi
if [ -d "$TMP_MARKETPLACE_DIR" ]; then
  rm -rf "$TMP_MARKETPLACE_DIR"
  echo "dev-uninstall.sh: removed ${TMP_MARKETPLACE_DIR}"
fi

# Strip the tokenplan row from installed_plugins.json. We use node because the
# shell can't round-trip JSON safely. Preserve the original line endings.
strip_tokenplan_from_json() {
  local file="$1"
  local key="$2"
  if ! command -v node >/dev/null 2>&1; then
    echo "dev-uninstall.sh: node not found on PATH; cannot edit ${file}" >&2
    return 1
  fi
  local win_path
  if command -v cygpath >/dev/null 2>&1; then
    win_path=$(cygpath -w "$file" 2>/dev/null || echo "$file")
  else
    win_path="$file"
  fi
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const key = process.argv[2];
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.plugins && Object.prototype.hasOwnProperty.call(data.plugins, key)) {
      delete data.plugins[key];
    }
    let eol = "\n";
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.includes(0x0d)) eol = "\r\n";
    }
    const body = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(file, body.replace(/\n/g, eol));
  ' "$win_path" "$key"
}

if [ -f "$INSTALLED_JSON" ] && grep -q '"tokenplan-usage-hud@tokenplan-usage-hud"' "$INSTALLED_JSON"; then
  strip_tokenplan_from_json "$INSTALLED_JSON" "tokenplan-usage-hud@tokenplan-usage-hud" \
    && echo "dev-uninstall.sh: stripped tokenplan row from ${INSTALLED_JSON}" \
    || echo "dev-uninstall.sh: failed to strip ${INSTALLED_JSON} (restore from .bak.${TS})" >&2
fi
if [ -f "$KNOWN_JSON" ] && grep -q '"tokenplan-usage-hud"' "$KNOWN_JSON"; then
  strip_tokenplan_from_json "$KNOWN_JSON" "tokenplan-usage-hud" \
    && echo "dev-uninstall.sh: stripped tokenplan row from ${KNOWN_JSON}" \
    || echo "dev-uninstall.sh: failed to strip ${KNOWN_JSON} (restore from .bak.${TS})" >&2
fi

echo ""
echo "dev-uninstall.sh: done. Re-install with:"
echo "  /plugin marketplace add cwf818/tokenplan-usage-hud"
echo "  /plugin install tokenplan-usage-hud@tokenplan-usage-hud"
echo "  /reload-plugins"
echo "  /tokenplan-usage-hud:install"
