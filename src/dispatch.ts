// Provider dispatch: maps a (provider, fetch-result) pair to a statusline
// line. Extracted from index.ts so it can be exercised by tests without
// touching process.stdin / process.env (and without importing index.ts,
// which has top-level `await main()` side effects).
//
// Three outcomes the provider data layer can report:
//   fresh — we successfully obtained the data (from network or from a
//           within-TTL cache hit); `ageMs` is the time since the entry
//           was cached. The renderer's m_age module and forced-visibility
//           append both gate on `stale === true`, so fresh ticks render
//           no age suffix regardless of ageMs.
//   stale — fetch failed but a cached value exists; `ageMs` is how long
//           it's been since the last successful fetch (from cache.Entry.at).
//           `stale=true` triggers the broken-chain suffix (e.g. "⛓️‍💥 5m ago")
//           via either the m_age module or the forced-visibility append.
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// v0.2.21: switched from provider-name literals ("minimax" /
// "deepseek") to TYPE-based dispatch. buildProviderLine now reads
// the provider's `TYPE` field from the providers config block and
// routes accordingly. Adding a new TOKEN_PLAN or BALANCE provider
// is a config-only change.

import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import {
  formatBalanceLine,
  formatLine,
  RED,
  renderProviderLine,
  RESET,
  resolveDisplayMode,
} from "./render.ts";
import { failLabelForProvider, getProviderEntry } from "./providers.ts";
import type { Provider, TokenSnapshot } from "./types.ts";

export type FetchResult<T> =
  | { kind: "fresh"; data: T; ageMs: number }
  | { kind: "stale"; data: T; ageMs: number }
  | { kind: "fail" };

// Render the MiniMax-style two-window line from a Remains payload.
// The `stale` flag drives the broken-chain suffix visibility — fresh
// ticks render no age suffix regardless of ageMs. When stale=true,
// the suffix shows the broken emoji + age (e.g. "⛓️‍💥 5m ago").
//
// v0.2.21: kept the named helper (rather than inlining) because
// dispatch.ts:buildProviderLine and the lower-level tests still call
// it. The body delegates to the renderer's lineTemplate path, which
// is now driven by templateKeyForProvider rather than a provider-name
// literal.
//
// v0.4.0+ — `tokens` is the live stdin snapshot, threaded into the
// renderer so token-lineTemplate modules (m_tokenIn / m_tokenOut /
// m_ctx / m_cacheRead / m_cacheHitRate / m_tokenInSpeed /
// m_tokenOutSpeed / m_token5h / m_token7d) can render without
// re-parsing stdin. m_token5h/m_token7d additionally read
// state/token-samples/*.jsonl (handled inside render.ts).
export function renderPlanLine(
  data: Remains,
  mode: ReturnType<typeof resolveDisplayMode>,
  ageMs?: number,
  stale: boolean = false,
  tokens?: TokenSnapshot | null,
): string | null {
  if (data.fiveHour && data.weekly) {
    return formatLine(data.fiveHour, data.weekly, mode, Date.now(), ageMs, stale, tokens);
  }
  // If only one window is present, render what's available rather than nothing.
  const zero = { pct: 0 } as const;
  if (data.fiveHour) return formatLine(data.fiveHour, zero, mode, Date.now(), ageMs, stale, tokens);
  if (data.weekly) return formatLine(zero, data.weekly, mode, Date.now(), ageMs, stale, tokens);
  return null;
}

// Maps a (provider, FetchResult) pair to the final statusline line.
// v0.2.21: dispatch is driven by `entry.TYPE` from the providers
// config, not by provider-name literals. The fail-line prefix is
// read via `failLabelForProvider(provider)` so a user who overrides
// `modeLabels.used` / `modeLabels.balance` sees their custom label
// on the fail branch too.
//
// v0.4.0+ — also threads `tokens` (live stdin snapshot) through so
// token modules get their data. Fail paths render the colored "not
// available!" string WITHOUT token data — a user whose provider is
// unreachable shouldn't see token counts (would be confusing) but
// CAN opt to include them via a m_token* module that reads the live
// snapshot; we honor that by still passing tokens on fail.
export function buildProviderLine(
  provider: Provider,
  result: FetchResult<unknown>,
  tokens?: TokenSnapshot | null,
): string | null {
  const entry = getProviderEntry(provider);
  if (!entry) return null;
  if (result.kind === "fail") {
    // No cached data + fetch failed. Render a colored "not available!"
    // so the user sees the plugin is alive but the provider is
    // unreachable. Color matches the existing "is_available: false"
    // branch in formatBalanceLine (RED) so the two unavailable states
    // look the same on screen.
    //
    // v0.2.21: `failLabelForProvider` returns the modeLabel verbatim
    // (no trailing space — m_label module relies on s_0 separators in
    // the lineTemplate). The fail-line path doesn't go through the
    // template, so we re-attach the space here to preserve the
    // v0.2.20 output ("Usage: not available!" / "Balance: not available!").
    //
    // v0.4.0+: still pass tokens through so a user's lineTemplate can
    // include m_tokenIn/m_tokenOut alongside the fail-line — they
    // render their own module output, independent of provider state.
    if (tokens) {
      // Render the fail label as a minimal template (just the label
      // module) so the m_token* modules can still emit alongside.
      // Without this, fail paths would skip the template entirely
      // and the user's opt-in token modules would never render.
      // We use the lineTemplate-style render so separators and
      // module skipping rules match the success path exactly.
      return renderProviderLine(provider, {
        mode: resolveDisplayMode(),
        nowMs: Date.now(),
        ageMs: null,
        stale: true,
        version: importConfigVersion(),
        tokens,
      });
    }
    return `${failLabelForProvider(provider)} ${RED}not available!${RESET}`;
  }
  if (entry.TYPE === "TOKEN_PLAN") {
    // Display mode lives in configStore — the old TOKENPLAN_DISPLAY
    // env var is gone (see README "Configuration").
    const mode = resolveDisplayMode();
    // ageMs is carried on BOTH the fresh and stale variants:
    //   fresh.ageMs : 0 for a just-fetched tick; the cache age for a
    //                 within-TTL cache hit. Renderer suppresses the
    //                 suffix on fresh ticks (stale=false gate).
    //   stale.ageMs : how long since the last successful fetch.
    //                 Renderer appends "⛓️‍💥 Xm ago" (or "0s ago" if the
    //                 fetch just failed).
    return renderPlanLine(
      result.data as Remains,
      mode,
      result.ageMs,
      result.kind === "stale",
      tokens,
    );
  }
  if (entry.TYPE === "BALANCE") {
    // BALANCE providers have no window concept; same ageMs contract
    // as the TOKEN_PLAN path. Fresh ticks render no suffix; stale
    // ticks render the broken-chain "X ago" annotation.
    return formatBalanceLine(
      result.data as Balance,
      result.ageMs,
      result.kind === "stale",
      tokens,
    );
  }
  return null;
}

// Tiny adapter so dispatch.ts can ask the renderer for the plugin
// version without circular-importing config.ts. Lives here because
// dispatch.ts is the only caller on the fail-with-tokens path.
import { configStore } from "./config.ts";
function importConfigVersion(): string {
  return configStore.get().version;
}