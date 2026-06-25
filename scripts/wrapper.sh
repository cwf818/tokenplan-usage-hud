#!/usr/bin/env bash
# statusLine wrapper for tokenplan-usage-hud.
#
# 1. Optionally runs an arbitrary "upstream" statusline command, captured in
#    the TOKENPLAN_UPSTREAM env var. The command string is taken from
#    $TOKENPLAN_UPSTREAM_CMD. If unset, TOKENPLAN_UPSTREAM is empty and
#    this plugin becomes the sole statusline.
# 2. Execs our bundled dist/index.js, forwarding stdin (the session JSON).
#
# Used as the body of `statusLine.command` in ~/.claude/settings.json.
#
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
SELF_CACHE_GLOB="${CLAUDE_ROOT}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/"

# Pick the highest-version installed tokenplan-usage-hud (ourselves).
SELF_DIR=$(ls -d $SELF_CACHE_GLOB 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-)

# Run the optional upstream statusline, if the user has set TOKENPLAN_UPSTREAM_CMD.
# install.sh writes this as the absolute path to <plugin-cache>/state/upstream-cmd.sh
# (a bash script with a shebang and an `exec bash -c '...'` line for the original
# statusLine command). We run it as a script, NOT pass it to `bash -c` — that
# would attempt to execute the path as a command line and fail silently.
# stdout -> TOKENPLAN_UPSTREAM. Failure / unset / empty -> TOKENPLAN_UPSTREAM="".
UPSTREAM_OUT=""
if [ -n "${TOKENPLAN_UPSTREAM_CMD:-}" ] && [ -f "$TOKENPLAN_UPSTREAM_CMD" ]; then
  UPSTREAM_OUT=$(bash "$TOKENPLAN_UPSTREAM_CMD" 2>/dev/null || true)
fi

if [ -z "$SELF_DIR" ] || [ ! -f "${SELF_DIR}dist/index.js" ]; then
  # No token-plan plugin installed — fall back to whatever upstream gave us.
  printf '%s' "$UPSTREAM_OUT"
  exit 0
fi

# Forward stdin (session JSON) to our entry, with upstream output as env var.
TOKENPLAN_UPSTREAM="$UPSTREAM_OUT" "$NODE_BIN" "${SELF_DIR}dist/index.js"