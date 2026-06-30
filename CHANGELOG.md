# Changelog

## v0.4.0

### Added

- 16 new statusline modules reading the captured Claude Code stdin
  payload (verbatim from `/statusline`'s stdin pipe):
  - `m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccVersion` —
    session identity / metadata.
  - `m_sessionDuration`, `m_sessionApiDuration` — elapsed wall-clock
    duration in `1d2h3m` format.
  - `m_linesAdded`, `m_linesRemoved` — `+ 3965` / `- 967` style.
  - `m_tokenInTotal`, `m_tokenOutTotal` — session-cumulative input
    / output tokens (replaces the pre-v0.4.0 `m_tokenIn` /
    `m_tokenOut` semantics).
  - `m_contextSize`, `m_contextUsed` — context window size (compact
    form) and used percentage.
  - `m_windowContext` — bar + 5-band-colored percentage, parallel
    to `m_window5h` / `m_window7d`.
- New `src/__fixtures__/stdin.real.json` reference fixture capturing
  the full Claude Code session JSON shape (verified 2026-06-29).
- `TokenSnapshot` widened with new nullable sub-fields
  (`sessionName`, `modelDisplayName`, `effort`, `repo`, `ccversion`,
  `contextWindow`, `cost.totalApiDurationMs`, `cost.totalLinesAdded`,
  `cost.totalLinesRemoved`).
- `RenderContext` widened with `contextWindow: Window | null`
  (synthesized from `tokens.contextWindow.usedPct` for
  `m_windowContext`).
- `:display:used` / `:display:remaining` inline-args override for
  `m_window5h`, `m_window7d`, `m_windowContext`. Scoped to that
  module's bar computation only — does NOT mutate the global
  `display` config field. Accepts `used` / `remaining` verbatim
  (case-sensitive); anything else drops the token and warns once.
  The bare `m_window5h` form is byte-for-byte unchanged (still
  reads the global `display` config). Combine with `:color:` for
  both axes, e.g. `m_window5h:display:remaining:color:yellow`.
- `m_tokenInAvg` / `m_tokenOutAvg` modules — running-average per-API-call
  speed (`sum(current_tokens) / sum(delta_api) * 1000`, where
  `current_tokens` is the per-turn delta `current_usage.*`
  directly, NOT `current - prev`), backed by a per-session
  accumulator in `state/cache.json` (separate key
  `tickAvg:<sessionId>`, distinct from the per-tick `tickSpeed:`
  snapshot). Only valid-API-call ticks contribute
  (`delta_api > 0`); idle ticks don't accumulate. IN and OUT
  don't have to move together (a thinking-only turn adds 0
  input but real output, or vice versa), so we no longer
  require `delta_in >= 0 AND delta_out >= 0` — the contract
  `current_usage.*` is non-negative per-turn delta means
  regressions can't happen. First tick assumes `prev=0` and
  contributes. Like the speed modules, these always render —
  the slot in `lineTemplate.plan` is stable. Optional
  `:color:` override.
