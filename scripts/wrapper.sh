#!/usr/bin/env bash
# statusLine wrapper: runs the installed claude-hud (if present), then pipes
# the upstream output through our token-plan plugin via TOKENPLAN_UPSTREAM.
#
# Used as the body of `statusLine.command` in ~/.claude/settings.json.
#
# Tolerates missing claude-hud (TOKENPLAN_UPSTREAM stays empty) so this
# plugin still works as the sole statusline provider.
# Portable: works on Linux, macOS, and Git Bash on Windows.

set -u

# Resolve node: prefer what's already on PATH, fall back to common locations.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "/c/Program Files/nodejs/node" "/usr/local/bin/node" "/usr/bin/node"; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "tokenplan-usage-hud: node not found on PATH" >&2
  exit 0
fi

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HUD_CACHE_GLOB="${CLAUDE_ROOT}/plugins/cache/claude-hud/claude-hud/*/"
SELF_CACHE_GLOB="${CLAUDE_ROOT}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/"

# Pick the highest-version installed claude-hud (mirrors the sort pattern in
# the existing settings.json snippet).
HUD_DIR=$(ls -d $HUD_CACHE_GLOB 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-)

# Pick the highest-version installed tokenplan-usage-hud (ourselves).
SELF_DIR=$(ls -d $SELF_CACHE_GLOB 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-)

# Run claude-hud. Tolerate failure or absence — empty upstream is fine.
HUD_OUT=""
if [ -n "$HUD_DIR" ] && [ -f "${HUD_DIR}dist/index.js" ]; then
  HUD_OUT=$("$NODE_BIN" "${HUD_DIR}dist/index.js" 2>/dev/null || true)
fi

if [ -z "$SELF_DIR" ] || [ ! -f "${SELF_DIR}dist/index.js" ]; then
  # No token-plan plugin installed — fall back to whatever upstream gave us.
  printf '%s' "$HUD_OUT"
  exit 0
fi

# Forward stdin (session JSON) to our entry, with upstream output as env var.
TOKENPLAN_UPSTREAM="$HUD_OUT" "$NODE_BIN" "${SELF_DIR}dist/index.js"