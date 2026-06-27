# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code statusline plugin (`tokenplan-usage-hud`) that renders **MiniMax token-plan usage** (5-hour and weekly windows) **or DeepSeek account balance**, picked by `ANTHROPIC_BASE_URL`. The plugin ships its own installer (`scripts/install.sh`) that hooks into Claude Code's `statusLine` slot and (optionally) chains any pre-existing statusline (e.g. `ccstatusline`, `claude-hud`) as the upstream. When `ANTHROPIC_BASE_URL` does not point at a supported provider, the plugin hides itself and passes upstream output through unchanged.

The plugin is shipped as a **single-plugin marketplace**: the repo root IS the marketplace, and `.claude-plugin/plugin.json` declares the plugin. Install with `/plugin marketplace add cwf818/tokenplan-usage-hud` then `/plugin install tokenplan-usage-hud@tokenplan-usage-hud`, then run `/tokenplan-usage-hud:install` to wire it into `settings.json`. Uninstall with `/tokenplan-usage-hud:uninstall` (a self-contained cleanup that works even after the cache and marketplace are gone).

## Commands

```bash
npm install          # install dev deps (esbuild, typescript, tsx, @types/node)
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx (64 tests across api/render/cache/composition)
npm run build        # esbuild → dist/index.js (single self-contained ESM bundle, target=node18)
npm run dev          # esbuild --watch
```

There is no separate `lint` step; `typecheck` covers it. Tests run with built-in `node:test` + `tsx` — no vitest/jest dependency.

## Architecture

```
src/
  index.ts            # entry — stdin drain, provider dispatch, cache, render, compose, loadConfig()
  types.ts            # Provider union: 'minimax' | 'deepseek' | null
  api.ts              # MiniMax fetch + tolerant parser for /v1/token_plan/remains
  api.deepseek.ts     # DeepSeek fetch + parser for /user/balance + URL gate
  render.ts           # pure: pctBar + ANSI color thresholds + formatLine + formatBalanceLine (reads configStore)
  cache.ts            # TTL + stale-on-error (Map<key, {at, value}>) — TTL passed in by index.ts from configStore
  config.ts           # loads ~/.claude/plugins/tokenplan-usage-hud/config.json; module-level singleton store
  composition.ts      # reads TOKENPLAN_UPSTREAM env, prepends (preserving ANSI/multi-line) and appends line
  __fixtures__/       # remains.real.json, balance.real.json, balance.multi.json, …
  session-parse.ts    # parseTokenSnapshot — stdin JSON → TokenSnapshot (extracted from index.ts so unit tests don't drag index side effects)
  token-store.ts      # append-only JSONL state file at state/token-samples/<projectHash>/<sessionId>.jsonl for m_token5h/m_token7d
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (name, version, commands, homepage)
  marketplace.json    # single-plugin marketplace wiring
commands/
  install.md          # /tokenplan-usage-hud:install slash command (Pattern B2 — loader-executes-script via `!`-fenced block + ${CLAUDE_PLUGIN_ROOT}; scoped allowed-tools)
  uninstall.md        # /tokenplan-usage-hud:uninstall slash command (Pattern B2)
  clean.md            # /tokenplan-usage-hud:clean slash command (Pattern B2)
scripts/
  wrapper.sh          # bash wrapper: TOKENPLAN_UPSTREAM_CMD → TOKENPLAN_UPSTREAM → us
  install.sh          # settings.json patcher (install/restore/dry-run; --uninstall is a thin shim)
  uninstall.sh        # self-contained uninstaller (used by :uninstall and dev:uninstall)
  clean.sh            # trim old .bak.<ts> files, keeping only the most recent per file
  lib/edit-settings.mjs # ESM helper used by install.sh
  dev-uninstall.sh    # DEV-ONLY thin shim → exec uninstall.sh
dist/
  index.js            # gitignored, esbuild bundle, the actual entry point
settings.example.json # template (NEVER commit a real settings.json)
```

### How it runs

Claude Code's `statusLine.command` spawns a child process that reads a session JSON from stdin and writes statusline text to stdout. Per-turn invocation — the plugin must be fast and never block.

