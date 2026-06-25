---
description: Uninstall tokenplan-usage-hud, restore settings.json, and wipe the plugin's cache, marketplace, and loader rows
---

Run the plugin's `scripts/uninstall.sh` script with whatever arguments you pass to this command. The script:

- defaults to user-level uninstall (`~/.claude/settings.json`); pass `--project` for project-level (cwd's `.claude/settings.json`).
- restores the original `statusLine.command` from `<plugin-cache>/state/upstream-cmd.txt` if available, otherwise falls back to the most recent pre-managed `settings.json.bak.<ts>`. If neither is found, strips the marker but leaves the wrapper in place and prints a warning.
- removes `tokenplan-usage-hud@tokenplan-usage-hud` from `settings.json.enabledPlugins`.
- removes `tokenplan-usage-hud` from `settings.json.extraKnownMarketplaces`.
- wipes `cache/tokenplan-usage-hud/`, the marketplace dir, and the plugin's row from `installed_plugins.json` and `known_marketplaces.json`.
- backs up `settings.json` and the two JSON files with `.<name>.bak.<timestamp>` before any destructive change.
- runs `scripts/clean.sh` as its final step to trim old `.bak.<timestamp>` files (keeps only the most recent per file; user-named backups like `settings.json.bak-pre-v0.1.8` are not touched).
- is idempotent — re-running on a clean system prints a "nothing to do" message and exits 0.
- supports `--dry-run` to print the action plan without modifying anything.
- runs locally with no API calls and never reads `ANTHROPIC_AUTH_TOKEN`.

Examples:

- `/tokenplan-usage-hud:uninstall` — uninstall at user-level.
- `/tokenplan-usage-hud:uninstall --project` — uninstall at project-level.
- `/tokenplan-usage-hud:uninstall --dry-run` — preview actions, no changes.

After uninstall, re-install with:

```
/plugin marketplace add cwf818/tokenplan-usage-hud
/plugin install tokenplan-usage-hud@tokenplan-usage-hud
/reload-plugins
/tokenplan-usage-hud:install
```

The script does not touch the `env` block of `settings.json` (your `ANTHROPIC_AUTH_TOKEN` and other env vars are preserved).
