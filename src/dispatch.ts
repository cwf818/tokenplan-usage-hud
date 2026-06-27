// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so it can be exercised by tests without
// touching process.stdin / process.env (and without importing index.ts,
// which has top-level `await main()` side effects).
//
// Three outcomes the provider data layer can report:
//   fresh — we just successfully fetched the data; `ageMs` is 0 (the
//           formatter short-circuits when ageMs <= 0, so no X-ago suffix
//           appears on a fresh tick).
//   stale — fetch failed but a cached value exists; `ageMs` is how long
//           it's been since the last successful fetch (from cache.Entry.at).
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// v0.2.16: dropped the v0.2.15 `ageFromRemains` helper. That helper
// computed "time since the 5h window started" from the API response's
// resetStartAt — but that's a business-progress signal, not a data-
// freshness signal, and conflating the two produced wrong emojis (a
// 1h28m window incorrectly rendered ⛓️‍💥 just because the cache age
// exceeded TTL). The cache already exposes the right primitive via
// peekWithAge; fresh ticks just don't need a suffix.

import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import { formatBalanceLine, formatLine, RED, RESET, resolveDisplayMode } from "./render.ts";
import type { Provider } from "./types.ts";

export type FetchResult<T> =
  | { kind: "fresh"; data: T }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// Render the MiniMax two-window line from a Remains payload. The `stale`
// flag controls the healthy/broken emoji in the suffix; on fresh ticks
// no ageMs is passed, so the suffix is suppressed entirely (no point
// telling the user "0s ago" — they can see the line render in real time).
export function renderPlanLine(
  data: Remains,
  mode: ReturnType<typeof resolveDisplayMode>,
  ageMs?: number,
  stale: boolean = false,
): string | null {
  if (data.fiveHour && data.weekly) {
    return formatLine(data.fiveHour, data.weekly, mode, Date.now(), ageMs, stale);
  }
  // If only one window is present, render what's available rather than nothing.
  const zero = { pct: 0 } as const;
  if (data.fiveHour) return formatLine(data.fiveHour, zero, mode, Date.now(), ageMs, stale);
  if (data.weekly) return formatLine(zero, data.weekly, mode, Date.now(), ageMs, stale);
  return null;
}

// Maps a (provider, FetchResult) pair to the final statusline line.
export function buildProviderLine(
  provider: Provider,
  result: FetchResult<Remains> | FetchResult<Balance>
): string | null {
  if (result.kind === "fail") {
    // No cached data + fetch failed. Render a colored "not available!" so the
    // user sees the plugin is alive but the provider is unreachable. Color
    // matches the existing "is_available: false" branch in formatBalanceLine
    // (RED) so the two unavailable states look the same on screen.
    if (provider === "minimax") return `Usage: ${RED}not available!${RESET}`;
    if (provider === "deepseek") return `Balance: ${RED}not available!${RESET}`;
    return null;
  }
  if (provider === "minimax") {
    // Display mode now lives in configStore — the old TOKENPLAN_DISPLAY
    // env var is gone (see README "Configuration").
    const mode = resolveDisplayMode();
    const stale = result.kind === "stale";
    return renderPlanLine(
      result.data as Remains,
      mode,
      stale ? result.ageMs : undefined,
      stale,
    );
  }
  if (provider === "deepseek") {
    // DeepSeek has no window concept; the suffix only renders on
    // stale-on-error (when ageMs > 0). Fresh ticks are unsuffixed.
    const stale = result.kind === "stale";
    return formatBalanceLine(
      result.data as Balance,
      stale ? result.ageMs : undefined,
      stale,
    );
  }
  return null;
}