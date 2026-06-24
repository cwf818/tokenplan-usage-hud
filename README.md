# tokenplan-usage-hud

Claude Code statusline plugin that appends **MiniMax token-plan usage** (5-hour and weekly windows) to the existing `claude-hud` output. Stays silent on any non-MiniMax provider.

```
[claude-hud line]
5h ▓▓▓▓░░░░ 40% · wk ▓▓░░░░░░ 20%
```

ANSI colors: green ≥ 50 % used, yellow 20–50 %, red < 20 %. Applied to the filled bar + percentage; empty bar stays uncolored so it remains readable.

## Install

### From the marketplace (recommended, once the repo is published)

```bash
/plugin marketplace add cwf818/tokenplan-usage-hud
/plugin install tokenplan-usage-hud@tokenplan-usage-hud
```

### From a local clone

```bash
# inside this repo:
npm install
npm run build
```

Then add the entry below to `~/.claude/settings.json`. It composes with the
existing `claude-hud` by piping its output through this plugin via
`TOKENPLAN_UPSTREAM`.

## settings.json

The wrapper at `scripts/wrapper.sh` is inlined into `statusLine.command`:

```jsonc
{
  "statusLine": {
    "type": "command",
    "command": "bash -c 'hud_dir=$(ls -d \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/claude-hud/claude-hud/*/ 2>/dev/null | awk -F/ '\\''{ print $(NF-1) \"\\t\" $(0) }'\\'' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); self_dir=$(ls -d \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/ 2>/dev/null | tail -1); hud_out=$(/c/Program\\ Files/nodejs/node \"${hud_dir}dist/index.js\" 2>/dev/null || true); TOKENPLAN_UPSTREAM=\"$hud_out\" /c/Program\\ Files/nodejs/node \"${self_dir}dist/index.js\"'"
  },
  "enabledPlugins": {
    "tokenplan-usage-hud@tokenplan-usage-hud": true
  },
  "extraKnownMarketplaces": {
    "tokenplan-usage-hud": {
      "source": { "source": "github", "repo": "cwf818/tokenplan-usage-hud" }
    }
  }
}
```

Replace `/c/Program Files/nodejs/node` with your platform's `node` path on non-Windows. On macOS / Linux this becomes simply `node`.

## Activation

The plugin only renders the token-plan line when `ANTHROPIC_BASE_URL` contains `minimaxi.com` (case-insensitive). On vanilla Anthropic, OpenRouter, or any other provider, the line is hidden and upstream `claude-hud` output passes through unchanged.

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
  composition.ts      # reads TOKENPLAN_UPSTREAM, prepends + appends line
  __fixtures__/       # sample / camelCase / empty / used-only response JSONs
  *.test.ts           # node:test unit tests
.claude-plugin/
  plugin.json         # plugin manifest
  marketplace.json    # single-plugin marketplace wiring
scripts/
  wrapper.sh          # bash wrapper: claude-hud → TOKENPLAN_UPSTREAM → us
settings.example.json # template (NEVER commit a real settings.json)
```

## License

MIT — see [LICENSE](./LICENSE).