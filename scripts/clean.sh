#!/usr/bin/env bash
# clean.sh — remove old backup files, keeping only the most recent per file.
#
# Targets the .bak.<ISO-timestamp> files our install/uninstall scripts leave
# behind:
#   - settings.json.bak.YYYYMMDDTHHMMSS
#   - installed_plugins.json.bak.YYYYMMDDTHHMMSS
#   - known_marketplaces.json.bak.YYYYMMDDTHHMMSS
#
# For each base file, sorts backups by name (which sorts by timestamp since the
# ISO format is lexically monotonic), keeps the lexicographically LAST one
# (== most recent timestamp), and removes the rest.
#
# User-named backups (e.g. `settings.json.bak-pre-v0.1.8`) are NOT touched —
# only the script-generated `.bak.YYYYMMDDTHHMMSS` pattern.
#
# Idempotent: if there is 0 or 1 backup per file, nothing happens.
# Local-only. Never reads ANTHROPIC_AUTH_TOKEN. No network access.
#
# Usage:
#   clean.sh                  # user-level (default)
#   clean.sh --project        # project-level (cwd's .claude/settings.json)
#   clean.sh --dry-run        # print what would be removed, change nothing
#   clean.sh -h | --help
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
      echo "clean.sh: unknown argument: $arg" >&2
      echo "  usage: clean.sh [--project] [--dry-run]" >&2
      exit 2
      ;;
  esac
done

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="${CLAUDE_ROOT}/plugins"

# Base files whose `.bak.<ts>` siblings we want to trim.
if [ "$PROJECT_LEVEL" = 1 ]; then
  SETTINGS=".claude/settings.json"
  # Project-level has no installed_plugins / known_marketplaces — those
  # live at the user level.
  BASE_FILES=("$SETTINGS")
else
  SETTINGS="${CLAUDE_ROOT}/settings.json"
  BASE_FILES=(
    "$SETTINGS"
    "${PLUGINS_DIR}/installed_plugins.json"
    "${PLUGINS_DIR}/known_marketplaces.json"
  )
fi

# ISO timestamp pattern: 8 digits, T, 6 digits (HHMMSS).
TS_RE='[0-9]{8}T[0-9]{6}'

REMOVE_LIST=()

for base in "${BASE_FILES[@]}"; do
  # Glob <base>.bak.<ts> files. ls -1 gives one per line.
  # Filter through grep for the exact ISO pattern (case-sensitive,
  # anchored to end of filename).
  shopt -s nullglob
  matches=( $(ls -1 "${base}.bak."* 2>/dev/null \
    | grep -E "\.bak\.${TS_RE}\$") )
  shopt -u nullglob
  if [ "${#matches[@]}" -le 1 ]; then
    continue
  fi
  # Sort by name — ISO timestamps sort lexically. Keep the last (= newest).
  # Use printf %s\\n to be safe with weird filenames (none here, but cheap).
  newest=""
  for f in "${matches[@]}"; do
    case "$f" in
      "$newest") ;;
      *) newest="$f" ;;
    esac
  done
  # Pick the true lex-max via sort -r | head -1.
  newest=$(printf '%s\n' "${matches[@]}" | sort -r | head -n 1)
  for f in "${matches[@]}"; do
    if [ "$f" != "$newest" ]; then
      REMOVE_LIST+=("$f")
    fi
  done
done

if [ "${#REMOVE_LIST[@]}" -eq 0 ]; then
  echo "clean.sh: nothing to clean — at most one backup per file"
  exit 0
fi

echo "clean.sh: plan (keeping the most recent backup per file)"
for f in "${REMOVE_LIST[@]}"; do
  echo "  rm $f"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "clean.sh: --dry-run, no changes made"
  exit 0
fi

for f in "${REMOVE_LIST[@]}"; do
  rm -f "$f"
done

echo "clean.sh: removed ${#REMOVE_LIST[@]} old backup(s)"
