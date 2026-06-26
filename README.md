# tokenplan-usage-hud

A provider-agnostic Claude Code statusline plugin for **token-plan usage / remaining quota**. It picks what to render from `ANTHROPIC_BASE_URL`, so the same plugin works against any supported provider's plan endpoint — no per-provider re-install. Currently supported:

- **MiniMax** — `Usage: …` / `Remain: …` (5-hour + weekly windows), from `/v1/token_plan/remains`
- **DeepSeek** — `Balance: …` (account balance), from `/user/balance`

For vanilla Anthropic, OpenRouter, or any other provider not on the list above, the plugin **hides itself** and passes any chained upstream statusline through unchanged.

```
[upstream statusline lines]
Usage: 5h ▓▓▓▓░░░░ 40% (1h↻) · wk ▓▓░░░░░░ 20% (4d↻)        # MiniMax
Balance: ￥110.00 · $3.5                                       # DeepSeek (multi-currency)
```

We deliberately don't reimplement the kitchen-sink statuslines that already exist for vanilla Anthropic — [`claude-hud`](https://github.com/...) and [`ccstatusline`](https://github.com/...) cover that. This plugin is only the **plan / quota** piece that's provider-specific.

ANSI colors are 5-band (256-color SGR): bright green / dark green / yellow / orange / red. Applied to the displayed value + the colored bar segment; the empty part of the bar stays uncolored so it remains readable.

## Install

The plugin is a single-plugin marketplace. Install it in three steps:

```
/plugin marketplace add cwf818/tokenplan-usage-hud
/plugin install tokenplan-usage-hud@tokenplan-usage-hud
```

> After the plugin install, run `/reload-plugins` so the loader picks up the new commands before wiring it into `settings.json`. Forgetting this step is the most common cause of "command not found" right after install.

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
3. **Remove `tokenplan-usage-hud` from `settings.json.extraKnownMarketplaces`** (Claude Code records the marketplace source there too — leaving it would re-add the marketplace on next `/plugin marketplace add` with no visible diff).
4. **Wipe** `cache/tokenplan-usage-hud/`, `marketplaces/tokenplan-usage-hud/`, and the legacy `marketplaces/cwf818-tokenplan-usage-hud/` alias.
5. **Strip the plugin's row** from `installed_plugins.json` and `known_marketplaces.json` (with timestamped `.bak.<TS>` backups).
6. **Trim old `.bak.<ts>` files** — invokes `scripts/clean.sh` as the final step so uninstall leaves a tidy filesystem (one newest backup per file). User-named backups like `settings.json.bak-pre-v0.1.8` are NOT touched.

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

## Clean

```
/tokenplan-usage-hud:clean
```

Removes the old `.bak.YYYYMMDDTHHMMSS` backup files our installer leaves behind, keeping only the most recent one per base file:

- `settings.json.bak.<ts>` → keeps the newest
- `installed_plugins.json.bak.<ts>` → keeps the newest
- `known_marketplaces.json.bak.<ts>` → keeps the newest

User-named backups (e.g. `settings.json.bak-pre-v0.1.8`) are **not** touched — only the script-generated timestamp pattern. Idempotent: if at most one backup exists per file, prints `nothing to clean` and exits 0. Add `--dry-run` to preview.

The uninstall slash command already runs `clean.sh` as its final step, so explicit cleanup is usually unnecessary after a fresh uninstall. Use the clean command directly if you want to tidy up between installs, or if you've accumulated a lot of `.bak.<ts>` files from earlier dev iteration.

For dev iteration, `npm run settings:clean` (or `npm run settings:clean:dry`) does the same thing from the command line.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. If `TOKENPLAN_UPSTREAM_CMD` is set, it runs that path as a bash script (`bash "$TOKENPLAN_UPSTREAM_CMD"`), captures stdout, and exposes it to the plugin entry as the `TOKENPLAN_UPSTREAM` env var. If unset, the wrapper runs the plugin as the sole statusline.
- `TOKENPLAN_UPSTREAM_CMD` is an **absolute path** to a bash script — `install.sh` writes one at `<plugin-cache>/state/upstream-cmd.sh` whose body is `exec bash -c '<original-command>'`. Older v0.1.10–v0.1.11 used `bash -c` against the path itself, which silently failed — fixed in v0.1.12.
- The plugin preserves interior newlines in upstream output and injects `\x1b[0m` before its own line if upstream ends with an unclosed ANSI SGR — so multi-line, ANSI-colored upstream statuslines render correctly.

## Activation

The plugin picks a **provider** from `ANTHROPIC_BASE_URL` and renders exactly one line:

| `ANTHROPIC_BASE_URL`                       | Line            | API                                                  |
|--------------------------------------------|-----------------|------------------------------------------------------|
| `https://api.minimaxi.com/...`             | `Usage: …` / `Remain: …` | `GET https://www.minimaxi.com/v1/token_plan/remains` |
| `https://api.deepseek.com/...`             | `Balance: …`    | `GET https://api.deepseek.com/user/balance`          |
| anything else (vanilla Anthropic, etc.)    | (hidden)        | —                                                    |

Both endpoints are called with `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` — the same token, no new env vars. The gates are strict prefix matches (case-insensitive), and `isDeepSeekBaseUrl` rejects suffix attacks like `https://api.deepseek.com.evil.example`. On vanilla Anthropic, OpenRouter, or any other provider, the line is hidden and any upstream output passes through unchanged.

