#!/usr/bin/env bash
# test-install.sh — smoke tests for the no-op / state-carry-forward
# branch in scripts/install.sh.
#
# The branch under test:
#   - When statusLine._tokenplan_managed === true and PLUGIN_DIR/state/
#     is missing the upstream-cmd.txt, install.sh walks PLUGIN_BASE,
#     finds the SECOND-newest version dir (the one immediately before
#     PLUGIN_DIR in version order), and copies its state/ files
#     (upstream-cmd.sh + upstream-cmd.txt) into PLUGIN_DIR/state/.
#   - The copy is "no clobber" — files already in PLUGIN_DIR/state/
#     (because Claude Code's marketplace loader already copied them,
#     or because a previous :install set them) are not overwritten.
#
# These tests don't try to drive the real install.sh against the real
# user settings.json; they build a minimal PLUGIN_BASE (two version
# dirs) and a synthetic settings.json, then invoke install.sh with
# HOME / CLAUDE_CONFIG_DIR pointed at the fixture. The user-level path
# is exercised; project-level uses the same code path for the no-op
# branch.
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/install.sh"
if [ ! -f "$INSTALL_SH" ]; then
  echo "missing $INSTALL_SH" >&2
  exit 1
fi

# --- Test helpers ------------------------------------------------------------

PASS=0
FAIL=0

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

assert_file_exists() {
  local label="$1" path="$2"
  if [ -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (missing: $path)"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_missing() {
  local label="$1" path="$2"
  if [ ! -f "$path" ]; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (unexpected file: $path)"
    FAIL=$((FAIL + 1))
  fi
}

# Build a fresh fixture:
#   $ROOT/                          (synthetic CLAUDE_ROOT)
#     settings.json                 (with _tokenplan_managed: true)
#     plugins/cache/tokenplan-usage-hud/
#       tokenplan-usage-hud/
#         0.2.7/state/upstream-cmd.{sh,txt}    (previous version)
#         0.2.8/scripts/wrapper.sh             (current version)
#         0.2.8/dist/index.js                  (so dist-missing build is skipped)
#         0.2.8/scripts/install.sh + lib/      (the script under test)
#
#   $STATUSLINE_CMD  statusLine.command value (with cache path baked in)
#   $PREV_STATE_DIR  previous version's state dir
#   $CURR_STATE_DIR  current version's state dir (initially empty)
#   $CURR_PLUGIN_DIR current version's full path
#   $CURR_VERSION    current version string ("0.2.8")
build_fixture() {
  local with_prev_state="$1"   # "yes" or "no"
  local with_curr_state="$2"   # "yes" or "no"

  local root
  root="$(mktemp -d -t tokenplan-install-test-XXXXXX)"
  local base="${root}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud"
  local curr="${base}/0.2.8"
  local prev="${base}/0.2.7"
  mkdir -p "${curr}/scripts/lib" "${curr}/dist" "${prev}/state" "${root}/plugins/cache"

  # Previous version: state/ with the upstream-cmd that a foreign install
  # would have written. Both sh and txt are present (the install.sh replace
  # branch writes both — see scripts/install.sh:write-managed + the
  # "Also write the bare original command" comment).
  cat > "${prev}/state/upstream-cmd.txt" <<'EOF'
echo "previous user statusline: ccstatusline"
EOF
  cat > "${prev}/state/upstream-cmd.sh" <<'EOF'
#!/usr/bin/env bash
echo "previous user statusline: ccstatusline"
EOF
  chmod +x "${prev}/state/upstream-cmd.sh"

  # Current version: scripts/wrapper.sh + the install.sh + lib + dist.
  # We symlink back to the real files in the repo so we test the real
  # install.sh, not a copy.
  ln -s "${SCRIPT_DIR}/wrapper.sh" "${curr}/scripts/wrapper.sh"
  ln -s "${SCRIPT_DIR}/install.sh" "${curr}/scripts/install.sh"
  ln -s "${SCRIPT_DIR}/lib/edit-settings.mjs" "${curr}/scripts/lib/edit-settings.mjs"
  # Provide a stub dist/index.js so the install script's "build on demand"
  # branch is skipped — we don't want tests that fail in a no-network env.
  printf '# stub\n' > "${curr}/dist/index.js"

  # Optionally pre-populate the current version's state/ (the "loader
  # already copied" case). When with_curr_state=yes, write a DIFFERENT
  # upstream-cmd so we can assert install.sh did not clobber it.
  if [ "$with_curr_state" = "yes" ]; then
    mkdir -p "${curr}/state"
    cat > "${curr}/state/upstream-cmd.txt" <<'EOF'
echo "loader-preserved state — do not clobber"
EOF
    cat > "${curr}/state/upstream-cmd.sh" <<'EOF'
#!/usr/bin/env bash
echo "loader-preserved state — do not clobber"
EOF
    chmod +x "${curr}/state/upstream-cmd.sh"
  fi

  # settings.json with _tokenplan_managed: true (so install.sh hits the
  # no-op branch under test). The statusLine.command is hand-crafted to
  # pass edit-settings.mjs's isOurWrapperCommand fingerprint:
  #   - path contains plugins[/\]cache[/\]tokenplan-usage-hud[/\]tokenplan-usage-hud[/\]
  #   - ends with `wrapper.sh"'` (single-quote after closing double-quote)
  # The minimal shape that satisfies both: a `bash -c '…exec bash "<path>/scripts/wrapper.sh"'`
  # whose <path> contains the cache marker. We use the real install path.
  cat > "${root}/settings.json" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "bash -c 'plugin_dir=${curr}; export TOKENPLAN_UPSTREAM_CMD=\${plugin_dir}state/upstream-cmd.sh; exec bash \"\${plugin_dir}scripts/wrapper.sh\"'",
    "_tokenplan_managed": true
  }
}
EOF

  FIXTURE_ROOT="$root"
  CURR_PLUGIN_DIR="$curr"
  CURR_STATE_DIR="${curr}/state"
  PREV_STATE_DIR="${prev}/state"
  CURR_VERSION="0.2.8"
  # CLAUDE_CONFIG_DIR is the parent of `plugins/`, not `plugins/` itself.
  # install.sh does CLAUDE_ROOT = ${CLAUDE_CONFIG_DIR:-$HOME}/plugins/...
  CLAUDE_CONFIG_DIR_VAL="$root"
}

