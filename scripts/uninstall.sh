#!/usr/bin/env bash
# uninstall.sh — full uninstall of tokenplan-usage-hud.
#
# Self-contained: works even if the plugin cache has been partially or
# fully wiped (e.g. after `npm run dev:uninstall`, or any manual
# `rm -rf`). Uses only bash + node (for safe JSON edits) + standard
# Unix tools. No network access. Never reads ANTHROPIC_AUTH_TOKEN.
#
# Behavior:
#   1. Restores settings.json.statusLine to the user's pre-tokenplan
#      state. Strategy:
#        a. If statusLine._tokenplan_managed === true AND
#           <plugin-cache>/<highest-version>/state/upstream-cmd.txt
#           exists, restore from that file (the original install.sh
#           --uninstall behavior, byte-for-byte).
#        b. Else if statusLine._tokenplan_managed === true, fall back
#           to the most recent settings.json.bak.<ts> in the same
#           dir whose statusLine does NOT have _tokenplan_managed
#           (the state before the plugin was installed).
#        c. Else: statusLine is not ours, leave it alone.
#   2. Removes "tokenplan-usage-hud@tokenplan-usage-hud" from
#      settings.json.enabledPlugins (if present), preserving CRLF.
#   3. Backs up settings.json to settings.json.bak.<TS> before any
#      destructive change.
#   4. Wipes:
#        - cache/tokenplan-usage-hud/
#        - marketplaces/tokenplan-usage-hud/
#        - marketplaces/cwf818-tokenplan-usage-hud/   (legacy alias)
#   5. Strips the plugin row from installed_plugins.json and
#      known_marketplaces.json (with timestamped .bak.<TS> backups),
#      preserving CRLF.
#   6. Strips `extraKnownMarketplaces.tokenplan-usage-hud` from
#      settings.json (Claude Code records the marketplace source there
#      too — leaving it would re-add the marketplace on next
#      /plugin marketplace add with no visible diff).
#
# Idempotency: every step is independently no-op-able. Re-running on
# a fully clean system prints a "nothing to do" message and exits 0.
#
# Usage:
#   uninstall.sh                  # user-level (default)
#   uninstall.sh --project        # project-level (cwd's .claude/settings.json)
#   uninstall.sh --dry-run        # print actions, change nothing
#   uninstall.sh -h | --help
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

PROJECT_LEVEL=0
DRY_RUN=0