### MiniMax token-plan line

```
Usage: 5h ▓▓▓▓▓░░░ 38% (47m↻ / 5h) · wk ░░░░░▓▓▓ 39% (4d47m↻ / wk)
Remain: 5h ▓▓▓▓▓░░░ 62% (47m↻ / 5h) · wk ░░░░░▓▓▓ 61% (4d47m↻ / wk)
```

Two windows (5-hour + weekly), split-bar with colored percentage, reset countdown in parentheses, window label after the slash.

### DeepSeek balance line

When `ANTHROPIC_BASE_URL` starts with `https://api.deepseek.com`, the plugin fetches the user's account balance and renders:

```
Balance: ￥110.00             # is_available=true, single CNY entry
Balance: $25.00               # is_available=true, single USD entry
Balance: ￥110 · $3.5         # multi-currency: ALL entries from balance_infos,
                             # joined by ' · ', single color band from the
                             # LOWEST balance (most urgent currency drives hue).
Balance: not available!       # is_available=false or no parseable entries
```

Per-currency display prefix: `USD` → `$`, `CNY` / `RMB` → `￥`. Any other
currency code is rendered as itself, uppercased (e.g. `EUR42.50`).

5-band color thresholds on the **lowest** entry's numeric value:

| Range     | Color          |
|-----------|----------------|
| `<5`      | red            |
| `[5,10)`  | orange         |
| `[10,20)` | yellow         |
| `[20,50)` | dark green     |
| `>=50`    | bright green   |

## Display mode

Default mode is **`used`** — the line begins with `Usage:` and the percentage shown is the percentage of the window you've consumed. The colored bar segment represents the consumed portion.

Switch to `remaining` mode by setting `TOKENPLAN_DISPLAY=remaining` in the shell environment that runs Claude Code:

```bash
export TOKENPLAN_DISPLAY=remaining
claude
```

In remaining mode the line begins with `Remain:` and the percentage is what's left; the colored bar segment represents the remaining portion.

`TOKENPLAN_DISPLAY` is MiniMax-only — DeepSeek's `Balance:` line doesn't have a percentage to flip.

## Auth

The plugin reuses `process.env.ANTHROPIC_AUTH_TOKEN` to call the provider's plan endpoint. **No new env vars.** See [SECURITY.md](./SECURITY.md) for how the token is handled.

## Caching

In-memory TTL of **60 s**, with stale-on-error fallback. Two scopes of "refresh interval" are involved and they're independent:

- **This plugin's 60 s TTL** — how long we cache a successful API response before re-fetching. MiniMax and DeepSeek have different rate-limit policies and refresh cadences; 60 s is a deliberate default that keeps the statusline responsive without hammering the API.
- **Claude Code's `statusLine.refreshInterval`** — how often the harness invokes the statusline command (every prompt, every tool result). Set in `~/.claude/settings.json` independently of this plugin:

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "...",
      "refreshInterval": 300000
    }
  }
  ```

  Within a single Claude Code invocation, this plugin is only re-run when the harness decides to (per `refreshInterval`); between those calls the 60 s TTL decides whether we hit the API or just re-render the cached value.

  This plugin follows the **minimum-change principle**: it does not write `refreshInterval` into `settings.json`. Set it yourself if you want a different cadence — the default the harness ships with is fine for most users.

DeepSeek balance uses a separate cache key (`"balance"`) so the two providers don't invalidate each other.

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test --import tsx src/**/*.test.ts
npm run build        # esbuild → dist/index.js
npm run dev          # esbuild --watch
```

### Response shape

The MiniMax parser is defensive and tries multiple plausible field names:

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

The DeepSeek response shape is simpler — `{ is_available: bool, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }, ...] }` — and the parser iterates **all** entries so every currency the account holds is rendered.

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
  index.ts            # entry — stdin drain, provider dispatch, cache, render, compose
  types.ts            # Provider union: 'minimax' | 'deepseek' | null
  api.ts              # MiniMax fetch + tolerant parser for /v1/token_plan/remains
  api.deepseek.ts     # DeepSeek fetch + parser for /user/balance + URL gate
  render.ts           # pure: pctBar + ANSI color thresholds + formatLine + formatBalanceLine
  cache.ts            # 60s TTL + stale-on-error
  composition.ts      # reads TOKENPLAN_UPSTREAM, prepends (preserving ANSI/multi-line) and appends line
  __fixtures__/       # remains.real.json, balance.real.json, balance.multi.json, …
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (declares commands)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /tokenplan-usage-hud:install slash command
  uninstall.md        # /tokenplan-usage-hud:uninstall slash command
  clean.md            # /tokenplan-usage-hud:clean slash command
scripts/
  wrapper.sh          # bash wrapper: TOKENPLAN_UPSTREAM_CMD → TOKENPLAN_UPSTREAM → us
  install.sh          # settings.json patcher (install + thin shim for --uninstall)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files, keeping only the most recent per file
  lib/edit-settings.mjs  # ESM helper used by install.sh
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
settings.example.json # template (NEVER commit real settings.json)
```

## License

MIT — see [LICENSE](./LICENSE).
