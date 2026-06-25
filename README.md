# tokenplan-usage-hud

Claude Code statusline plugin that renders **MiniMax token-plan usage** (5-hour and weekly windows). The plugin ships its own installer that hooks into Claude Code's `statusLine` slot and (optionally) chains any pre-existing statusline (e.g. `ccstatusline`, `claude-hud`) as the upstream. When `ANTHROPIC_BASE_URL` does not point at MiniMax, the line is hidden and upstream output passes through unchanged.

```
[upstream statusline lines]
5h ▓▓▓▓░░░░ 40% · wk ▓▓░░░░░░ 20%
```

ANSI colors: green ≥ 50 % used, yellow 20–50 %, red < 20 %. Applied to the filled bar + percentage; empty bar stays uncolored so it remains readable.

## Install

After `/plugin install tokenplan-usage-hud@tokenplan-usage-hud`, run the install command:

```
/tokenplan-usage-hud:install
```

This patches the active `settings.json` (user-level by default; pass `--project` for project-level):

1. If `statusLine` is already managed by us (`_tokenplan_managed: true`), the command is a no-op.
2. Otherwise, the current `settings.json` is backed up to `settings.json.bak.<ISO-timestamp>`.
3. The original `statusLine.command` is preserved at `<plugin-cache>/state/upstream-cmd.sh` and `<plugin-cache>/state/upstream-cmd.txt`.
4. The `statusLine` is rewritten to invoke our wrapper, which sets `TOKENPLAN_UPSTREAM_CMD=<upstream-cmd.sh>` so the original statusline runs above our line.

If you want to preview what install will do, run `/tokenplan-usage-hud:install --dry-run` first.

If your active `settings.json` doesn't exist at the project level, install creates a minimal one (with `permissions.defaultMode: bypassPermissions`). It does **not** copy from the user-level file.

### Uninstall

```
/tokenplan-usage-hud:install --uninstall
```

Restores the original `statusLine.command` from `<plugin-cache>/state/upstream-cmd.txt` and removes both state files. Re-running `install` after `--uninstall` is a fresh install (because the marker is gone).

### Restore from backup

```
/tokenplan-usage-hud:install --restore
```

Replaces the active `settings.json` with the most recent `settings.json.bak.<ts>`. Useful if you want to roll back an edit that wasn't made by us.

## How it composes with other statuslines

- The wrapper script is `scripts/wrapper.sh`. It reads `TOKENPLAN_UPSTREAM_CMD` from the environment and runs it via `bash -c`, capturing stdout into `TOKENPLAN_UPSTREAM`.
- If `TOKENPLAN_UPSTREAM_CMD` is unset, the wrapper runs the plugin as the sole statusline.
- `TOKENPLAN_UPSTREAM_CMD` is any shell string — most users pass it an absolute path to a script that `exec`s the upstream (this is what `install.sh` writes to `state/upstream-cmd.sh`).
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

5-band color thresholds (applied to the displayed value): bright green / dark green / yellow / orange / red at 0 / 20 / 40 / 60 / 80 boundaries.

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

If you capture the first real response and the shape diverges, save it as `src/__fixtures__/remains.real.json` and tighten the parser in `src/api.ts`.

## Develop

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # node --test --import tsx src/**/*.test.ts
npm run build        # esbuild → dist/index.js
npm run dev          # esbuild --watch
```

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
  plugin.json         # plugin manifest
  marketplace.json    # single-plugin marketplace wiring
  commands/install.md # /tokenplan-usage-hud:install slash command
scripts/
  wrapper.sh          # bash wrapper: TOKENPLAN_UPSTREAM_CMD → TOKENPLAN_UPSTREAM → us
  install.sh          # settings.json patcher (install/uninstall/restore/dry-run)
  lib/edit-settings.mjs  # ESM helper used by install.sh
settings.example.json # template (NEVER commit real settings.json)
```

## License

MIT — see [LICENSE](./LICENSE).