---
description: Remove old .bak.<timestamp> backup files, keeping only the most recent per file
---

Run the plugin's `scripts/clean.sh` script with whatever arguments you pass to this command. The script:

- defaults to user-level (`~/.claude/`); pass `--project` for project-level (cwd's `.claude/`).
- targets the `.bak.YYYYMMDDTHHMMSS` files our install/uninstall scripts leave behind:
  - `settings.json.bak.<ts>`
  - `installed_plugins.json.bak.<ts>`
  - `known_marketplaces.json.bak.<ts>`
- keeps the most recent backup per file (sorted lexically — the ISO timestamp is monotonic) and removes the rest.
- does **not** touch user-named backups like `settings.json.bak-pre-v0.1.8`.
- is idempotent — if at most one backup exists per file, prints "nothing to clean" and exits 0.
- supports `--dry-run` to print the removal plan without modifying anything.
- runs locally with no API calls and never reads `ANTHROPIC_AUTH_TOKEN`.

Examples:

- `/tokenplan-usage-hud:clean` — clean user-level backups.
- `/tokenplan-usage-hud:clean --project` — clean project-level backups (settings.json only).
- `/tokenplan-usage-hud:clean --dry-run` — preview what would be removed.

The uninstall slash command (`/tokenplan-usage-hud:uninstall`) calls this script as its final step, so explicit cleanup is usually unnecessary after a fresh uninstall.
