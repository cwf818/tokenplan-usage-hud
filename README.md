# tokenplan-usage-hud

Claude Code statusline plugin that renders **MiniMax token-plan usage** (5-hour and weekly windows). The plugin ships its own installer that hooks into Claude Code's `statusLine` slot and (optionally) chains any pre-existing statusline (e.g. `ccstatusline`, `claude-hud`) as the upstream. When `ANTHROPIC_BASE_URL` does not point at MiniMax, the line is hidden and upstream output passes through unchanged.

```
[upstream statusline lines]
Usage: 5h ▓▓▓▓░░░░ 40% (1h↻) · wk ▓▓░░░░░░ 20% (4d↻)
```

ANSI colors are 5-band (256-color SGR): bright green / dark green / yellow / orange / red at 0 / 20 / 40 / 60 / 80 boundaries. Applied to the displayed value + the colored bar segment; the empty part of the bar stays uncolored so it remains readable.

## Install

The plugin is a single-plugin marketplace. Install it in two steps:

```
/plugin marketplace add cwf818/tokenplan-usage-hud
/plugin install tokenplan-usage-hud@tokenplan-usage-hud
```

Then wire it into `settings.json`:

```
/tokenplan-usage-hud:install
```

This patches the active `settings.json` (user-level by default; pass `--project` for project-level):

1. If `statusLine` is already managed by us (`_tokenplan_managed: true`), the command is a no-op.
2. Otherwise, the current `settings.json` is backed up to `settings.json.bak.<ISO-timestamp>`.
3. The original `statusLine.command` is preserved at `<plugin-cache>/state/upstream-cmd.sh` and `<plugin-cache>/state/upstream-cmd.txt`.
4. The `statusLine` is rewritten to invoke our wrapper, which sets `TOKENPLAN_UPSTREAM_CMD=<upstream-cmd.sh>` so the original statusline runs above our line.

`install.sh` auto-builds `dist/index.js` if it's missing (the marketplace install only copies source, not the bundle). Re-running the slash command is always a no-op once installed.

If you want to preview what install will do, run `/tokenplan-usage-hud:install --dry-run` first.

If your active `settings.json` doesn't exist at the project level, install creates a minimal one (with `permissions.defaultMode: bypassPermissions`). It does **not** copy from the user-level file.

### Restore from backup

```
/tokenplan-usage-hud:install --restore
```

Replaces the active `settings.json` with the most recent `settings.json.bak.<ts>`. Useful if you want to roll back an edit that wasn't made by us.

## Uninstall

```
/tokenplan-usage-hud:uninstall
```

This is a self-contained cleanup that works even after the plugin's cache and marketplace have been wiped. It does all of the following:

1. **Restore `statusLine`** — strategy in order:
   - If `<plugin-cache>/<highest-version>/state/upstream-cmd.txt` exists, restore the original command byte-for-byte from that file.
   - Else, fall back to the most recent `settings.json.bak.<ts>` whose `statusLine` does **not** have `_tokenplan_managed: true` (the state before the plugin was installed).
   - Else, strip the marker but leave the wrapper in place and print a warning.
2. **Remove `tokenplan-usage-hud@tokenplan-usage-hud` from `settings.json.enabledPlugins`** (other plugins preserved).
3. **Wipe** `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, and the legacy `marketplaces/cwf818-tokenplan-usage-hud/` alias.
4. **Strip the plugin's row** from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<TS>` backups).

`settings.json` and the two JSON files are backed up **before** any destructive change. Line endings (CRLF/LF) are preserved. The script is **idempotent** — re-running on a clean system prints `nothing to do` and exits 0. Add `--dry-run` to preview actions without modifying anything.

The `env` block of `settings.json` (including your `ANTHROPIC_AUTH_TOKEN`) is **not** touched. The script runs locally with no API calls and never reads `ANTHROPIC_AUTH_TOKEN`.

After uninstall, re-install with the four-step flow:

```
/plugin marketplace add cwf818/tokenplan-usage-hud
/plugin install tokenplan-usage-hud@tokenplan-usage-hud
/reload-plugins
/tokenplan-usage-hud:install
```

