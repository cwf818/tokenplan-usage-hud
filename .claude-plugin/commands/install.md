---
description: Install or uninstall the token-plan statusline wrapper into Claude Code's settings.json
---

Run the plugin's `scripts/install.sh` script with whatever arguments you pass to this command. The script:

- defaults to user-level install (`~/.claude/settings.json`); pass `--project` for project-level (cwd's `.claude/settings.json`).
- backs up any existing `statusLine` to `settings.json.bak.<timestamp>` and preserves the original command in `<plugin-cache>/state/upstream-cmd.sh` so it can be re-invoked as the upstream.
- marks the new statusLine with `_tokenplan_managed: true` so re-running install is a no-op.
- supports `--uninstall [--project]` to restore the original statusLine from the preserved command.
- supports `--restore [--project]` to copy the most recent `.bak.<ts>` over the current settings file.
- supports `--dry-run` to print what would happen without modifying anything.

Examples:

- `/tokenplan-usage-hud:install` — install at user-level.
- `/tokenplan-usage-hud:install --project` — install at project-level.
- `/tokenplan-usage-hud:install --dry-run` — preview the install.
- `/tokenplan-usage-hud:install --uninstall` — uninstall from user-level.
- `/tokenplan-usage-hud:install --restore` — restore settings.json from the most recent `.bak.<ts>`.

The script runs without network access and never prints `ANTHROPIC_AUTH_TOKEN`.