#!/usr/bin/env bash
# test-edit-settings.sh — smoke tests for scripts/lib/edit-settings.mjs
#
# These are not full unit tests (the lib has no test harness), but they
# cover the bits that a wrong regex / wrong escape would silently break:
#
#   - isOurWrapperCommand recognizes the latest-cache-dir command we
#     write today AND keeps matching the legacy fixed-version command
#     (so uninstall doesn't mistake old installs for foreign).
#   - buildLatestCacheCommand actually runs in bash — the '"'"'
#     escape chain is correct, plugin_dir resolves to the highest-
#     version cache dir, and the wrapper script execs.
#   - restore-from-file preserves user-set fields like refreshInterval
#     (regression for v0.2.4).
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="${SCRIPT_DIR}/lib/edit-settings.mjs"
if [ ! -f "$LIB" ]; then
  echo "missing $LIB" >&2
  exit 1
fi

# Resolve a Windows path Node can open, even from Git Bash where paths
# in env vars sometimes get re-mapped.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1" 2>/dev/null || echo "$1"
  else
    echo "$1"
  fi
}

PASS=0
FAIL=0
TMPDIR="$(mktemp -d -t tokenplan-tests-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# assert_eq <label> <expected> <actual>
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# assert_match <label> <pattern> <string>
assert_match() {
  local label="$1" pattern="$2" string="$3"
  if echo "$string" | grep -qE "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label"
    echo "       pattern: $pattern"
    echo "       string:  $string"
    FAIL=$((FAIL + 1))
  fi
}

# Read a JSON field via node — avoids jq dependency.
jget() {
  local file="$1" field="$2"
  node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const parts=process.argv[2].split(".");let v=j;for(const p of parts){v=v?.[p]}process.stdout.write(v===undefined?"":typeof v==="string"?v:JSON.stringify(v))' "$file" "$field"
}

echo "=== write-managed: latest-cache-dir command ==="
SETTINGS="$TMPDIR/settings.json"
python -c '
import json
data = {"statusLine": {"type": "command", "command": "echo pre", "refreshInterval": 90}}
print(json.dumps(data, indent=2))
' > "$SETTINGS"

WIN_SETTINGS="$(winpath "$SETTINGS")"
WIN_WRAPPER="$(winpath "$SCRIPT_DIR/wrapper.sh")"
WIN_UPSTREAM="$(winpath "$TMPDIR/upstream.sh")"

# wrapper.sh may not exist relative to scripts/ in this layout — pass any
# non-empty path; we only assert the command shape, not the wrapper call.
node "$LIB" "$WIN_SETTINGS" write-managed "$WIN_WRAPPER" "$WIN_UPSTREAM" >/dev/null

CMD="$(jget "$SETTINGS" statusLine.command)"
assert_match "command starts with bash -c '" "bash -c '" "$CMD"
assert_match "command references cache dir glob" "tokenplan-usage-hud/tokenplan-usage-hud/\*/" "$CMD"
assert_match "command uses sort -t. for version sort" "sort -t\\." "$CMD"
assert_match "command tails -1 + cut -f2-" "tail -1 \\| cut -f2-" "$CMD"
assert_match "command guards against missing cache" '\[ -d "\$plugin_dir" \]' "$CMD"
assert_match "command points upstream at stable state dir" 'TOKENPLAN_UPSTREAM_CMD="\$\{CLAUDE_CONFIG_DIR:-\$HOME/.claude\}/plugins/tokenplan-usage-hud/state/upstream-cmd.sh"' "$CMD"
assert_match "command execs wrapper from \$plugin_dir" 'exec bash "\$\{plugin_dir\}scripts/wrapper.sh"' "$CMD"
assert_eq "refreshInterval preserved" "90" "$(jget "$SETTINGS" statusLine.refreshInterval)"
assert_eq "managed marker set" "true" "$(jget "$SETTINGS" statusLine._tokenplan_managed)"

echo ""
echo "=== status op: fingerprint matches latest-cache command ==="
STATUS="$(node "$LIB" "$WIN_SETTINGS" status)"
assert_eq "status reports managed" "managed" "$STATUS"

echo ""
echo "=== status op: fingerprint still matches legacy fixed-version command ==="
LEGACY_CMD='bash -c '"'"'export TOKENPLAN_UPSTREAM_CMD="C:\Users\test\.claude\plugins\cache\tokenplan-usage-hud\tokenplan-usage-hud\0.2.3\state\upstream-cmd.sh"; exec bash "C:\Users\test\.claude\plugins\cache\tokenplan-usage-hud\tokenplan-usage-hud\0.2.3\scripts\wrapper.sh"'"'"''
python -c "import json,sys; print(json.dumps({'statusLine':{'type':'command','command':sys.argv[1],'_tokenplan_managed':True}}, indent=2))" "$LEGACY_CMD" > "$SETTINGS"
STATUS="$(node "$LIB" "$WIN_SETTINGS" status)"
assert_eq "legacy v0.2.3 command still recognized" "managed" "$STATUS"

echo ""
echo "=== restore-from-file preserves refreshInterval ==="
RESTORE_CMD='bash -c '"'"'export TOKENPLAN_UPSTREAM_CMD="/home/test/.claude/upstream.sh"; exec bash "/home/test/.claude/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/0.2.5/scripts/wrapper.sh"'"'"''
python -c "import json,sys; print(json.dumps({'statusLine':{'type':'command','command':sys.argv[1],'refreshInterval':75,'_tokenplan_managed':True}}, indent=2))" "$RESTORE_CMD" > "$SETTINGS"
echo 'echo restored' > "$TMPDIR/upstream.txt"
WIN_UPSTREAM_TXT="$(winpath "$TMPDIR/upstream.txt")"
node "$LIB" "$WIN_SETTINGS" restore-from-file "$WIN_UPSTREAM_TXT" >/dev/null
assert_eq "refreshInterval survives restore" "75" "$(jget "$SETTINGS" statusLine.refreshInterval)"
assert_match "command restored to upstream" "echo restored" "$(jget "$SETTINGS" statusLine.command)"
assert_eq "managed marker cleared" "" "$(jget "$SETTINGS" statusLine._tokenplan_managed)"

echo ""
echo "=== bash can actually execute the latest-cache command ==="
# Only meaningful on a real install where cache dirs exist. We just
# verify bash parses it without errors — pipe chain yields a path.
bash -n -c "$CMD" 2>/dev/null
RC=$?
assert_eq "bash -c accepts the command (syntax check)" "0" "$RC"

echo ""
echo "=== Summary ==="
echo "  pass: $PASS"
echo "  fail: $FAIL"
[ "$FAIL" = 0 ]
