# Changelog

## v0.4.0 (in development)

### Added

- 16 new statusline modules reading the captured Claude Code stdin
  payload (verbatim from `/statusline`'s stdin pipe):
  - `m_session`, `m_model`, `m_effort`, `m_repo`, `m_ccversion` —
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

### Changed

- `m_tokenIn` and `m_tokenOut` now read
  `context_window.current_usage.input_tokens` /
  `output_tokens` (per-turn) instead of
  `context_window.total_input_tokens` / `total_output_tokens`
  (session-cumulative). For the cumulative semantic, use
  `m_tokenInTotal` / `m_tokenOutTotal` (or the existing
  `m_tokenTotal` / `m_tokenSession` for the in+out+cache total).
- `m_tokenInSpeed` and `m_tokenOutSpeed` now divide
  `current_usage.input_tokens` / `output_tokens` (per-turn) by
  `cost.total_duration_ms` (session total). The math is
  "turn-tokens / session-time" — not a real-time throughput. For
  session-avg speed, see `m_tokenTotal` and divide manually.
- `parseTokenSnapshot` is shape-tolerant on the new `effort` field
  (accepts both bare strings and `{ level: "high" }` objects) and
  on the new `workspace.repo` field (preserves the sub-object even
  when some sub-fields are null, so the renderer can decide whether
  to render the partial join).

## v0.3.6

- `m_quote` module: numeric time format for `:freq` inline-args.