- Three per-session running-total modules — `m_totalTokenIn`,
  `m_totalTokenOut`, `m_totalTokenWithCacheIn`. Accumulate
  `current_usage.{input_tokens, output_tokens,
  cache_read_input_tokens}` directly across all
  valid-API-call ticks (`delta(total_api_duration_ms) > 0`;
  first tick assumes `prev=0`). The running totals live in
  the SAME `tickAvg:<sessionId>` cache slot that
  `m_tokenInAvg` / `m_tokenOutAvg` use — single source of
  truth. `AvgSnapshot` is extended with a `sumCache` field;
  both module families fire `setAvg` (idempotent — guarded by
  a per-render `_tickAvgWriteMemo` WeakMap so a template that
  mixes avg + totals + per-API-call modules still accumulates
  each delta exactly once). Always render — the first tick
  contributes (no more `in:0` / `out:0` / `cache:0` sentinels
  on the first tick), and idle ticks don't accumulate
  (`deltaApi <= 0`). `m_totalTokenWithCacheIn` renders
  `cache:--` when stdin lacks `current_usage.cache_read_input_tokens`
  (honest "data unavailable" signal, distinct from "no
  contributions yet"); otherwise `cache:<compact>`. Optional
  `:color:` override. The dispatcher lists
  `m_totalTokenWithCacheIn:` BEFORE the shorter
  `m_totalTokenIn:` / `m_totalTokenOut:` prefixes for
  prefix-shadowing safety (no actual shadowing — chars at
  index 17 differ — but listed first defensively).

### Changed

- `m_tokenIn` and `m_tokenOut` now read **`current_usage.{input,
  output}_tokens` directly as the per-turn delta** (Claude
  Code's session JSON already reports per-turn contribution —
  verified against the `stdin.real.json` fixture: `current_usage.
  input_tokens=140` while `total_input_tokens=126860`). The
  only subtraction is `delta(cost.total_api_duration_ms) > 0`
  — when API time grew this turn, the per-turn delta is
  valid. **No more `current - prev` subtraction**: the value
  IS the per-turn delta. The prev cache is only used to
  measure API time growth, not to compute token deltas. These
  modules **always render** — when no API call landed between
  ticks (idle tick with `delta(totalApiDurationMs) <= 0`) the
  chunk is **`in:0`**. First tick of a session, session change,
  or any cache miss now assumes **`prev.apiMs=0`** so the
  first turn still contributes its per-turn delta (no more
  `in:0` sentinel on first tick). For session-cumulative
  totals, use `m_tokenInTotal` / `m_tokenOutTotal` (or the
  existing `m_tokenTotal` / `m_tokenSession` for the
  in+out+cache total).
- `m_tokenInSpeed` and `m_tokenOutSpeed` compute the per-API-call
  throughput as **`current_usage.input_tokens /
  delta(total_api_duration_ms) * 1000`** (the per-turn delta
  is `current.*` directly, not `current - prev`). The renderer
  caches the previous tick's `totalApiDurationMs` (keyed by
  `sessionId`, disk-shadowed to `state/cache.json`). The
  direction-specific zero-rejection gate that previously
  collapsed `deltaIn == 0` to `-- t/s` is **gone** — a
  thinking-only turn that adds 0 input tokens but a real
  output rate shows the truthful `0.0 t/s` rate, not
  `-- t/s`. (A zero-delta gate conflated "API call landed but
  added nothing" with "no data / no API call" — a confusion
  the new contract removes.) **Always render** — only a true
  `deltaApi <= 0` (no API call) renders as `in:-- t/s`.
  First tick assumes `prev=0` and contributes its rate. The
  slot in `lineTemplate.plan` stays stable.
- `m_tokenInSpeed` / `m_tokenOutSpeed` cache the **last
  ACTIVE-tick tps per session** (key
  `tickSpeedDisplay:<sessionId>`, separate from
  `tickSpeed:<sessionId>`). On an idle tick
  (`deltaApi <= 0`), the module falls back to the cached tps
  and renders in **STALE_COLOR** (gray) — so the user reads
  the gray as "this is a stale measurement from a previous
  API call, not a real one now", and the speed module stops
  blinking through `-- t/s` between real measurements during
  fast statusline ticks. Idle ticks do NOT overwrite the
  cache — the cached value is "the last thing I measured"
  until the next active tick replaces it.