1. `statusLine.command` (written by `scripts/lib/edit-settings.mjs` `write-managed` op) is a `bash -c '…'` snippet that, at invocation time, `ls -d`s every directory under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/`, sorts by version (`sort -t. -k1,1n …`), tails the highest, and execs `scripts/wrapper.sh` from that `plugin_dir`. Same pattern claude-hud uses. This makes the command **version-independent** — when `/plugin install` rolls the cache forward (0.2.5 → 0.2.6), the existing `statusLine` keeps working without re-running `install.sh`. The command then optionally runs the bash script at `$TOKENPLAN_UPSTREAM_CMD` (so the user can compose with another statusline, e.g. `ccstatusline` or `claude-hud`), captures its stdout into the `TOKENPLAN_UPSTREAM` env var, then execs `dist/index.js` forwarding stdin. If `TOKENPLAN_UPSTREAM_CMD` is unset, `TOKENPLAN_UPSTREAM` is empty and this plugin becomes the sole statusline. Note: `TOKENPLAN_UPSTREAM_CMD` is an **absolute path** to a bash script (a shebang + `exec bash -c '...'` wrapper written by install.sh), not a shell command line — older v0.1.10–v0.1.11 used `bash -c` against the path and silently failed; v0.1.12 runs it as a script (`bash "$TOKENPLAN_UPSTREAM_CMD"`).
2. `src/index.ts` reads stdin (drains it; we don't use the session fields), gates on `ANTHROPIC_BASE_URL` containing `minimaxi.com`, and reads `process.env.ANTHROPIC_AUTH_TOKEN` as the Bearer token for the API call.
3. The API response is parsed by `parseRemains` in `src/api.ts`. It accepts two shapes:
   - **Real shape** (verified against `https://www.minimaxi.com/v1/token_plan/remains` on 2026-06-24): `{ model_remains: [{ model_name, current_interval_remaining_percent, current_weekly_remaining_percent, start_time, end_time, weekly_start_time, weekly_end_time, … }, …], base_resp: { status_code } }`. We pick the entry with the **lowest interval remaining %** as the source of truth (the most-active model). `start_time`/`end_time` (and their weekly counterparts) populate `Window.resetStartAt` and `Window.resetDurationMs` so the renderer can pick a window-fill-aware reset arrow.
   - **Legacy/fallback shape**: `{ data: { five_hour: { remaining, limit }, weekly: { remaining, limit } } }` — for any provider that returns the simpler schema (no start fields → reset arrow falls back to `resetArrows[0]`).
