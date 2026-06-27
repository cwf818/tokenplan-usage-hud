<pre>
[upstream statusline lines]
Usage: ▓▓▓▓░░░░ 40% (1h27m🕗 5h) · ▓▓░░░░░░ 20% (4d3h🕔 7d)    # Tokeplan
Balance: ￥110.00 · $3.5                                        # Balance
</pre>

# tokenplan-usage-hud

[![License](https://img.shields.io/github/license/cwf818/tokenplan-usage-hud)](LICENSE)
[![Tag](https://img.shields.io/github/tag/cwf818/tokenplan-usage-hud)](https://github.com/cwf818/tokenplan-usage-hud/tags)
[![Stars](https://img.shields.io/github/stars/cwf818/tokenplan-usage-hud)](https://github.com/cwf818/tokenplan-usage-hud/stargazers)

A provider-agnostic Claude Code statusline plugin for **token-plan usage / remaining quota**. It picks what to render from `ANTHROPIC_BASE_URL`, so the same plugin works against any supported provider's plan endpoint — no per-provider re-install. Currently supported:

- **MiniMax** — `Usage: …` / `Remain: …` (5-hour + weekly windows), from `/v1/token_plan/remains`
- **DeepSeek** — `Balance: …` (account balance), from `/user/balance`

For vanilla Anthropic, OpenRouter, or any other provider not on the list above, the plugin **hides itself** and passes any chained upstream statusline through unchanged.

We deliberately don't reimplement the kitchen-sink statuslines that already exist for vanilla Anthropic — [`claude-hud`](https://github.com/jarrodwatts/claude-hud) and [`ccstatusline`](https://github.com/sirmalloc/ccstatusline) cover that. This plugin is only the **plan / quota** piece that's provider-specific.

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

## Commands

Four slash commands ship with the plugin:

| Command                                  | What it does                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/tokenplan-usage-hud:install`           | Wire the wrapper into `settings.json` (or `--uninstall` / `--restore`).                          |
| `/tokenplan-usage-hud:uninstall`         | Restore `settings.json`, wipe cache + marketplace + loader rows.                                   |
| `/tokenplan-usage-hud:clean`             | Trim old `.bak.<ts>` files (keeps the most recent per file).                                      |
| `/tokenplan-usage-hud:clean-cache`       | Remove stale version dirs from the plugin cache, keeping only the newest.                          |

Each is a Pattern B2 slash command — the body is a `!`-fenced shell block that loads `scripts/<name>.sh` directly via `${CLAUDE_PLUGIN_ROOT}`, with `allowed-tools` scoped to that script. See [Project layout](#project-layout) for the file map.

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

## Clean cache

```
/tokenplan-usage-hud:clean-cache
```

Every `/plugin install` rolls the cache forward — Claude Code creates a new `<version>` directory under `<cache>/tokenplan-usage-hud/` but does **not** remove the previous one. Old version dirs pile up over time (~40-50 MB each: full source tree + node_modules). The `statusLine.command` written by `:install` is already version-independent — it `ls -d`s every version dir, sorts by version, and `exec`s the highest — so old dirs are pure dead weight.

`/tokenplan-usage-hud:clean-cache` walks the cache, finds all `^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$` version directories, sorts numerically (so `0.2.10` sorts AFTER `0.2.9`, not lexically), keeps the newest, and removes the rest.

**Safety:** non-version entries (`.in_use`, `.orphaned_at_*`, hidden dirs, files, anything not matching the version regex) are left untouched. Idempotent: re-running is a no-op once only the newest remains. Add `--dry-run` to preview.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. If `TOKENPLAN_UPSTREAM_CMD` is set, it runs that path as a bash script (`bash "$TOKENPLAN_UPSTREAM_CMD"`), captures stdout, and exposes it to the plugin entry as the `TOKENPLAN_UPSTREAM` env var. If unset, the wrapper runs the plugin as the sole statusline.
- `TOKENPLAN_UPSTREAM_CMD` is an **absolute path** to a bash script — `install.sh` writes one at `<plugin-cache>/state/upstream-cmd.sh` whose body is `exec bash -c '<original-command>'`. Older v0.1.10–v0.1.11 used `bash -c` against the path itself, which silently failed — fixed in v0.1.12.
- The plugin preserves interior newlines in upstream output and injects `\x1b[0m` before its own line if upstream ends with an unclosed ANSI SGR — so multi-line, ANSI-colored upstream statuslines render correctly.

## Activation

The plugin picks a **provider** from `ANTHROPIC_BASE_URL` and renders exactly one line:

| `ANTHROPIC_BASE_URL`                    | Line                     | API                                                  |
| --------------------------------------- | ------------------------ | ---------------------------------------------------- |
| `https://api.minimaxi.com/...`          | `Usage: …` / `Remain: …` | `GET https://www.minimaxi.com/v1/token_plan/remains` |
| `https://api.deepseek.com/...`          | `Balance: …`             | `GET https://api.deepseek.com/user/balance`          |
| anything else (vanilla Anthropic, etc.) | (hidden)                 | —                                                    |

Both endpoints are called with `Authorization: Bearer $ANTHROPIC_AUTH_TOKEN` — the same token, no new env vars. The gates are strict prefix matches (case-insensitive), and `isDeepSeekBaseUrl` rejects suffix attacks like `https://api.deepseek.com.evil.example`. On vanilla Anthropic, OpenRouter, or any other provider, the line is hidden and any upstream output passes through unchanged.

### MiniMax token-plan line

<pre>
 Usage: ▓▓▓▓▓░░░ 38% (47m🕖 5h) · ▓▓▓░░░░░ 39% (4d47m🕓 7d)
Remain: ░░░░░▓▓ 62% (47m🕖 5h) · ░░░▓▓▓▓ 61% (4d47m🕓 7d)
</pre>

Two windows (5-hour + weekly), split-bar with colored percentage, reset
countdown in parentheses, window label after the countdown. The bar
glyphs flip in remaining mode — both modes read left-to-right as
"what's spent → what's left":

- `used` mode: `▓▓▓▓▓░░░` — `▓` is consumed (colored), `░` is remaining (plain)
- `remaining` mode: `░░░░░▓▓` — `░` is consumed (plain), `▓` is remaining (colored)

The reset countdown uses the shared time-formatting template:

| Remaining | Rendered  | Note                                       |
| --------- | --------- | ------------------------------------------ |
| `-1ms`    | `0m`      | past-due, explicit "this window has reset" |
| `30s`     | `<1m`     | sub-minUnit floor                          |
| `5m`      | `5m`      |                                            |
| `60m`     | `1h0m`    | internal zero preserved                    |
| `90m`     | `1h30m`   |                                            |
| `24h`     | `1d0h`    |                                            |

`maxUnitCount` (default `2`) controls how many units are shown. Leading
zeros are dropped (`0d0h5m` → `5m`); internal and trailing zeros are
kept (`2h0m` → `2h0m`, NOT `2h`). See `stale.maxUnitCount` in the
config schema for the full set of options.

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

| Range     | Color        |
| --------- | ------------ |
| `<5`      | red          |
| `[5,10)`  | orange       |
| `[10,20)` | yellow       |
| `[20,50)` | dark green   |
| `>=50`    | bright green |

## Display mode

Default mode is **`used`** — the line begins with `Usage:` and the percentage shown is the percentage of the window you've consumed. The colored bar segment represents the consumed portion.

Switch to `remaining` mode via the config file:

```json
{ "display": "remaining" }
```

See [Configuration](#configuration) below for the full schema. The earlier `TOKENPLAN_DISPLAY` env var is gone as of v0.2.0 — anyone who used it must move the value to `config.json`.

In remaining mode the line begins with `Remain:` and the percentage is what's left; the colored bar segment represents the remaining portion.

`display` is MiniMax-only — DeepSeek's `Balance:` line doesn't have a percentage to flip.

## Configuration

A single JSON file parameterizes every hardcoded tunable (color thresholds, cache TTL, fetch timeout, currency prefixes, bar geometry, stale-annotation formatting, display-mode label). Path:

- **Unix**: `~/.claude/plugins/tokenplan-usage-hud/config.json`
- **Windows**: `%USERPROFILE%\.claude\plugins\tokenplan-usage-hud\config.json`

Loaded once at startup. **Missing file** → all defaults (today's behavior, bit-for-bit identical). **Malformed JSON** or a **single bad field** → one stderr line (`tokenplan-usage-hud: config <reason>; using defaults`) and the default for _that_ field only — the rest of your config is still honored. The plugin never blanks the statusline on bad config.

A reference with every field is at [config.example.json](./config.example.json). Copy it to the path above and edit.

### Schema (v1)

```jsonc
{
  "cacheTtlMs": 60000, // > 0; success-cache TTL in ms
  "fetchTimeoutMs": 5000, // > 0; per-request HTTP timeout
  "display": "used", // "used" | "remaining"
  "modeLabels": {
    // line prefix per mode
    "used": "Usage:",        // MiniMax plan line
    "remaining": "Remain:",  // MiniMax plan line in remaining mode
    "balance": "Balance:",   // DeepSeek balance line
  },
  "colors": {
    // 256-color ANSI palette
    "brightGreen": "brightGreen",
    "darkGreen": "darkGreen",
    "yellow": "yellow",
    "orange": "orange",
    "red": "red",
    "stale": "brightBlack", // dim-gray for the "⛓️‍💥 X ago" suffix
  },
  "thresholds": {
    // band cutoffs (4 ascending numbers each)
    "minimaxPercent": [20, 40, 60, 80],
    "deepseekBalance": [5, 10, 20, 50],
  },
  "currency": {
    // DeepSeek per-currency rendering
    "prefixes": { "USD": "$", "CNY": "￥", "RMB": "￥" },
    "fallback": "￥", // prefix for unknown currency codes
    "default": "CNY", // assumed currency when API omits one
  },
  "stale": {
    // stale-on-error annotation
    "separator": " · ",
    // Emoji pair for the "X ago" annotation. The broken glyph is what
    // the user actually sees (no leading separator) — it's the
    // indicator of network failure. Healthy is reserved for future use.
    "ageEmoji": { "healthy": "🔗", "broken": "⛓️‍💥" },
  },
  "bar": {
    // bar geometry
    "width": 8, // 3..64
    "filled": "▓",
    "empty": "░",
  },
  "timeFormat": {
    // Top-level knobs — govern ALL time rendering in the plugin
    // (reset countdown AND stale-age suffix). Keeping them out of the
    // `stale` block means a user who wants second-level granularity
    // anywhere gets it everywhere consistently.
    //
    // Smallest unit shown on time countdowns.
    //   "m" (default): sub-minute shows as "<1m" — the "<" prefix
    //                  signals "less than 1 minute" so the user can
    //                  tell a window is about to reset (vs "0m" which
    //                  would imply a definite wait).
    //   "s":           sub-minute shows as actual seconds (e.g. "47s").
    "minUnit": "m",
    // How many non-zero units to show. Drops LEADING zero units first,
    // then takes up to maxUnitCount from the start — including any
    // internal/trailing zero units. Clamped to [1, 4].
    //   1d2h3m4s → "1d2h"
    //   2h3m4s   → "2h3m"
    //   2h0m     → "2h0m"   (NOT "2h" — internal zeros preserved)
    //   0d0h5m   → "5m"     (leading zeros dropped)
    "maxUnitCount": 2,
  },
  "countdown": {
    // Reset-countdown visualization. Belongs with the countdown, NOT with
    // the stale-on-error annotation (which is a separate concern).
    //
    // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
    // indexes by `remainingMs / resetDurationMs`, so the array reads
    // left-to-right as "few remaining → many remaining" (i.e. ascending
    // by remaining-time ratio). Index 0 is shown when remaining ≈ 0
    // (about to reset); the last entry is shown when remaining ≈ total
    // (fresh). Twelve clock-face emoji give a smooth visual ramp from
    // 12 o'clock (🕛, least remaining) around to 1 o'clock (🕐, most
    // remaining); two glyphs give a binary hourglass (full/empty);
    // one glyph is static. Providers without start_time (DeepSeek,
    // legacy) fall back to index 0.
    "resetArrows": [
      "🕛",
      "🕚",
      "🕙",
      "🕘",
      "🕗",
      "🕖",
      "🕕",
      "🕔",
      "🕓",
      "🕒",
      "🕑",
      "🕐",
    ],
  },
  "separators": [
    // Separator strings referenced from `lineTemplate` as s_0, s_1, ….
    // s_0 — between adjacent modules within a group (default: " ")
    // s_1 — between the two window groups / between balance entries
    //       (default: " · " — note the leading and trailing spaces
    //       are part of the separator)
    // Add more entries to reference them as s_2, s_3, … in your
    // lineTemplate.
    " ",
    " · ",
  ],
  "lineTemplate": {
    // Custom line layout. Each entry is either a display module
    // ("m_<name>") or a separator reference ("s_<n>"). The renderer
    // walks the array left-to-right and concatenates each module's
    // output. See "Module tokens" below for the full list. Modules
    // that return no content (e.g. a window with no data) cause
    // their surrounding s_N tokens to disappear too, so a hidden
    // window doesn't leave orphan separators in the output.
    "plan": [
      "m_label", "s_0",
      "m_window5h", "s_0", "m_countdown5h",
      "s_0", "s_1", "s_0",
      "m_window7d", "s_0", "m_countdown7d",
    ],
    "balance": ["m_label", "s_0", "m_balance"],
  },
  // Plugin version is loaded automatically at startup from
  // .claude-plugin/plugin.json and surfaced via the m_version
  // module. No config field — just add "m_version" to your
  // lineTemplate to render "v0.2.17"-style annotations.
}
```

Each `colors.*` value is either a **symbolic shortcut** (`brightGreen`, `darkGreen`, `yellow`, `orange`, `red`, `brightBlack`) or a **literal ANSI SGR string** matching `^\x1b\[[0-9;]*m$`. Strings containing newlines are rejected (statusline-injection guard).

`thresholds.*` must be exactly 4 finite ascending numbers. `bar.width` must be in `[3, 64]`. Numeric fields must be finite and (where relevant) positive. `separators` entries must be single-line strings; an entry containing `\n` is dropped (the rest of the array is preserved). `lineTemplate.<key>` must be a non-empty array of strings.

### Module tokens

The line layout is declared as an ordered list of tokens in `lineTemplate.plan` (MiniMax) and `lineTemplate.balance` (DeepSeek). Two token kinds:

- **`m_<name>`** — a display module, rendered in order. Modules that have no content in the current context (e.g. `m_window7d` when the weekly data is missing) emit nothing, AND their immediately adjacent `s_N` tokens are skipped too — so a hidden window doesn't leave orphan separators in the output.
- **`s_<n>`** — a separator reference, looked up in `separators[n]`. Out-of-range references expand to `""` and trigger a one-time stderr warning.

Recognized modules:

| Token              | Renders                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `m_label`          | The leading prefix: `modeLabels.used` (plan) or `modeLabels.balance` (DeepSeek) |
| `m_window5h`       | 5-hour bar + colored percentage (e.g. `▓▓▓░░░ 38%`)             |
| `m_countdown5h`    | 5-hour reset suffix: `(2h3m🕛 5h)` when reset time known, or just `5h` otherwise |
| `m_window7d`       | 7-day bar + colored percentage                                   |
| `m_countdown7d`    | 7-day reset suffix: `(4d16h🕛 7d)` or just `7d`                  |
| `m_balance`        | The DeepSeek balance chunk (e.g. `$25 · ￥110`), single SGR-wrapped block |
| `m_age`            | The stale-age annotation: `⛓️‍💥 5m ago` (broken) or `🔗 5m ago` (healthy) |
| `m_version`        | The plugin version: `v0.2.17` (auto-loaded from `.claude-plugin/plugin.json`) |

**Forced visibility of `m_age`:** when the fetch result is **stale** (network failure with a cached value), the broken-chain age annotation is appended to the rendered line **unconditionally** — even if your `lineTemplate` doesn't list `m_age`. This preserves the invariant that a network failure is always visible, no matter what the user puts in their template. On `fresh` ticks, no annotation is shown. The `m_age` module itself only emits when `ageMs > 0`, so a user who *does* include `m_age` in their template gets exactly one annotation, not two.

### Recipes

**Lower cache TTL** (re-fetch more often):

```json
{ "cacheTtlMs": 15000 }
```

**Switch to remaining mode**:

```json
{ "display": "remaining" }
```

**Custom palette** (e.g. cyan-only):

```json
{
  "colors": {
    "brightGreen": "\x1b[38;5;51m",
    "darkGreen": "\x1b[38;5;45m",
    "yellow": "\x1b[38;5;81m",
    "orange": "\x1b[38;5;75m",
    "red": "\x1b[38;5;69m"
  }
}
```

**Show only the 5-hour window** (drop the 7-day window):

```json
{
  "lineTemplate": {
    "plan": ["m_label", "s_0", "m_window5h", "s_0", "m_countdown5h"],
    "balance": ["m_label", "s_0", "m_balance"]
  }
}
```

**Custom inter-window separator** (e.g. ` / ` instead of ` · `):

```json
{
  "separators": [" ", " / "],
  "lineTemplate": {
    "plan": [
      "m_label", "s_0",
      "m_window5h", "s_0", "m_countdown5h",
      "s_0", "s_1", "s_0",
      "m_window7d", "s_0", "m_countdown7d"
    ],
    "balance": ["m_label", "s_0", "m_balance"]
  }
}
```

**Show the plugin version** at the end of the line:

```json
{
  "lineTemplate": {
    "plan": [
      "m_label", "s_0",
      "m_window5h", "s_0", "m_countdown5h",
      "s_0", "s_1", "s_0",
      "m_window7d", "s_0", "m_countdown7d",
      "s_0", "m_version"
    ],
    "balance": ["m_label", "s_0", "m_balance", "s_0", "m_version"]
  }
}
```

### Migration from `TOKENPLAN_DISPLAY`

If you previously set `TOKENPLAN_DISPLAY=remaining` in your shell, move that value into `config.json`:

```bash
mkdir -p ~/.claude/plugins/tokenplan-usage-hud
echo '{ "display": "remaining" }' > ~/.claude/plugins/tokenplan-usage-hud/config.json
```

Restart Claude Code (or run `/reload-plugins`) for the change to take effect.

## Auth

The plugin reuses `process.env.ANTHROPIC_AUTH_TOKEN` to call the provider's plan endpoint. **No new env vars.** See [SECURITY.md](./SECURITY.md) for how the token is handled.

## Caching

The Claude Code statusline is updated in response to interaction events by default (every prompt, every tool result). Starting with **Claude Code 2.1.97**, the `statusLine.refreshInterval` field is honored, letting the statusline refresh on a fixed cadence instead. Two scopes of "refresh interval" are involved and they're independent:

- **This plugin's 60 s TTL** — how long we cache a successful API response before re-fetching. MiniMax and DeepSeek have different rate-limit policies and refresh cadences; 60 s is a deliberate default that keeps the statusline responsive without hammering the API.
- **Claude Code's `statusLine.refreshInterval`** — how often the harness invokes the statusline command. Set in `~/.claude/settings.json` independently of this plugin:

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "...",
      "refreshInterval": 60
    }
  }
  ```

  Unit is **seconds** (not milliseconds — that's a frequent footgun; the harness will reject or misbehave on values like `30000`). For this plugin, **30–120 s is a sensible range**: shorter than the 60 s TTL is wasted, much longer and the line lags behind reality. The `refreshInterval` value does **not** affect the API-call TTL — they are independent knobs.

  This plugin follows the **minimum-change principle**: it does not write `refreshInterval` into `settings.json`. Set it yourself if you want a non-default cadence.

DeepSeek balance uses a separate cache key (`"balance"`) so the two providers don't invalidate each other.

### Failure handling

Three outcomes when the provider API is called:

| Outcome                    | What you see on the statusline                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh fetch                | The normal `Usage: …` / `Balance: …` line, no suffix.                                                                                                                         |
| Fetch failed, cache exists | The last good value, **with a dim `⛓️‍💥 X ago` suffix** at the end (e.g. `Balance: ￥110 ⛓️‍💥 5m ago`). The broken-chain emoji IS the indicator (no leading separator).   |
| Fetch failed, no cache     | `Usage: not available!` (MiniMax) or `Balance: not available!` (DeepSeek) in red. Plugin is alive but the provider is unreachable.                                            |

The `X ago` format uses the **same template as the reset countdown**:
d/h/m units, `maxUnitCount=2` default, drop leading zeros but keep
internal/trailing zeros. Sub-minute follows `timeFormat.minUnit`:
`minUnit="m"` → `<1m ago`; `minUnit="s"` → `${seconds}s ago`. Examples
(with default `minUnit="m"`):

| Cached age  | Rendered suffix        |
| ----------- | ---------------------- |
| 30 s        | `⛓️‍💥 <1m ago`          |
| 5 min       | `⛓️‍💥 5m ago`           |
| 90 min      | `⛓️‍💥 1h30m ago`         |
| 24 h        | `⛓️‍💥 1d0h ago`          |

The hard-fail `not available!` line intentionally has no age suffix
because there is no cached value to be stale-OF.

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

| Window | Keys tried (in order)                                 |
| ------ | ----------------------------------------------------- |
| 5-hour | `five_hour`, `fiveHour`, `fivehour`, `5h`, `hour5`    |
| Weekly | `weekly`, `week`, `wk`, `seven_day`, `sevenDay`, `7d` |

Inside each window: `remaining` / `left` / `available`; `limit` / `total` / `quota`; `used` (used ⇒ remaining = limit − used). Both `data.{…}` envelope and flat shapes are accepted. If `base_resp.status_code ≠ 0`, the response is treated as failure and the line is omitted.

The verified real shape (captured 2026-06-24 against `https://www.minimaxi.com/v1/token_plan/remains`):

```json
{
  "model_remains": [
    {
      "model_name": "...",
      "current_interval_remaining_percent": 60,
      "current_weekly_remaining_percent": 92,
      "end_time": "...",
      "weekly_end_time": "..."
    }
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