- New `:color:scale` inline-args value for `m_tokenInSpeed` /
  `m_tokenOutSpeed` (and the bare default — no `:color:` is
  now scale-aware). The scale maps tps to one of 5 colors
  (bright green / dark green / yellow / orange / red, faster
  = greener), with the OUT thresholds at `[10, 20, 40, 80]`
  t/s and the IN thresholds at `[50, 100, 200, 400]` t/s
  (input streams naturally run ~5× hotter than output).
  Thresholds are config-driven under
  `tokenFormat.speedScaleBands = { in, out }` — defaults
  match the values above. `:color:red` (or any other named
  shortcut / raw SGR) overrides scale on the **active**
  tick only — idle ticks always render STALE_COLOR
  regardless of `:color:` (gray is the canonical "inactive"
  signal, and inverting the override on idle ticks would
  conflate "stale measurement" with "this turn was actually
  this slow"). The MODULES path (bare `m_tokenInSpeed`)
  also defaults to scale, so the bare form and
  `:color:scale` are byte-equivalent.
- `m_ccversion` renamed to `m_ccVersion` for consistency with
  the other camelCase metadata modules (`m_sessionDuration`,
  `m_windowContext`, etc.). Module key, schema, renderer,
  dispatcher branch, tests, and docs updated. The bare
  `m_ccversion` token is no longer recognized and will hit the
  standard "unknown lineTemplate module" warn path.
- `parseTokenSnapshot` is shape-tolerant on the new `effort` field
  (accepts both bare strings and `{ level: "high" }` objects) and
  on the new `workspace.repo` field (preserves the sub-object even
  when some sub-fields are null, so the renderer can decide whether
  to render the partial join).
- `:nulldrop:<true|false>` inline-args parameter on every `m_*`
  module. **Default = `:nulldrop:false` (force placeholder when
  data is null)** so the slot stays in `lineTemplate.plan` and
  the line layout doesn't shift when stdin lacks a field (e.g.
  after `/clear` starts a new session and `used_percentage` is
  missing). `:nulldrop:true` opts OUT of the placeholder and
  preserves the v0.3.x drop-on-null behaviour for users who
  prefer the slot to disappear. Placeholder shape per family:
  pure-number → `<prefix>n/a` (e.g. `ctx:n/a`, `in:n/a`),
  number+unit → `-- <unit>` (e.g. `5h:--`, `+ --`, `- --`,
  `in:-- t/s`), gauge → `░░░░░░░░ 0%` (or `▓▓▓▓▓▓▓▓ 100%` in
  remaining mode), bare-string → `n/a`. The default color is
  `STALE_COLOR`; `:color:<c>` overrides as with every other
  inline module. The bare MODULES path is **unchanged** — bare
  `m_ctx` / `m_windowContext` / etc. still drop on null, since
  pre-v0.4.0 configs that listed bare tokens must not silently
  change behaviour. To opt a bare-style config into the
  placeholder, add the trailing colon (`m_ctx:`) — the inline
  form defaults to placeholder. Modules whose inline renderers
  already force a placeholder via the always-render rule
  (`m_tokenIn` / `m_tokenOut` / speed / avg / totals / `m_token5h`
  / `m_token7d`) accept `:nulldrop:` for schema uniformity but
  the parameter has no effect on their output.

### Changed (BREAKING)

- **`lineTemplate` config field is REMOVED in v0.4.0** — replaced
  by two new top-level fields:
  - **`lineTemplates`** — a registry of reusable template fragments.
    Values are token arrays. Allowed tokens: any `m_*` module
    **EXCEPT `m_template`**, plus `s_*` separators. Keys are
    user-chosen. Default-merged with the legacy `{ plan, balance }`
    shape so existing internal lookups keep working.
  - **`statuslineTemplate`** — the actual template the renderer
    walks. Accepts **a fixed preset name** (e.g. `"1line"`,
    `"simple"`, `"standard"`, `"abundant"`, `"complete"`,
    `"simple-alone"`, `"simple-alone"` for balance) **OR a raw
    token array**. Array form may include `m_template:` tokens
    and any other `m_*` / `s_*`. String form does NOT accept
    arbitrary `lineTemplates` keys — only the fixed preset names.
  - **Migration is a HARD BREAK** — the loader emits one
    `tokenplan-usage-hud: config lineTemplate is removed in v0.4.0`
    warning per config load and ignores the legacy field
    entirely. There is no auto-promotion of `lineTemplate.plan`
    → `lineTemplates.plan`. v0.3.x users who customized the
    `lineTemplate` block must rename it to `statuslineTemplate`
    (string preset or raw array) and move reusable fragments to
    `lineTemplates`. v0.4.0's default config produces the same
    rendering as v0.3.6's default — only customized configs
    require manual migration.

### Added (v0.4.0+)

- New `m_template:<key>[:mode:<plan|balance>][:nulldrop:<bool>]`
  inline-args module — expands the registered
  `lineTemplates[key]` fragment into the current render. Mode
  filter (`mode:<plan|balance>`, default `plan`) hides the
  chunk on the wrong provider type, so a single
  `lineTemplates` key can render differently for plan vs
  balance providers (e.g. share the `Usage:` / `Balance:`
  label, customize the body). Nesting is impossible: the
  loader strips `m_template:` tokens from any `lineTemplates`
  entry at load time. Missing key → warns + drops. Mode
  mismatch → silent drop (no warn). `:color:` is silently
  ignored on `m_template`; put `:color:` on the inner
  modules if needed.