# Run install.sh against a built fixture. Captures stdout; we don't
# care about exit code (the no-op branch exits 0, the foreign-state
# branch would exit 1, both are valid outcomes depending on what the
# test sets up).
run_install() {
  local out
  out=$(HOME="$FIXTURE_ROOT" CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR_VAL" \
        bash "$INSTALL_SH" 2>&1) || true
  echo "$out"
}

# --- Tests -------------------------------------------------------------------

echo "== install.sh: state-carry-forward on no-op =="

echo "-- carries state/ from previous version when ours is empty --"
build_fixture yes no
out=$(run_install)
assert_file_exists "upstream-cmd.txt copied to current" "${CURR_STATE_DIR}/upstream-cmd.txt"
assert_file_exists "upstream-cmd.sh copied to current" "${CURR_STATE_DIR}/upstream-cmd.sh"
assert_eq "upstream-cmd.txt content matches previous" \
  "echo \"previous user statusline: ccstatusline\"" \
  "$(cat "${CURR_STATE_DIR}/upstream-cmd.txt")"
if [ -x "${CURR_STATE_DIR}/upstream-cmd.sh" ]; then
  echo "  ok  upstream-cmd.sh kept executable bit"
  PASS=$((PASS + 1))
else
  echo "  FAIL upstream-cmd.sh not executable"
  FAIL=$((FAIL + 1))
fi
assert_match_str() {
  local label="$1" pattern="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$pattern"; then
    echo "  ok  $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL $label (pattern not found: $pattern)"
    echo "       output: $haystack"
    FAIL=$((FAIL + 1))
  fi
}
assert_match_str "log line announces carry-forward" "carried state/ forward" "$out"
# Tear down.
rm -rf "$FIXTURE_ROOT"

echo "-- does NOT clobber state/ when ours is already populated --"
build_fixture yes yes
out=$(run_install)
assert_eq "upstream-cmd.txt content untouched (loader-preserved)" \
  "echo \"loader-preserved state — do not clobber\"" \
  "$(cat "${CURR_STATE_DIR}/upstream-cmd.txt")"
assert_eq "upstream-cmd.sh content untouched" \
  "$(printf '#!/usr/bin/env bash\necho "loader-preserved state — do not clobber"\n')" \
  "$(cat "${CURR_STATE_DIR}/upstream-cmd.sh")"
# The carry-forward message should NOT appear when the files were
# already there.
if echo "$out" | grep -qF "carried state/ forward"; then
  echo "  FAIL should not have printed carry-forward log"
  FAIL=$((FAIL + 1))
else
  echo "  ok  did not log carry-forward (files were already present)"
  PASS=$((PASS + 1))
fi
rm -rf "$FIXTURE_ROOT"

echo "-- no previous version (only one cache dir): no-op without copying --"
# Rebuild with only 0.2.8 (no 0.2.7).
root="$(mktemp -d -t tokenplan-install-test-XXXXXX)"
base="${root}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud"
curr="${base}/0.2.8"
mkdir -p "${curr}/scripts/lib" "${curr}/dist"
ln -s "${SCRIPT_DIR}/wrapper.sh" "${curr}/scripts/wrapper.sh"
ln -s "${SCRIPT_DIR}/install.sh" "${curr}/scripts/install.sh"
ln -s "${SCRIPT_DIR}/lib/edit-settings.mjs" "${curr}/scripts/lib/edit-settings.mjs"
printf '# stub\n' > "${curr}/dist/index.js"
# settings.json: matches the isOurWrapperCommand fingerprint so install.sh
# takes the no-op (managed) branch — which is what we want to test.
cat > "${root}/settings.json" <<EOF
{ "statusLine": { "type": "command", "command": "bash -c 'plugin_dir=${curr}; exec bash \"\${plugin_dir}scripts/wrapper.sh\"'", "_tokenplan_managed": true } }
EOF
# Current state/ does NOT exist.
out=$(HOME="$root" CLAUDE_CONFIG_DIR="$root" bash "$INSTALL_SH" 2>&1) || true
assert_file_missing "upstream-cmd.txt was NOT created from nowhere" "${curr}/state/upstream-cmd.txt"
if echo "$out" | grep -qF "carried state/ forward"; then
  echo "  FAIL should not have printed carry-forward (no previous version)"
  FAIL=$((FAIL + 1))
else
  echo "  ok  no carry-forward log when there's no previous version"
  PASS=$((PASS + 1))
fi
# Should still print the standard no-op message.
assert_match_str "standard no-op message printed" "already managed" "$out"
rm -rf "$root"

# --- Summary -----------------------------------------------------------------
echo ""
echo "test-install.sh: $PASS pass, $FAIL fail"
exit $FAIL