The legacy `/tokenplan-usage-hud:install --uninstall` flag still works (it's a thin shim that calls the same uninstaller). Prefer the dedicated `:uninstall` slash command in new scripts.

For dev iteration, `npm run dev:uninstall` (or `npm run dev:uninstall:dry`) does the same thing from the command line.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. If `TOKENPLAN_UPSTREAM_CMD` is set, it runs that path as a bash script (`bash "$TOKENPLAN_UPSTREAM_CMD"`), captures stdout, and exposes it to the plugin entry as the `TOKENPLAN_UPSTREAM` env var. If unset, the wrapper runs the plugin as the sole statusline.
- `TOKENPLAN_UPSTREAM_CMD` is an **absolute path** to a bash script — `install.sh` writes one at `<plugin-cache>/state/upstream-cmd.sh` whose body is `exec bash -c '<original-command>'`. Older v0.1.10–v0.1.11 used `bash -c` against the path itself, which silently failed — fixed in v0.1.12.
- The plugin preserves interior newlines in upstream output and injects `\x1b[0m` before its own line if upstream ends with an unclosed ANSI SGR — so multi-line, ANSI-colored upstream statuslines render correctly.

## Activation

The plugin only renders the token-plan line when `ANTHROPIC_BASE_URL` contains `minimaxi.com` (case-insensitive). On vanilla Anthropic, OpenRouter, or any other provider, the line is hidden and any upstream output passes through unchanged.

## Display mode

Default mode is **`used`** — the line begins with `Usage:` and the percentage shown is the percentage of the window you've consumed. The colored bar segment represents the consumed portion.

Switch to `remaining` mode by setting `TOKENPLAN_DISPLAY=remaining` in the shell environment that runs Claude Code:

```bash
export TOKENPLAN_DISPLAY=remaining
claude
```

In remaining mode the line begins with `Remain:` and the percentage is what's left; the colored bar segment represents the remaining portion.

## Auth

The plugin reuses `process.env.ANTHROPIC_AUTH_TOKEN` to call the MiniMax `GET https://www.minimaxi.com/v1/token_plan/remains` endpoint. **No new env vars.** See [SECURITY.md](./SECURITY.md) for how the token is handled.

## Caching

In-memory TTL of **60 s**, with stale-on-error fallback. The MiniMax API is not hit on every turn.

## Response shape

The parser is defensive and tries multiple plausible field names:

| Window   | Keys tried (in order)                                            |
|----------|------------------------------------------------------------------|
| 5-hour   | `five_hour`, `fiveHour`, `fivehour`, `5h`, `hour5`               |
| Weekly   | `weekly`, `week`, `wk`, `seven_day`, `sevenDay`, `7d`            |

Inside each window: `remaining` / `left` / `available`; `limit` / `total` / `quota`; `used` (used ⇒ remaining = limit − used). Both `data.{…}` envelope and flat shapes are accepted. If `base_resp.status_code ≠ 0`, the response is treated as failure and the line is omitted.

The verified real shape (captured 2026-06-24 against `https://www.minimaxi.com/v1/token_plan/remains`):

```json
{
  "model_remains": [
    { "model_name": "...", "current_interval_remaining_percent": 60, "current_weekly_remaining_percent": 92, "end_time": "...", "weekly_end_time": "..." }
  ],
  "base_resp": { "status_code": 0 }
}
```

The plugin picks the entry with the **lowest interval remaining %** as the source of truth (the most-active model). If you capture a fresh response and the shape diverges, save it as `src/__fixtures__/remains.real.json` and tighten the parser in `src/api.ts`.

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test --import tsx src/**/*.test.ts
npm run build        # esbuild → dist/index.js
npm run dev          # esbuild --watch
```

### Dev loop: re-installing the plugin from scratch

When iterating on the install flow (changes to `scripts/install.sh`, `scripts/uninstall.sh`, the slash commands, the version, etc.) you need to fully wipe the plugin's on-disk state before `/plugin install` will re-fetch a clean copy. The plugin loader caches marketplace state and refuses to bump an already-installed plugin — on Windows this surfaces as `EPERM: operation not permitted, rename ... -> ... .bak`.

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed:
npm run dev:uninstall:dry

# Wipe tokenplan-usage-hud state:
npm run dev:uninstall
```

It removes:
- the tokenplan row from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<ts>` backups of both files)
- `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, and the loader's leftover `marketplaces/cwf818-tokenplan-usage-hud/` directory

Then re-install:

```
/plugin marketplace add cwf818/tokenplan-usage-hud
/plugin install tokenplan-usage-hud@tokenplan-usage-hud
/reload-plugins
/tokenplan-usage-hud:install
```

If the loader still says "EPERM" after `dev:uninstall`, the most common cause is a Claude Code process holding a file lock on the marketplace dir. **Quit all running Claude Code sessions** (not just this one) and re-run `npm run dev:uninstall`.

## Project layout

```
src/
  index.ts            # entry — stdin drain, env gate, cache, render, compose
  api.ts              # fetch + tolerant parser for /v1/token_plan/remains
  render.ts           # pure: pctBar + ANSI color thresholds + formatLine
  cache.ts            # 60s TTL + stale-on-error
  composition.ts      # reads TOKENPLAN_UPSTREAM, prepends (preserving ANSI/multi-line) and appends line
  __fixtures__/       # sample / camelCase / empty / used-only response JSONs
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (declares commands)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /tokenplan-usage-hud:install slash command
  uninstall.md        # /tokenplan-usage-hud:uninstall slash command
scripts/
  wrapper.sh          # bash wrapper: TOKENPLAN_UPSTREAM_CMD → TOKENPLAN_UPSTREAM → us
  install.sh          # settings.json patcher (install + thin shim for --uninstall)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  lib/edit-settings.mjs  # ESM helper used by install.sh
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
settings.example.json # template (NEVER commit real settings.json)
```

## License

MIT — see [LICENSE](./LICENSE).
