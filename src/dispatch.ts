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
// The renderer uses the distinction to decide whether to append the dim
// " · Xm ago" annotation (stale only) or to render a hard-fail placeholder
// (fail only). Fresh renders are unchanged.

import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import { formatBalanceLine, formatLine, RED, RESET, resolveDisplayMode } from "./render.ts";
import type { Provider } from "./types.ts";

export type FetchResult<T> =
  | { kind: "fresh"; data: T }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// Render the MiniMax two-window line from a Remains payload. `staleMs` is
// passed through to formatLine so the trailing " · Xm ago" annotation can
// be appended when applicable.
export function renderPlanLine(
  data: Remains,
  mode: ReturnType<typeof resolveDisplayMode>,
  staleMs?: number
): string | null {
  if (data.fiveHour && data.weekly) {
    return formatLine(data.fiveHour, data.weekly, mode, Date.now(), staleMs);
  }
  // If only one window is present, render what's available rather than nothing.
  const zero = { pct: 0 } as const;
  if (data.fiveHour) return formatLine(data.fiveHour, zero, mode, Date.now(), staleMs);
  if (data.weekly) return formatLine(zero, data.weekly, mode, Date.now(), staleMs);
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
    return renderPlanLine(result.data as Remains, mode, result.kind === "stale" ? result.ageMs : undefined);
  }
  if (provider === "deepseek") {
    return formatBalanceLine(result.data as Balance, result.kind === "stale" ? result.ageMs : undefined);
  }
  return null;
}