print_help() {
  sed -n '2,40p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --project) PROJECT_LEVEL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "uninstall.sh: unknown argument: $arg" >&2
      echo "  usage: uninstall.sh [--project] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="${CLAUDE_ROOT}/plugins"
CACHE_DIR="${PLUGINS_DIR}/cache/tokenplan-usage-hud"
MARKETPLACE_DIR="${PLUGINS_DIR}/marketplaces/tokenplan-usage-hud"
TMP_MARKETPLACE_DIR="${PLUGINS_DIR}/marketplaces/cwf818-tokenplan-usage-hud"
INSTALLED_JSON="${PLUGINS_DIR}/installed_plugins.json"
KNOWN_JSON="${PLUGINS_DIR}/known_marketplaces.json"
SETTINGS_PLUGIN_KEY="tokenplan-usage-hud@tokenplan-usage-hud"

# --- Resolve settings target --------------------------------------------------
if [ "$PROJECT_LEVEL" = 1 ]; then
  TARGET=".claude/settings.json"
else
  TARGET="${CLAUDE_ROOT}/settings.json"
fi

# --- Plan: enumerate actions, then run --------------------------------------

TS=$(date +%Y%m%dT%H%M%S)
ACTIONS=()
DRY_NOTHING=1  # becomes 0 if at least one planned action is meaningful

# Action 1: restore statusLine (only if our marker is set)
SL_PLAN=""
if [ -f "$TARGET" ]; then
  # Read the marker in pure bash via node (mirrors the install.sh
  # edit-settings.mjs status op, but inlined so we don't depend on
  # the cache being present).
  WIN_TARGET=""
  if command -v cygpath >/dev/null 2>&1; then
    WIN_TARGET=$(cygpath -w "$TARGET" 2>/dev/null || echo "$TARGET")
  else
    WIN_TARGET="$TARGET"
  fi
  MANAGED=$(node -e '
    const fs = require("fs");
    const p = process.argv[1];
    // The marker is not enough: another plugin or a human may have
    // overwritten statusLine.command after install. Trust the command
    // shape (cache path + wrapper.sh suffix), not just the marker.
    // See scripts/lib/edit-settings.mjs#isOurWrapperCommand for the
    // matching logic — duplicated here only because we cannot easily
    // `require` an mjs from inside a node -e heredoc.
    const isOurs = (cmd) => {
      if (typeof cmd !== "string" || cmd.length === 0) return false;
      const re = /plugins[\/\\]cache[\/\\]tokenplan-usage-hud[\/\\]tokenplan-usage-hud[\/\\]/;
      return re.test(cmd) && /wrapper\.sh"\x27\s*$/.test(cmd);
    };
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const sl = d && d.statusLine;
      const m = sl && sl._tokenplan_managed === true && isOurs(sl.command);
      process.stdout.write(m ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$WIN_TARGET" 2>/dev/null || echo "0")
  if [ "$MANAGED" = "1" ]; then
    # Find the highest version's upstream-cmd.txt (if cache still exists).
    # Glob at PLUGIN_BASE (one level deeper than CACHE_DIR) so we hit
    # the version directories directly. Mirrors scripts/install.sh.
    UPSTREAM_TXT=""
    if [ -d "$CACHE_DIR" ]; then
      PLUGIN_BASE="${CACHE_DIR}/tokenplan-usage-hud"
      SELF_DIR=$(ls -d ${PLUGIN_BASE}/*/ 2>/dev/null \
        | awk -F/ '{ print $(NF-1) "\t" $(0) }' \
        | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
        | tail -1 | cut -f2-)
      if [ -n "$SELF_DIR" ] && [ -f "${SELF_DIR%/}/state/upstream-cmd.txt" ]; then
        UPSTREAM_TXT="${SELF_DIR%/}/state/upstream-cmd.txt"
      fi
    fi
    if [ -n "$UPSTREAM_TXT" ]; then
      SL_PLAN="restore-from-file:${UPSTREAM_TXT}"
    else
      # Fall back: most recent .bak.<ts> whose statusLine is NOT managed
      BAK=""
      for f in $(ls -t "${TARGET}.bak."* 2>/dev/null); do
        if [ -z "$f" ]; then continue; fi
        BWIN=""
        if command -v cygpath >/dev/null 2>&1; then
          BWIN=$(cygpath -w "$f" 2>/dev/null || echo "$f")
        else
          BWIN="$f"
        fi
        M=$(node -e '
          const fs = require("fs");
          try {
            const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            const sl = d && d.statusLine;
            process.stdout.write(sl && sl._tokenplan_managed === true ? "1" : "0");
          } catch (e) { process.stdout.write("0"); }
        ' "$BWIN" 2>/dev/null || echo "0")
        if [ "$M" = "0" ]; then
          BAK="$f"
          break
        fi
      done
      if [ -n "$BAK" ]; then
        SL_PLAN="restore-from-bak:${BAK}"
      else
        SL_PLAN="warning:no-restore-source"
      fi
    fi
  fi
fi
if [ -n "$SL_PLAN" ]; then
  ACTIONS+=("statusLine: ${SL_PLAN}")
  DRY_NOTHING=0
fi

# Action 2: strip enabledPlugins row (if present)
EP_PLAN=""
if [ -f "$TARGET" ]; then
  HAS_ROW=$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const k = process.argv[2];
      process.stdout.write(d.enabledPlugins && Object.prototype.hasOwnProperty.call(d.enabledPlugins, k) ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$WIN_TARGET" "$SETTINGS_PLUGIN_KEY" 2>/dev/null || echo "0")
  if [ "$HAS_ROW" = "1" ]; then
    EP_PLAN="strip ${SETTINGS_PLUGIN_KEY} from enabledPlugins"
    ACTIONS+=("enabledPlugins: ${EP_PLAN}")
    DRY_NOTHING=0
  fi
fi

# Action 2b: strip extraKnownMarketplaces.tokenplan-usage-hud (if present).
# Claude Code records the marketplace source under both known_marketplaces.json
# AND settings.json.extraKnownMarketplaces (the latter is what shows up in
# `claude plugin marketplace list`). Leaving it would re-add the marketplace
# on next `/plugin marketplace add` with no visible diff.
EKM_PLAN=""
if [ -f "$TARGET" ]; then
  HAS_ROW=$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const k = process.argv[2];
      process.stdout.write(d.extraKnownMarketplaces && Object.prototype.hasOwnProperty.call(d.extraKnownMarketplaces, k) ? "1" : "0");
    } catch (e) { process.stdout.write("0"); }
  ' "$WIN_TARGET" "tokenplan-usage-hud" 2>/dev/null || echo "0")
  if [ "$HAS_ROW" = "1" ]; then
    EKM_PLAN="strip tokenplan-usage-hud from extraKnownMarketplaces"
    ACTIONS+=("extraKnownMarketplaces: ${EKM_PLAN}")
    DRY_NOTHING=0
  fi
fi

# Action 3: wipe dirs
for d in "$CACHE_DIR" "$MARKETPLACE_DIR" "$TMP_MARKETPLACE_DIR"; do
  if [ -d "$d" ]; then
    ACTIONS+=("rm -rf ${d}")
    DRY_NOTHING=0
  fi
done

# Action 4: strip JSON rows
for j in "$INSTALLED_JSON" "$KNOWN_JSON"; do
  if [ -f "$j" ]; then
    # Use node to detect, not grep, so we don't false-positive on
    # substrings that happen to appear in other fields (e.g. the
    # projectPath of THIS project, "D:\WorkSpace\tokenplan-usage-hud",
    # which is a legit project path other plugins reference).
    if [ "$j" = "$INSTALLED_JSON" ]; then
      HAS_ROW=$(node -e '
        const fs = require("fs");
        try {
          const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const k = process.argv[2];
          process.stdout.write(d.plugins && Object.prototype.hasOwnProperty.call(d.plugins, k) ? "1" : "0");
        } catch (e) { process.stdout.write("0"); }
      ' "$(cygpath -w "$j" 2>/dev/null || echo "$j")" "$SETTINGS_PLUGIN_KEY" 2>/dev/null || echo "0")
    else
      HAS_ROW=$(node -e '
        const fs = require("fs");
        try {
          const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          const k = process.argv[2];
          process.stdout.write(Object.prototype.hasOwnProperty.call(d, k) ? "1" : "0");
        } catch (e) { process.stdout.write("0"); }
      ' "$(cygpath -w "$j" 2>/dev/null || echo "$j")" "tokenplan-usage-hud" 2>/dev/null || echo "0")
    fi
    if [ "$HAS_ROW" = "1" ]; then
      ACTIONS+=("strip tokenplan row from $j")
      DRY_NOTHING=0
    fi
  fi
done

# --- Print plan --------------------------------------------------------------
if [ "$DRY_NOTHING" = 1 ]; then
  echo "uninstall.sh: nothing to do — tokenplan-usage-hud is not installed"
  exit 0
fi

echo "uninstall.sh: plan"
for a in "${ACTIONS[@]}"; do
  echo "  $a"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "uninstall.sh: --dry-run, no changes made"
  exit 0
fi

# --- Backup settings.json before any destructive change ----------------------
# Only back up if a settings-changing action is in the plan. Re-running
# on a clean system should not pile up empty .bak files.
NEEDS_SETTINGS_BACKUP=0
for a in "${ACTIONS[@]}"; do
  case "$a" in
    "statusLine: "*) NEEDS_SETTINGS_BACKUP=1 ;;
    "enabledPlugins: "*) NEEDS_SETTINGS_BACKUP=1 ;;
    "extraKnownMarketplaces: "*) NEEDS_SETTINGS_BACKUP=1 ;;
  esac
done
if [ "$NEEDS_SETTINGS_BACKUP" = 1 ] && [ -f "$TARGET" ]; then
  cp "$TARGET" "${TARGET}.bak.${TS}"
  echo "uninstall.sh: backup ${TARGET} -> ${TARGET}.bak.${TS}"
fi

# --- Apply: statusLine restore -----------------------------------------------
if [ -n "$SL_PLAN" ]; then
  case "$SL_PLAN" in
    restore-from-file:*)
      SRC="${SL_PLAN#restore-from-file:}"
      # Inline the restore-from-file op (mirrors edit-settings.mjs).
      # Hardened: only restore if the CURRENT command is actually ours.
      # If marker is set but command is foreign (another plugin / human
      # overwrote it), we still want to wipe the cache dirs, but the
      # statusLine is the user's now — don't touch it.
      node -e '
        const fs = require("fs");
        const target = process.argv[1];
        const src = process.argv[2];
        const original = fs.readFileSync(src, "utf8").trim();
        // Same fingerprint as the planning step above. Use a runtime
        // regex (matching `[\/\\]` for the separator) so single-backslash
        // Windows paths match — a String.includes needle built from
        // "[/\\\\]" requires 4 backslashes between segments and silently
        // misses every real Windows path. (Earlier buggy form, kept the
        // isOurs name for symmetry.)
        const isOurs = (cmd) => {
          if (typeof cmd !== "string" || cmd.length === 0) return false;
          const re = /plugins[\/\\]cache[\/\\]tokenplan-usage-hud[\/\\]tokenplan-usage-hud[\/\\]/;
          return re.test(cmd) && /wrapper\.sh"\x27\s*$/.test(cmd);
        };
        const data = JSON.parse(fs.readFileSync(target, "utf8"));
        if (data.statusLine && isOurs(data.statusLine.command)) {
          // Replace the entire statusLine with the pre-managed shape so
          // we drop any post-install fields Claude Code added.
          data.statusLine = { type: "command", command: original };
        } else if (!data.statusLine) {
          data.statusLine = { type: "command", command: original };
        } else {
          process.stderr.write(
            "uninstall.sh: restore-from-file skipped — current statusLine.command is not the tokenplan wrapper\n"
          );
        }
        let eol = "\n";
        const size = fs.statSync(target).size;
        if (size > 0) {
          const fd = fs.openSync(target, "r");
          const head = Buffer.alloc(Math.min(64, size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (head.includes(0x0d)) eol = "\r\n";
        }
        const body = JSON.stringify(data, null, 2) + "\n";
        fs.writeFileSync(target, body.replace(/\n/g, eol));
      ' "$WIN_TARGET" "$SRC"
      # Best-effort cleanup of the state files (they live in the cache
      # which we wipe below, but doing it here too handles the case
      # where the cache isn't writable for some reason).
      rm -f "${SRC%.txt}.sh" "$SRC" 2>/dev/null || true
      echo "uninstall.sh: restored statusLine from ${SRC}"
      ;;
    restore-from-bak:*)
      BAK="${SL_PLAN#restore-from-bak:}"
      cp "$BAK" "$TARGET"
      echo "uninstall.sh: restored ${TARGET} from ${BAK} (no upstream-cmd.txt available)"
      ;;
    warning:no-restore-source)
      # Last-resort: strip our marker but leave the wrapper as the
      # command. The user will see tokenplan still wired up until they
      # manually fix it. Better than blanking statusLine entirely.
      node -e '
        const fs = require("fs");
        const target = process.argv[1];
        const data = JSON.parse(fs.readFileSync(target, "utf8"));
        if (data.statusLine) delete data.statusLine._tokenplan_managed;
        let eol = "\n";
        const size = fs.statSync(target).size;
        if (size > 0) {
          const fd = fs.openSync(target, "r");
          const head = Buffer.alloc(Math.min(64, size));
          fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (head.includes(0x0d)) eol = "\r\n";
        }
        const body = JSON.stringify(data, null, 2) + "\n";
        fs.writeFileSync(target, body.replace(/\n/g, eol));
      ' "$WIN_TARGET"
      echo "uninstall.sh: WARNING — no upstream-cmd.txt and no pre-managed .bak found" >&2
      echo "uninstall.sh: stripped _tokenplan_managed marker but left the wrapper as statusLine." >&2
      echo "uninstall.sh: manually edit settings.json.statusLine.command to restore your previous statusline." >&2
      ;;
  esac
fi

# --- Apply: enabledPlugins strip --------------------------------------------
if [ -n "$EP_PLAN" ]; then
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    const key = process.argv[2];
    const data = JSON.parse(fs.readFileSync(target, "utf8"));
    if (data.enabledPlugins && Object.prototype.hasOwnProperty.call(data.enabledPlugins, key)) {
      delete data.enabledPlugins[key];
    }
    let eol = "\n";
    const size = fs.statSync(target).size;
    if (size > 0) {
      const fd = fs.openSync(target, "r");
      const head = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.includes(0x0d)) eol = "\r\n";
    }
    const body = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(target, body.replace(/\n/g, eol));
  ' "$WIN_TARGET" "$SETTINGS_PLUGIN_KEY"
  echo "uninstall.sh: removed ${SETTINGS_PLUGIN_KEY} from enabledPlugins"
fi

# --- Apply: extraKnownMarketplaces strip ------------------------------------
if [ -n "$EKM_PLAN" ]; then
  node -e '
    const fs = require("fs");
    const target = process.argv[1];
    const key = process.argv[2];
    const data = JSON.parse(fs.readFileSync(target, "utf8"));
    if (data.extraKnownMarketplaces && Object.prototype.hasOwnProperty.call(data.extraKnownMarketplaces, key)) {
      delete data.extraKnownMarketplaces[key];
    }
    let eol = "\n";
    const size = fs.statSync(target).size;
    if (size > 0) {
      const fd = fs.openSync(target, "r");
      const head = Buffer.alloc(Math.min(64, size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.includes(0x0d)) eol = "\r\n";
    }
    const body = JSON.stringify(data, null, 2) + "\n";
    fs.writeFileSync(target, body.replace(/\n/g, eol));
  ' "$WIN_TARGET" "tokenplan-usage-hud"
  echo "uninstall.sh: removed tokenplan-usage-hud from extraKnownMarketplaces"
fi

# --- Apply: wipe dirs --------------------------------------------------------
for d in "$CACHE_DIR" "$MARKETPLACE_DIR" "$TMP_MARKETPLACE_DIR"; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    echo "uninstall.sh: removed ${d}"
  fi
done

# --- Apply: strip JSON rows --------------------------------------------------
strip_tokenplan_from_json() {
  local file="$1"
  local key="$2"
  local win_path=""
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

strip_tokenplan_key_from_json() {
  local file="$1"
  local key="$2"
  local win_path=""
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
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      delete data[key];
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

if [ -f "$INSTALLED_JSON" ] && grep -q "$SETTINGS_PLUGIN_KEY" "$INSTALLED_JSON" 2>/dev/null; then
  cp "$INSTALLED_JSON" "${INSTALLED_JSON}.bak.${TS}"
  echo "uninstall.sh: backup ${INSTALLED_JSON} -> ${INSTALLED_JSON}.bak.${TS}"
  strip_tokenplan_from_json "$INSTALLED_JSON" "$SETTINGS_PLUGIN_KEY" \
    && echo "uninstall.sh: stripped tokenplan row from ${INSTALLED_JSON}" \
    || echo "uninstall.sh: failed to strip ${INSTALLED_JSON}" >&2
fi
if [ -f "$KNOWN_JSON" ] && grep -q "tokenplan-usage-hud" "$KNOWN_JSON" 2>/dev/null; then
  cp "$KNOWN_JSON" "${KNOWN_JSON}.bak.${TS}"
  echo "uninstall.sh: backup ${KNOWN_JSON} -> ${KNOWN_JSON}.bak.${TS}"
  strip_tokenplan_key_from_json "$KNOWN_JSON" "tokenplan-usage-hud" \
    && echo "uninstall.sh: stripped tokenplan-usage-hud from ${KNOWN_JSON}" \
    || echo "uninstall.sh: failed to strip ${KNOWN_JSON}" >&2
fi

echo ""
echo "uninstall.sh: done. tokenplan-usage-hud is fully removed."

# --- Final: trim old backup files (keep only the most recent per file) -------
# This runs scripts/clean.sh so uninstall leaves a tidy filesystem. It is
# always safe — clean is a no-op when at most one backup per file exists.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "${SCRIPT_DIR}/clean.sh" ] || [ -f "${SCRIPT_DIR}/clean.sh" ]; then
  PROJECT_FLAG=""
  [ "$PROJECT_LEVEL" = 1 ] && PROJECT_FLAG="--project"
  bash "${SCRIPT_DIR}/clean.sh" $PROJECT_FLAG || true
fi

echo ""
echo "  Re-install with: /plugin marketplace add cwf818/tokenplan-usage-hud"
echo "                   /plugin install tokenplan-usage-hud@tokenplan-usage-hud"
echo "                   /reload-plugins"
echo "                   /tokenplan-usage-hud:install"
