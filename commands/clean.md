---
description: Remove old .bak.<timestamp> backup files, keeping only the most recent per file
argument-hint: "[--project | --dry-run | --purge-runtime]"
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

## --purge-runtime

Pass `--purge-runtime` to also wipe the plugin's runtime state files:

- `state/diagnostics.jsonl` — the persistent diagnostics log
  (only exists when `TOKENPLAN_DIAGNOSTICS_ENABLE=1` has been set)
- `state/token-samples/` — the append-only JSONL cache backing
  the `m_token5h` / `m_token7d` display modules
- `state/cache.json` — the on-disk fetch cache (60s TTL)

These files are user-level only — `--purge-runtime` is ignored
under `--project` (the state dir has no project-level counterpart).
Combined usage: `clean.sh --purge-runtime --dry-run` to preview.

The uninstall slash command (`/tokenplan-usage-hud:uninstall`) calls
this script as its final step (without `--purge-runtime`), so explicit
cleanup of backups is usually unnecessary after a fresh uninstall.
`--purge-runtime` is opt-in because the runtime state contains your
diagnostics history — only wipe when you actually want it gone.

Execute the clean script with whatever arguments were passed to this
command:

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/clean.sh" $ARGUMENTS
```
