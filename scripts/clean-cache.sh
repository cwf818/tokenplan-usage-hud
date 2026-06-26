#!/usr/bin/env bash
# clean-cache.sh — remove stale version directories under the plugin
# cache, keeping only the newest one.
#
# Background:
#   When you /plugin install a new version of tokenplan-usage-hud,
#   Claude Code's loader creates a new <version> dir under
#     ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/
#   but does NOT remove the previous version's dir. Old dirs pile up
#   over time. Each one is ~40-50MB (full source tree + node_modules).
#
#   The statusLine.command the wrapper writes is a bash one-liner that
#   `ls -d`s all version dirs, sorts by version, and `tail -1`s the
#   highest — so only the newest dir is ever actually used. The
#   older dirs are pure dead weight.
#
# Behavior:
#   - Walks <cache>/tokenplan-usage-hud/, finds all <version> dirs.
#   - Sorts by version numerically (4-component dotted-decimal).
#   - Keeps the highest. Removes the rest.
#   - This is destructive: --dry-run is supported for preview.
#
# Safety:
#   - Only touches dirs whose name matches the <version> shape
#     (digits and dots). Refuses to touch any other dir or any
#     non-dir entry.
#   - Never touches the wrapper-statusline, the .in_use / .orphaned_at
#     markers, or any other file Claude Code manages.
#   - Only ever descends one level: the version dirs directly under
#     the plugin cache.
#   - Idempotent: re-running is a no-op once only the newest remains.
#   - Self-protection: the version dir this script lives in is
#     itself a candidate for removal. Resolve SCRIPT_DIR up front so
#     a later rm -rf of THAT dir doesn't break us mid-script
#     (same defensive pattern as uninstall.sh).
#
# Usage:
#   clean-cache.sh                  # user-level (default)
#   clean-cache.sh --dry-run        # preview, change nothing
#   clean-cache.sh -h | --help
#
# Portable: Linux, macOS, Git Bash on Windows.

set -u

DRY_RUN=0

print_help() {
  sed -n '2,42p' "$0"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "clean-cache.sh: unknown argument: $arg" >&2
      echo "  usage: clean-cache.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

# Resolve SCRIPT_DIR ONCE so a later `rm -rf` of THIS dir doesn't
# resolve to a dangling path. Same defensive pattern as uninstall.sh
# (commit 8030e4c). The script itself lives in
# <cache>/tokenplan-usage-hud/<version>/scripts/clean-cache.sh, so
# SCRIPT_DIR is exactly the dir we will eventually remove. That's
# fine — we don't need to read this file again after the rm.
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"

CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CACHE_BASE="${CLAUDE_ROOT}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud"

# Version dir name: at least 3 dot-separated components (e.g. 0.2.7),
# at most 4 (e.g. 0.2.7.1 for prereleases). Anything with fewer than
# 3 components is treated as decoy and skipped — a 2-component name
# like "1.2" is not a valid plugin version and the user almost
# certainly meant a non-version dir. Reject anything else (including
# `..`, `.`, hidden dirs, names with letters).
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$'

# Build the sorted-by-version list of version dirs. Each entry is a
# version string in <cache>/<version>/. The awk pre-filter validates
# the name shape and emits one line per match; we collect, then
# numerically sort.
if [ ! -d "$CACHE_BASE" ]; then
  echo "clean-cache.sh: no cache dir at ${CACHE_BASE}; nothing to clean"
  exit 0
fi

shopt -s nullglob
SORTED_VERSIONS=( $(ls -1d "${CACHE_BASE}/"*/ 2>/dev/null \
  | awk -F/ '{ n=$(NF-1); if (n ~ /^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$/) print n }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n) )
shopt -u nullglob

if [ "${#SORTED_VERSIONS[@]}" -le 1 ]; then
  echo "clean-cache.sh: nothing to clean — at most one version dir present (${SORTED_VERSIONS[*]:-none})"
  exit 0
fi

# Newest is the last element; everything before it is a removal target.
NEWEST="${SORTED_VERSIONS[${#SORTED_VERSIONS[@]}-1]}"
REMOVE_VERSIONS=( "${SORTED_VERSIONS[@]:0:${#SORTED_VERSIONS[@]}-1}" )

REMOVE_LIST=()
for v in "${REMOVE_VERSIONS[@]}"; do
  path="${CACHE_BASE}/${v}"
  REMOVE_LIST+=("$path")
done

echo "clean-cache.sh: plan"
echo "  keep:    ${NEWEST}"
echo "  remove:"
for f in "${REMOVE_LIST[@]}"; do
  echo "    rm -rf ${f}"
done

if [ "$DRY_RUN" = 1 ]; then
  echo "clean-cache.sh: --dry-run, no changes made"
  exit 0
fi

# Apply: wipe each stale version dir. Defensive belt-and-suspenders:
#   1. Re-check VERSION_RE on the basename (in case the glob returned
#      something unexpected).
#   2. Never operate on the newest version (would break the wrapper).
#   3. `rm -rf` only — no destructive actions on the parent cache dir.
for path in "${REMOVE_LIST[@]}"; do
  base=$(basename "$path")
  if [[ ! "$base" =~ $VERSION_RE ]]; then
    echo "clean-cache.sh: refusing to remove non-version path: $path" >&2
    continue
  fi
  if [ "$base" = "$NEWEST" ]; then
    echo "clean-cache.sh: refusing to remove newest version: $path" >&2
    continue
  fi
  rm -rf "$path"
  echo "clean-cache.sh: removed ${path}"
done

# If this script was run from a dir that we just removed, SCRIPT_DIR
# is now dangling. That's expected and harmless — the script has
# already finished its work, and any future call from a NEW install
# resolves a fresh path.
if [ -n "${SCRIPT_DIR:-}" ] && [ ! -d "$SCRIPT_DIR" ]; then
  echo "clean-cache.sh: note — this script's own dir was removed (${SCRIPT_DIR}). Re-install to recover."
fi

echo "clean-cache.sh: done"
