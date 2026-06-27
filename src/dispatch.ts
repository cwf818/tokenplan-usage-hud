// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so it can be exercised by tests without
// touching process.stdin / process.env (and without importing index.ts,
// which has top-level `await main()` side effects).
//
// Three outcomes the provider data layer can report:
//   fresh — we successfully obtained the data (from network or from a
//           within-TTL cache hit); `ageMs` is the time since the entry
//           was cached. The renderer short-circuits when ageMs <= 0, so
//           a brand-new fetch (ageMs ≈ 0) suppresses the X-ago suffix
//           entirely. A within-TTL cache hit (e.g. ageMs = 30_000) is
//           semantically fresh but still carries an age that the
//           lineTemplate's m_age module may surface.
//   stale — fetch failed but a cached value exists; `ageMs` is how long
//           it's been since the last successful fetch (from cache.Entry.at).
//           `stale=true` flips the suffix emoji from 🔗 to ⛓️‍💥.
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// v0.2.16: dropped the v0.2.15 `ageFromRemains` helper. That helper
// computed "time since the 5h window started" from the API response's
// resetStartAt — but that's a business-progress signal, not a data-
// freshness signal, and conflating the two produced wrong emojis (a
// 1h28m window incorrectly rendered ⛓️‍💥 just because the cache age
// exceeded TTL). The cache already exposes the right primitive via
// getWithAge / peekWithAge; fresh ticks carry ageMs=0 and the renderer
// suppresses the suffix accordingly.

import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import { formatBalanceLine, formatLine, RED, RESET, resolveDisplayMode } from "./render.ts";
import type { Provider } from "./types.ts";

export type FetchResult<T> =
  | { kind: "fresh"; data: T; ageMs: number }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// Render the MiniMax two-window line from a Remains payload. The `stale`
// flag controls the healthy/broken emoji in the suffix; ageMs <= 0
// suppresses the suffix entirely (no point telling the user "0s ago" —
// they can see the line render in real time).
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
    // ageMs is now carried on BOTH the fresh and stale variants:
    //   fresh.ageMs : 0 for a just-fetched tick; the cache age for a
    //                 within-TTL cache hit (so a user template can opt
    //                 into showing "🔗 30s ago" via the m_age module).
    //   stale.ageMs : how long since the last successful fetch.
    // The renderer's m_age module returns null when ageMs <= 0, so the
    // suffix is auto-suppressed on a brand-new fetch — preserving the
    // v0.2.16 "fresh ticks skip suffix" behavior. The stale boolean
    // continues to flip the emoji (healthy ↔ broken).
    return renderPlanLine(
      result.data as Remains,
      mode,
      result.ageMs,
      result.kind === "stale",
    );
  }
  if (provider === "deepseek") {
    // DeepSeek has no window concept; same ageMs contract as the
    // MiniMax path above. Fresh cache hits carry the cache age; fresh
    // network fetches carry 0 (auto-suppressed by the renderer).
    return formatBalanceLine(
      result.data as Balance,
      result.ageMs,
      result.kind === "stale",
    );
  }
  return null;
}