### Changed (BREAKING) — Per-Project State Layout

The plugin's runtime state directory is now partitioned by
project, so multiple Claude Code sessions running in
**different** project directories never contend over the same
files. Assumption: one project directory → one Claude Code
session; multi-Claude workflows come from opening the project
in different directories.

**New layout** under
`~/.claude/plugins/tokenplan-usage-hud/state/`:

```
state/
  upstream-cmd.sh              # top-level — install/uninstall dependency, NOT touched
  upstream-cmd.txt             # top-level — install/uninstall dependency, NOT touched
  config.json                  # top-level — install/uninstall dependency, NOT touched
  <projectHash>/               # e.g. d--workspace-tokenplan-usage-hud
    cache.json                 # disk-shadowed TTL cache (per-project key isolation)
    diagnostics.jsonl          # append-only warning/error log (per-project)
    <sessionId>.jsonl          # token samples (was state/token-samples/<hash>/<sid>.jsonl)
```

- `cache.json`, `diagnostics.jsonl`, and token-samples have
  moved **off the top-level** and into
  `state/<projectHash(cwd)>/`. The `projectHash(cwd)` helper
  (lowercased, `\/: ` → `-`, control chars stripped, capped at
  80 chars) was already exported from `src/token-store.ts` —
  every per-tick IO path now derives its path from the cwd in
  `TokenSnapshot`.
- Cache key isolation across projects: `src/render.ts` prefixes
  every cache key with `<projectHash>:<key>`. The cache module
  API itself is unchanged — the prefix lives in render.ts so
  the disk format stays single-keyed and cache tests still pass
  with no mocks. Per-project `cache.json` files never share
  keys.
- Diagnostics: `append(level, source, msg, now?, cwd?)` /
  `readLatest(level, cwd?)` / `diagnosticsPath(cwd?)` gained
  an optional `cwd` argument. When omitted or null, writes fall
  back to the legacy top-level `state/diagnostics.jsonl` so
  plugin-level errors (e.g. config-parse warnings) still have
  somewhere to go. `src/index.ts` passes `tokens?.cwd ?? null`.
- Token samples: `sampleFilePath` now builds
  `state/<projectHash(cwd)>/<sessionId>.jsonl` directly (the
  intermediate `token-samples/` directory is gone). The
  `m_token5h` / `m_token7d` modules continue to call
  `readSamples(t.cwd, ...)` and get per-project isolation
  transparently.

**Migration for users upgrading from v0.4.0–v0.4.<n-1>**:
legacy top-level `cache.json` and `diagnostics.jsonl` are NOT
auto-migrated (no project information is recoverable from
them — start fresh). Legacy
`state/token-samples/<projectHash>/<sessionId>.jsonl` files
are also not auto-migrated on tick (would cost 3–10ms IO per
tick for time-decaying data). To preserve old token samples,
run the bundled one-shot helper:

```bash
bash scripts/migrate-state.sh         # actually move
bash scripts/migrate-state.sh --dry-run  # preview only
```

It `mv -n`s each
`state/token-samples/<hash>/<sid>.jsonl` →
`state/<hash>/<sid>.jsonl`, then `rmdir`s the empty project
subdirs and the empty `token-samples/` parent. Idempotent.

**Cleanup**: `clean.sh --purge-runtime` now walks every
`state/*/` subdir and removes its `cache.json`,
`diagnostics.jsonl`, and `<*.jsonl>` files. It still cleans
the legacy top-level `cache.json` / `diagnostics.jsonl` and
the `state/token-samples/` tree (one-shot upgrade path for
users who don't bother with `migrate-state.sh`). Top-level
`upstream-cmd.{sh,txt}` and `config.json` are NEVER purged —
install/uninstall depends on them.

`scripts/uninstall.sh` is unchanged at the code level — the
existing `rm -rf "$STATE_DIR"` is naturally compatible with
the per-project layout.

## v0.3.6

- `m_quote` module: numeric time format for `:freq` inline-args.
