---
description: Remove old .bak.<timestamp> backup files, keeping only the most recent per file
argument-hint: "[--project | --dry-run]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/clean.sh:*)"]
---

# tokenplan-usage-hud :clean

Targets the `.bak.YYYYMMDDTHHMMSS` files our install/uninstall scripts
leave behind:

- `settings.json.bak.<ts>`
- `installed_plugins.json.bak.<ts>`
- `known_marketplaces.json.bak.<ts>`

Keeps the most recent backup per file (sorted lexically — the ISO
timestamp is monotonic) and removes the rest. Does not touch user-named
backups like `settings.json.bak-pre-v0.1.8`. Idempotent — if at most one
backup exists per file, prints "nothing to clean" and exits 0.

Defaults to user-level (`~/.claude/`); pass `--project` for project-level
(cwd's `.claude/`).

The uninstall slash command (`/tokenplan-usage-hud:uninstall`) calls
this script as its final step, so explicit cleanup is usually unnecessary
after a fresh uninstall.

Execute the clean script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/clean.sh" $ARGUMENTS
```