4. Cache: `src/cache.ts` holds a single 60-second TTL entry. On fetch failure it returns the stale value so the statusline doesn't blank.
5. Render: `src/render.ts` emits a single compact line `Usage: ▓░░░░░░░ 9% (4h47m🕔 5h) · ▓▓░░░░░░ 25% (2d8h🕔 7d)`. Layout: a single mode label prefix (`Usage:` or `Remain:`), then per-window `<bar> <coloredN%><RESET> (<countdown><glyph> <windowLabel>)` segments joined with ` · `. When the window has no reset time (DeepSeek, legacy), the segment renders as ` <windowLabel>` (no parens, no arrow). Sub-minute remaining renders as `<1m` by default (so a window about to reset is distinguishable from one with a full minute left) — set `stale.minUnit: "s"` to opt into second precision (`47s` instead). Default mode is **`used`** (line begins with `Usage:`); set `display: "remaining"` in `config.json` to switch. 5-band colors (256-color SGR): bright green / dark green / yellow / orange / red, applied to the displayed value at 0/20/40/60/80 boundaries. The colored chunk is always on the right side of the bar, sized by the displayed value. The reset arrow glyph comes from `stale.resetArrows` (default 12 clock-face emoji `🕛,🕚,🕙,…,🕐`), indexed by `remainingMs / resetDurationMs` so the array reads left-to-right as "few remaining → many remaining" (i.e. ascending by remaining-time ratio). Two glyphs (`["⏳","⌛"]`) reproduce the v0.2.1 hourglass pair; one glyph is static. Providers without start data (DeepSeek, legacy) fall back to index 0.
6. Compose: `src/composition.ts` emits upstream (whatever `TOKENPLAN_UPSTREAM` contains — possibly multi-line, possibly ANSI-colored) on the leading lines and our line last. It strips only trailing whitespace, injects `\x1b[0m` if upstream ends with an unclosed SGR, and otherwise preserves upstream verbatim.
7. **Token-usage module (v0.4.0+):** In addition to the tokenplan 5h/7d window display, the plugin reads the session JSON from stdin (verified schema: `context_window.{total_input_tokens, total_output_tokens, current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}}`, `cost.total_duration_ms`, `session_id`, `cwd`) and exposes fine-grained modules via `lineTemplate`: `m_tokenIn`, `m_tokenOut`, `m_tokenTotal`/`m_tokenSession`, `m_ctx`, `m_cacheHitRate`, `m_cacheRead`, `m_token5h`, `m_token7d`, `m_tokenInSpeed`, `m_tokenOutSpeed`. All modules are opt-in — the default `lineTemplate` does NOT include any token module, so existing v0.3.x configs render byte-identical after upgrade. Live data comes from stdin (zero IO for m_tokenIn/m_tokenOut/m_ctx/m_cacheRead/m_cacheHitRate/m_tokenInSpeed/m_tokenOutSpeed); 5h/7d modules read an append-only JSONL state file at `state/token-samples/<projectHash>/<sessionId>.jsonl` (~120B per tick, ~700KB over 7d). See `memory/token-usage-design-adr.md` for the full module list, color policy, and trade-off rationale.

### How `:install` / `:uninstall` / `:clean` run

`commands/*.md` are **Pattern B2** slash commands (same shape as `claude-plugins-official/ralph-loop`): the body is a ` ```! ` fenced block that the loader executes directly with the framework-provided `CLAUDE_PLUGIN_ROOT` env var pointing at the installed cache dir, scoped via `allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/<name>.sh:*)`. Arguments typed after the slash command are appended via `$ARGUMENTS`. The LLM sees the script's stdout but does not need to act — this eliminates the "LLM received the prompt but chose to describe instead of executing" failure mode that affected the older Pattern A `commands/install.md` (v0.1.0–v0.2.6, where the markdown was a prose instruction to the LLM). For these three commands there is no LLM reasoning to do — `install.sh` / `uninstall.sh` / `clean.sh` are already idempotent, parameter-complete, and self-verifying.

### How `install.sh` patches `settings.json`

The install script is the **only** way the plugin writes to `settings.json`. The marketplace install copies files into the cache but does not claim `statusLine` (the manifest declares no `statusLine` field). `/tokenplan-usage-hud:install` does the patching:

1. Resolves the active `settings.json` (user-level by default; `--project` for project-level). If `--project` and the file is missing, creates a minimal one (it does NOT copy from user-level).
2. Reads `statusLine` via `scripts/lib/edit-settings.mjs`:
   - `_tokenplan_managed === true` → already ours, no-op.
   - `command` is some foreign string → back up the file to `settings.json.bak.<ISO-timestamp>`, preserve the original command at `<claude-root>/plugins/tokenplan-usage-hud/state/upstream-cmd.sh` (with shebang) and `<claude-root>/plugins/tokenplan-usage-hud/state/upstream-cmd.txt` (bare command), then rewrite `statusLine` to invoke our wrapper with `TOKENPLAN_UPSTREAM_CMD=<upstream-cmd.sh>`. The state dir is sibling of `config.json` — STABLE across `/plugin install` rolls and cache wipes, so a future uninstall can always find it.
   - no `statusLine` → just install our wrapper.
3. Rewrites the file via `scripts/lib/edit-settings.mjs`, which preserves the original line ending (CRLF on Windows, LF elsewhere).

`install.sh --uninstall` is a thin shim that exec's `scripts/uninstall.sh`. The uninstaller is the source of truth; it works even when the plugin cache is gone (priority order: stable `state/upstream-cmd.txt` → highest-version legacy `state/upstream-cmd.txt` → most recent pre-managed `settings.json.bak.<ts>`). It also removes `tokenplan-usage-hud@tokenplan-usage-hud` from `settings.json.enabledPlugins` and wipes `cache/`, `marketplaces/`, `plugins/tokenplan-usage-hud/state/`, and the loader's JSON rows. Idempotent. See `scripts/uninstall.sh` for the full state machine.

`install.sh --restore` is a coarser recovery: it copies the most recent `settings.json.bak.<ts>` over the current `settings.json`, regardless of what changed since.

## Installation into Claude Code

The plugin is delivered as files at a fixed cache path: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/<version>/`. The `wrapper.sh`, `install.sh`, and `dist/index.js` are picked up by the marketplace machinery once the version directory exists.

