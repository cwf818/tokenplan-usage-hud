// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so it can be exercised by tests without
// touching process.stdin / process.env (and without importing index.ts,
// which has top-level `await main()` side effects).
//
// Three outcomes the provider data layer can report:
//   fresh — we just successfully fetched the data
//   stale — fetch failed but a cached value exists; `ageMs` is how old it is
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// v0.2.15: the age suffix is now ALWAYS rendered on a successful tick.
// The age is computed from the API response's `Window.resetStartAt`
// (time since the window started) — no disk persistence needed, since
// the API response is the source of truth and is fresh on every tick.

import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import { formatBalanceLine, formatLine, RED, RESET, resolveDisplayMode } from "./render.ts";
import type { Provider } from "./types.ts";

export type FetchResult<T> =
  | { kind: "fresh"; data: T }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// Compute the age suffix from the API data. For MiniMax, this is the
// time since the 5h window started (Window.resetStartAt is part of
// every API response — survives across ticks without persistence).
// Returns 0 when the timestamp is missing or unparseable (the suffix
// is suppressed when ageMs <= 0).
export function ageFromRemains(data: Remains, nowMs: number = Date.now()): number {
  const start = data.fiveHour?.resetStartAt ?? data.weekly?.resetStartAt;
  if (!start) return 0;
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, nowMs - ms);
}

// Render the MiniMax two-window line from a Remains payload. The
// `ageMs` arg comes from the FetchResult — for fresh ticks it's not
// provided, so we derive it from the API's `resetStartAt` (time since
// this window started, baked into every response). For stale ticks,
// `ageMs` carries the time since the last successful fetch. The
// `stale` flag controls the healthy/broken emoji in the suffix.
export function renderPlanLine(
  data: Remains,
  mode: ReturnType<typeof resolveDisplayMode>,
  ageMs?: number,
  stale: boolean = false,
): string | null {
  const effectiveAge = ageMs ?? ageFromRemains(data);
  if (data.fiveHour && data.weekly) {
    return formatLine(data.fiveHour, data.weekly, mode, Date.now(), effectiveAge, stale);
  }
  // If only one window is present, render what's available rather than nothing.
  const zero = { pct: 0 } as const;
  if (data.fiveHour) return formatLine(data.fiveHour, zero, mode, Date.now(), effectiveAge, stale);
  if (data.weekly) return formatLine(zero, data.weekly, mode, Date.now(), effectiveAge, stale);
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
    // DeepSeek has no window-start concept; the suffix only renders
    // on stale-on-error (when the caller-supplied ageMs > 0).
    const stale = result.kind === "stale";
    return formatBalanceLine(
      result.data as Balance,
      stale ? result.ageMs : undefined,
      stale,
    );
  }
  return null;
}