# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code statusline plugin (`tokenplan-usage-hud`) that appends **MiniMax token-plan usage** (5-hour and weekly windows) to the existing `claude-hud` output. When `ANTHROPIC_BASE_URL` does not point at MiniMax, the plugin hides itself and passes upstream output through unchanged.

The plugin is shipped as a **single-plugin marketplace**: the repo root IS the marketplace, and `.claude-plugin/plugin.json` declares the plugin. Install with `/plugin marketplace add chen20220011/tokenplan-usage-hud` then `/plugin install tokenplan-usage-hud@tokenplan-usage-hud`.

## Commands

```bash
npm install          # install dev deps (esbuild, typescript, tsx, @types/node)
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx (32 tests across api/render/cache/composition)
npm run build        # esbuild → dist/index.js (single self-contained ESM bundle, target=node18)
npm run dev          # esbuild --watch
```

There is no separate `lint` step; `typecheck` covers it. Tests run with built-in `node:test` + `tsx` — no vitest/jest dependency.

## Architecture

```
src/
  index.ts            # entry — stdin drain, env gate, cache, render, compose
  api.ts              # fetch + tolerant parser for /v1/token_plan/remains
  render.ts           # pure: pctBar + ANSI color thresholds + formatLine
  cache.ts            # 60s TTL + stale-on-error (Map<key, {at, value}>)
  composition.ts      # reads TOKENPLAN_UPSTREAM env, prepends + appends line
  __fixtures__/       # remains.real.json (captured live), remains.empty.json
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest (name, version, homepage)
  marketplace.json    # single-plugin marketplace wiring
scripts/
  wrapper.sh          # bash wrapper: claude-hud → TOKENPLAN_UPSTREAM → us
dist/
  index.js            # gitignored, esbuild bundle, the actual entry point
settings.example.json # template (NEVER commit real settings.json)
```

### How it runs

Claude Code's `statusLine.command` spawns a child process that reads a session JSON from stdin and writes statusline text to stdout. Per-turn invocation — the plugin must be fast and never block.

1. `scripts/wrapper.sh` (invoked by `statusLine.command`) runs the installed `claude-hud`, captures its stdout into the `TOKENPLAN_UPSTREAM` env var, then execs `dist/index.js` forwarding stdin.
2. `src/index.ts` reads stdin (drains it; we don't use the session fields), gates on `ANTHROPIC_BASE_URL` containing `minimaxi.com`, and reads `process.env.ANTHROPIC_AUTH_TOKEN` as the Bearer token for the API call.
3. The API response is parsed by `parseRemains` in `src/api.ts`. It accepts two shapes:
   - **Real shape** (verified against `https://www.minimaxi.com/v1/token_plan/remains` on 2026-06-24): `{ model_remains: [{ model_name, current_interval_remaining_percent, current_weekly_remaining_percent, end_time, weekly_end_time, … }, …], base_resp: { status_code } }`. We pick the entry with the **lowest interval remaining %** as the source of truth (the most-active model).
   - **Legacy/fallback shape**: `{ data: { five_hour: { remaining, limit }, weekly: { remaining, limit } } }` — for any provider that returns the simpler schema.
4. Cache: `src/cache.ts` holds a single 60-second TTL entry. On fetch failure it returns the stale value so the statusline doesn't blank.
5. Render: `src/render.ts` emits a single compact line `5h ▓▓▓░░░░░ 38% · wk ▓▓▓░░░░░ 39%`. ANSI colors: green < 20% used, yellow 20–50%, red ≥ 50% — applied to the filled bar and percentage only; the empty bar stays uncolored.
6. Compose: `src/composition.ts` emits upstream (claude-hud output) on line 1 and our line on line 2.

### Installation into Claude Code

The plugin is delivered as files at a fixed cache path: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/<version>/`. The `wrapper.sh` and `dist/index.js` are picked up by the marketplace machinery once the version directory exists.

`~/.claude/settings.json` needs:
- `statusLine.command` pointing at the wrapper.
- `enabledPlugins["tokenplan-usage-hud@tokenplan-usage-hud"] = true`.
- `extraKnownMarketplaces["tokenplan-usage-hud"]` registered.

## Security

- `ANTHROPIC_AUTH_TOKEN` is read from `process.env` and used only as the Bearer header for a single GET. It is **never** logged, written to stdout, persisted, or echoed in error messages.
- `.gitignore` excludes `.claude/settings.json` (which contains the live token in this project) and `~/.claude/settings.json` is the user's file — never modify it programmatically without preserving all other keys.
- `settings.example.json` is a checked-in template; never put a real token in it.
- See `SECURITY.md` for full policy.

## Testing notes

- `npm test` runs all 32 tests in ~250ms. No network calls in tests — they exercise pure functions and fixtures.
- The captured real response lives at `src/__fixtures__/remains.real.json` and is the source of truth for the parser's shape assumptions. If MiniMax changes the API, capture a fresh response and update both the fixture and `src/api.ts`.
- Live smoke test (no Claude Code needed): `echo '{}' | ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic ANTHROPIC_AUTH_TOKEN=<token> node dist/index.js`.

## Build & release

- `npm run build` produces `dist/index.js` (~9kb). This is the only artifact the runtime needs.
- Tag releases as `vX.Y.Z`; marketplace install picks up the highest version directory under `~/.claude/plugins/cache/<plugin>/<plugin>/`.
- Push to GitHub via `gh repo create chen20220011/tokenplan-usage-hud --public --source=. --remote=origin --push` then `git push --tags`. (This requires `gh` CLI auth — see README "Push to GitHub" if `gh` is not available.)