After install, run `/tokenplan-usage-hud:install` to wire the wrapper into `settings.json`. The script marks `statusLine._tokenplan_managed = true` so re-running it is a no-op. If another plugin later overwrites `statusLine`, just re-run `/tokenplan-usage-hud:install` — it detects the marker is gone and re-establishes it.

**This plugin must be the sole `statusLine` owner.** Claude Code does not currently compose two plugins' `statusLine` fields — the later-installed plugin wins. To compose with another statusline (e.g. `ccstatusline`), invoke it from inside our wrapper via `TOKENPLAN_UPSTREAM_CMD` rather than installing it as a second plugin.

## Security

- `ANTHROPIC_AUTH_TOKEN` is read from `process.env` and used only as the Bearer header for a single GET. It is **never** logged, written to stdout, persisted, or echoed in error messages.
- `.gitignore` excludes `.claude/settings.json` (which contains the live token in this project) and `~/.claude/settings.json` is the user's file — never modify it programmatically without preserving all other keys.
- `scripts/install.sh` only touches `settings.json`; it never reads `env.ANTHROPIC_AUTH_TOKEN` and never writes it to a different file.
- `settings.example.json` is a checked-in template; never put a real token in it.
- See `SECURITY.md` for full policy.

## Testing notes

- `npm test` runs all 64 tests in ~250ms. No network calls in tests — they exercise pure functions and fixtures.
- The captured real response lives at `src/__fixtures__/remains.real.json` and is the source of truth for the parser's shape assumptions. If MiniMax changes the API, capture a fresh response and update both the fixture and `src/api.ts`.
- Live smoke test (no Claude Code needed): `echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=<token> node dist/index.js`.
- Live install smoke test: `bash scripts/install.sh --dry-run` then `bash scripts/install.sh` then `bash scripts/uninstall.sh` (or `bash scripts/uninstall.sh --dry-run` first).
- Live uninstall smoke test: `bash scripts/uninstall.sh --dry-run` then `bash scripts/uninstall.sh`. Re-run to confirm idempotency.

## Build & release

- `npm run build` produces `dist/index.js` (~9kb). This is the only artifact the runtime needs.
- Tag releases as `vX.Y.Z`; marketplace install picks up the highest version directory under `~/.claude/plugins/cache/<plugin>/<plugin>/`.
- Push to GitHub via `gh repo create cwf818/tokenplan-usage-hud --public --source=. --remote=origin --push` then `git push --tags`. (This requires `gh` CLI auth — see README "Push to GitHub" if `gh` is not available.)

## Dev loop: re-installing the plugin from scratch

When iterating on the install flow itself (changes to `scripts/install.sh`, `scripts/lib/edit-settings.mjs`, the `commands/install.md` slash command, or the version), you need to **fully wipe** the plugin's on-disk state before `/plugin install` will re-fetch the new version. The plugin loader caches the marketplace and refuses to bump an already-installed plugin, so a stale `installed_plugins.json` row or a stale `known_marketplaces.json` row can block upgrades silently (and on Windows the loader surfaces this as `EPERM: operation not permitted, rename ... -> ... .bak`).

Use the bundled dev helper (does **not** touch `settings.json` — your statusLine is preserved):

```bash
# Preview what will be removed (no changes):
npm run dev:uninstall:dry

# Actually wipe tokenplan-usage-hud state:
npm run dev:uninstall
# — or:  bash scripts/dev-uninstall.sh
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