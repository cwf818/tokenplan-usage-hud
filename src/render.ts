// Pure rendering helpers: split-bar (left colorless / right colored),
// 5-band thresholds, ANSI coloring, and line assembly.
//
// All tunable values (colors, thresholds, bar geometry, currency
// prefixes, display-mode labels, stale annotation formatting) come
// from the singleton in ./config.ts. The defaults in config.ts match
// today's hardcoded values exactly.
//
// v0.2.17: the line layout is now driven by a `lineTemplate` config
// field — an ordered list of display-module tokens (m_modeLabel,
// m_window5h, m_countdown5h, m_window7d, m_countdown7d, m_balance,
// m_age, m_version) and separator references (s_0, s_1, …).
// `formatLine` and `formatBalanceLine` are preserved as compatibility
// shims that expand the default templates; new code should call
// `renderProviderLine` directly.

import { configStore } from "./config.ts";
import { templateKeyForProvider } from "./providers.ts";
import type { TokenSnapshot } from "./types.ts";
import {
  buildRainbow,
  buildHue,
  parseFreq,
  pickQuote,
  quoteIndex,
  type QuoteFreq,
} from "./quotes.ts";
import { readSamples } from "./token-store.ts";
import * as cacheStore from "./cache.ts";

export type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp string when the window resets, if known.
  resetAt?: string | null;
  // ISO timestamp string for when the current window STARTED. Paired with
  // resetAt so we can compute the window's total duration and pick a
  // fill-state-appropriate reset arrow (⏳ when plenty of time remains,
  // ⌛ when the window is mostly consumed). Optional — DeepSeek has no
  // such concept, so missing fields fall back to the legacy single-arrow.
  resetStartAt?: string | null;
  // Window length in milliseconds (resetAt - resetStartAt). Optional;
  // required for the split-arrow logic, falls back to a single arrow when
  // missing. Kept as a separate field so callers don't have to re-parse the
  // ISO strings inside hot render paths.
  resetDurationMs?: number | null;
};

export type DisplayMode = "remaining" | "used";

// Shorthand for the active config snapshot. Reading configStore.get()
// on every call would be wasteful for hot paths (every formatLine call
// does many color/band lookups) — the helpers below read it lazily.
function cfg() {
  return configStore.get();
}

// Exported so sibling modules (src/dispatch.ts, src/composition.ts) can
// compose colored output without duplicating these literal strings.
export const RESET = "\x1b[0m";

// 256-color SGR sequences are read from configStore so a user can
// override any band via config.json. We re-export them under the same
// names so existing imports (RED, RESET) keep working.
export const BRIGHT_GREEN = configStore.get().colors.brightGreen;
export const DARK_GREEN = configStore.get().colors.darkGreen;
export const YELLOW = configStore.get().colors.yellow;
export const ORANGE = configStore.get().colors.orange;
export const RED = configStore.get().colors.red;
// Used for the stale-on-error annotation (" · 5m ago"). ANSI bright black
// (\x1b[90m) reads as "dim gray" on both light and dark terminals.
export const STALE_COLOR = configStore.get().colors.stale;

// 5-band thresholds applied to the **displayed** value (so remaining/used
// modes share the same numeric thresholds — only the meaning flips).
// In "remaining" mode the bands run high → low: bright green / dark green /
// yellow / orange / red, because more remaining = healthier. In "used" mode
// the bands run low → high: bright green / dark green / yellow / orange /
// red, because less used = healthier. We achieve this by indexing into the
// SAME 5-color palette from opposite ends.
function colorThresholds(): readonly number[] {
  return cfg().thresholds.minimaxPercent;
}

// 5-color palette indexed by band (0..4). In "remaining" mode, band 0
// (lowest remaining) gets RED and band 4 (most remaining) gets BRIGHT_GREEN.
// In "used" mode the mapping is reversed.
function paletteByUsed(): readonly string[] {
  const c = cfg().colors;
  return [c.brightGreen, c.darkGreen, c.yellow, c.orange, c.red];
}

// In "remaining" mode we want the LOW band → red, so this is the
// REVERSE of paletteByUsed().
function paletteByRemaining(): readonly string[] {
  const c = cfg().colors;
  return [c.red, c.orange, c.yellow, c.darkGreen, c.brightGreen];
}

function bandIndex(value: number, thresholds: readonly number[]): number {
  // thresholds[i] is the upper bound for band i (exclusive on the low end).
  // 5 bands total: [0, t0), [t0, t1), [t1, t2), [t2, t3), [t3, 100].
  // Values exactly AT a threshold belong to the band above it (the less
  // dangerous band) — this matches the natural reading of "0/20/40/60/80"
  // where 20 itself marks the transition INTO dark green, not the end of
  // bright green.
  const v = Math.max(0, Math.min(100, value));
  for (let i = 0; i < thresholds.length; i++) {
    if (v < thresholds[i]) return i;
  }
  return thresholds.length; // top band
}

export function colorFor(displayedPct: number, mode: DisplayMode): string {
  const idx = bandIndex(displayedPct, colorThresholds());
  if (mode === "remaining") return paletteByRemaining()[idx];
  return paletteByUsed()[idx];
}

// Split-bar with a fixed positional layout:
//   [<USED cells>][<REMAINING cells>]
// USED cells use the configured "filled" glyph (default ▓), REMAINING
// cells use the configured "empty" glyph (default ░). The side that
// gets COLORED depends on the mode:
//   used mode      → color the LEFT (used cells)     — colored by used%
//   remaining mode → color the RIGHT (remaining cells) — colored by remaining%
// This is the unified rule "left = used, right = remaining; the metric the
// user is thinking about as 'danger' is the one that gets the color".
export type SplitBar = {
  leftChunk: string; // LEFT half of bar — colored if mode==='used', plain otherwise
  rightChunk: string; // RIGHT half of bar — colored if mode==='remaining', plain otherwise
  color: string;
};

export function splitBar(
  usedPct: number,
  mode: DisplayMode,
  width = configStore.get().bar.width,
): SplitBar {
  const used = Math.max(0, Math.min(100, usedPct));
  const remaining = 100 - used;

  // Color follows the DISPLAYED value (the number shown next to the bar).
  const displayed = mode === "remaining" ? remaining : used;
  const color = colorFor(displayed, mode);

  const coloredSize = Math.round((displayed / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);

  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;

  // Layout: left = used cells, right = remaining cells. The side that
  // gets color wraps is the "metric of concern" (used in "used" mode,
  // remaining in "remaining" mode). Glyphs flip in remaining mode so
  // the bar reads left-to-right as "what's spent ▓▓▓░░░ what's left":
  //   used      : left=used▓ (colored),  right=remaining░ (plain)
  //   remaining : left=used░ (plain),    right=remaining▓ (colored)
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    return {
      leftChunk: coloredSize > 0 ? `${color}${left}${RESET}` : "",
      rightChunk: right,
      color,
    };
  }
  // mode === "remaining"
  const left = empty.repeat(plainSize);
  const right = filled.repeat(coloredSize);
  return {
    leftChunk: left,
    rightChunk: coloredSize > 0 ? `${color}${right}${RESET}` : "",
    color,
  };
}

// Backwards-compatible simple "filled on left" bar — exported for tests but
// not used by formatOne anymore.
export function pctBar(usedPctValue: number, width = configStore.get().bar.width): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, usedPctValue));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  return {
    filled: cfg().bar.filled.repeat(filledCount),
    empty: cfg().bar.empty.repeat(emptyCount),
  };
}

// v0.2.17: factor of formatOne() — returns the bar + colored-percent
// portion only (no reset countdown, no window label). The reset
// annotation is rendered by the m_countdown5h / m_countdown7d modules
// independently so the lineTemplate can place them as separate tokens.
// `formatOne` is kept as the canonical helper that joins these two
// parts (plus a leading space) for callers that want the old combined
// form (and for tests that assert on it).
function formatOneChunk(
  w: Window,
  mode: DisplayMode,
  width = cfg().bar.width,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const bar = splitBar(usedPct, mode, width);
  return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}`;
}

// v0.3.3+ variant: same layout, but the colored side of the bar AND
// the percentage are wrapped in `override` instead of the band-based
// color. The plain (uncolored) side of the bar stays plain. Used by
// the inline-args path when the user supplied a `:color:<c>` override
// on m_window5h / m_window7d — the user's color REPLACES the natural
// band-based color (no "ignore on conflict" carve-out; the override
// always wins). Returns the same string shape as `formatOneChunk`.
function formatOneChunkColored(
  w: Window,
  mode: DisplayMode,
  override: string,
  width = cfg().bar.width,
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;
  const filled = cfg().bar.filled;
  const empty = cfg().bar.empty;
  const coloredSize = Math.round((displayedPct / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);
  if (mode === "used") {
    const left = filled.repeat(coloredSize);
    const right = empty.repeat(plainSize);
    const leftChunk = coloredSize > 0 ? `${override}${left}${RESET}` : "";
    return `${leftChunk}${right} ${override}${displayedPct}%${RESET}`;
  }
  // mode === "remaining"
  const left = empty.repeat(plainSize);
  const right = filled.repeat(coloredSize);
  const rightChunk = coloredSize > 0 ? `${override}${right}${RESET}` : "";
  return `${left}${rightChunk} ${override}${displayedPct}%${RESET}`;
}

// Reset-suffix portion of a window. Returns the parens-wrapped
// `(countdown<arrow> label)` when resetAt is present, or just the
// bare `label` (e.g. "5h") when resetAt is missing. The leading
// space is intentionally NOT included here — spacing between modules
// is controlled by the surrounding s_N separator tokens in the
// lineTemplate. Returns "" when windowLabel is empty (used by
// tests that build fake windows without a label).
function formatOneResetSuffix(
  windowLabel: string,
  w: Window,
  nowMs: number = Date.now(),
): string {
  if (!windowLabel) return "";
  // Two pieces: the countdown (e.g. "2h3m") and the arrow (e.g. "🕛").
  // Both are derived from the same Window + nowMs; the arrow is the
  // single thing we always have even when the countdown is empty
  // (e.g. "<1m" or just the arrow alone if resetAt is present but
  // remaining is 0). Template:
  //   resetAt present → "(<countdown><arrow> <windowLabel>)"
  //   resetAt missing  → "<windowLabel>" (DeepSeek / legacy — no
  //   reset info at all, don't fake it with a default arrow)
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  return w.resetAt
    ? `(${resetSuffix}${arrow} ${windowLabel})`
    : windowLabel;
}

// Compact "remaining time until reset" formatter. Returns the countdown
// portion of the reset annotation (no arrow, no parens) — e.g. "2h3m",
// "<1m" for sub-minute, or "0m" for past-due. The caller (`formatOne`)
// appends the window label and the fill-state arrow glyph picked by
// `pickResetArrow`.
//
// The actual formatting rules live in `formatRemainingMs` (shared with
// the stale-age suffix). See that function's doc comment for the full
// `minUnit` × `maxUnitCount` matrix.
export function formatResetSuffix(
  resetAt: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (!resetAt) return "";
  const t = Date.parse(resetAt);
  if (!Number.isFinite(t)) return "";
  const remainingMs = t - nowMs;

  return formatRemainingMs(remainingMs);
}

// Pure helper: format a non-negative number of milliseconds as a
// `1d2h3m4s` style countdown, respecting `timeFormat.minUnit` (the
// smallest unit that may appear) and `timeFormat.maxUnitCount` (how
// many non-zero units to show). Top-level config so the formatting
// is consistent across reset countdowns and stale-age suffixes.
//
// Unified algorithm:
//   1. Extract [days, hours, minutes, seconds] from remainingMs.
//   2. Drop units below minUnit (so "m" drops s, "h" drops m+s).
//   3. Drop leading zero units from the trimmed list.
//   4. If the trimmed list is empty → "<1<minUnit>" (positive) or
//      "0<minUnit>" (past-due).
//   5. Slice the remaining list to maxUnitCount, join as `1d2h3m4s`.
//
// Examples (maxUnitCount=2):
//   remaining=2h3m45s minUnit="m" → "2h3m"   (s dropped by minUnit)
//   remaining=2h3m45s minUnit="s" → "2h3m"   (slice cuts s — s > maxUnitCount budget)
//   remaining=2h3m45s minUnit="s", maxUnitCount=3 → "2h3m45s"
//   remaining=2h3m0s  minUnit="s", maxUnitCount=3 → "2h3m0s" (internal zeros kept)
//   remaining=50s      minUnit="m" → "<1m"
//   remaining=50s      minUnit="s" → "50s"
//   remaining=50m      minUnit="h" → "<1h"
//   remaining=2h0m     minUnit="m" → "2h0m"   (internal zero kept)
//   remaining=1d2h3m4s minUnit="m", maxUnitCount=2 → "1d2h"
//   remaining=0        → "0m" / "0s" / "0h" depending on minUnit
export function formatRemainingMs(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";

  const minUnit = cfg().timeFormat.minUnit;
  const maxUnitCount = Math.max(
    1,
    Math.min(4, Math.floor(cfg().timeFormat.maxUnitCount)),
  );

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Past-due: explicit "0<minUnit>" so the user sees a clear "this
  // window has reset" signal — distinct from "<1<minUnit>" which means
  // "less than 1 unit left" (about to reset).
  if (remainingMs <= 0) return `0${minUnit}`;

  // Build the full unit list, then trim units below minUnit granularity.
  // Order matters: largest → smallest, so "leading zero drop" naturally
  // strips the high-order zeros before the units we care about.
  const allUnits: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [minutes, "m"],
    [seconds, "s"],
  ];
  // Pre-compute unit→rank once so we can filter and compare without
  // re-allocating per item (TS also dislikes inline-object indexing).
  // Larger rank = smaller unit (s > m > h > d), so `rank[u] <= minUnitRank`
  // keeps units AT or ABOVE minUnit in size (i.e. drops units below it).
  const rank: Record<string, number> = { d: 0, h: 1, m: 2, s: 3 };
  const minUnitRank = rank[minUnit];
  const trimmed = allUnits.filter(([, u]) => rank[u] <= minUnitRank);

  // Drop leading zero units (so "0d0h5m" → "5m", not "0d0h5m").
  let leadingZeroCount = 0;
  while (
    leadingZeroCount < trimmed.length &&
    trimmed[leadingZeroCount][0] === 0
  ) {
    leadingZeroCount++;
  }
  const nonzero = trimmed.slice(leadingZeroCount);

  // All extracted units zero (or all below minUnit) → "<1<minUnit>"
  // floor. Wins over maxUnitCount — "<1<minUnit>" is the truth, not
  // a lossy empty string.
  if (nonzero.length === 0) return `<1${minUnit}`;

  // Take the first maxUnitCount (keeps internal/trailing zeros —
  // "2h0m" stays "2h0m").
  return nonzero.slice(0, maxUnitCount).map(([v, u]) => `${v}${u}`).join("");
}

// Pick a reset-countdown glyph from the configured array by how full the
// window still is. Index = floor(remainingMs / resetDurationMs * length),
// so the array reads left-to-right as "fresh → about to reset":
//   index 0        : right after the window reset (ratio = 0)
//   last index     : just before the next reset    (ratio ≈ 1)
// `min(…, length-1)` clamps ratio=1.0 to the last entry instead of
// running off the end. Falls back to index 0 when the interval data is
// missing (DeepSeek, legacy shape, clock skew) — same "neutral" reading
// for any unknown state, so users don't see a glyph swap just because
// we couldn't parse the new fields.
function pickResetArrow(
  nowMs: number,
  resetStartAt: string | null | undefined,
  resetDurationMs: number | null | undefined,
): string {
  const arrows = cfg().countdown.resetArrows;
  const first = arrows[0] ?? "";
  if (resetStartAt == null || resetDurationMs == null) return first;
  const startMs = Date.parse(resetStartAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(resetDurationMs) || resetDurationMs <= 0) {
    return first;
  }
  const elapsed = nowMs - startMs;
  // Clamp ratio to [0, 1] — negative remaining means we're past the
  // window end (formatResetSuffix already filters those, but defense in
  // depth). Slightly-above-1 (clock skew) clamps to the last index.
  const ratio = Math.max(0, Math.min(1, (resetDurationMs - elapsed) / resetDurationMs));
  const idx = Math.min(arrows.length - 1, Math.floor(ratio * arrows.length));
  return arrows[idx];
}

// Compact "age of cached value" formatter for the trailing annotation.
// The `healthy` flag toggles the emoji: 🔗 for fresh (data is current,
// within-TTL cache hit) or ⛓️‍💥 for stale (fetch failed, showing
// cached data). SGR-wrapped in STALE_COLOR and RESET-terminated.
// Returns "" only when ageMs is non-finite (NaN / ±Infinity).
//
// The X time uses the SAME template as the reset countdown
// (formatRemainingMs) with the same `timeFormat.minUnit` and
// `timeFormat.maxUnitCount` knobs:
//   ageMs = 0          → "0<minUnit> ago"   (e.g. "0m ago", "0s ago")
//   sub-minute (0..59s) → "<1<minUnit> ago" or "${seconds}s ago"
//   minUnit="m" → "<1m ago"  (the "<" floor reads "less than 1 minute")
//   minUnit="s" → "${seconds}s ago" (no spurious round-up — second
//                                  granularity is fine-grained enough
//                                  that we don't need to lie about it)
//
// Visibility is gated by the caller: the m_age module emits whenever
// `ageMs != null` (the user explicitly opted in by listing it in the
// lineTemplate); renderProviderLine's forced-visibility block emits
// only when `stale === true` (the user did NOT list m_age but the
// renderer still wants a broken-chain indicator on real outages).
export function formatStaleSuffix(
  ageMs: number,
  healthy: boolean = false,
  override?: string,
): string {
  if (!Number.isFinite(ageMs)) return "";
  const emoji = healthy ? cfg().stale.ageEmoji.healthy : cfg().stale.ageEmoji.broken;
  const label = `${formatRemainingMs(ageMs)} ago`;
  // v0.3.3+: `override` replaces the default STALE_COLOR (\x1b[90m)
  // when supplied (used by the inline-args m_age path).
  const color = override ?? STALE_COLOR;
  return `${color}${emoji} ${label}${RESET}`;
}

// Read the configured display mode. The earlier TOKENPLAN_DISPLAY env
// var is gone (per the v0.2.0 config-file migration); anyone using it
// must move to config.json's `display` field.
export function resolveDisplayMode(): DisplayMode {
  return cfg().display;
}

export function formatLine(
  fiveHour: Window,
  weekly: Window,
  mode: DisplayMode = resolveDisplayMode(),
  nowMs: number = Date.now(),
  ageMs?: number,
  stale: boolean = false,
  tokens: TokenSnapshot | null = null,
): string {
  // v0.2.17: delegate to the lineTemplate renderer. The default plan
  // template reproduces the v0.2.16 byte-for-byte output.
  return renderProviderLine("minimax", {
    mode,
    nowMs,
    fiveHour,
    weekly,
    ageMs: ageMs ?? null,
    stale,
    version: cfg().version,
    tokens,
  });
}

// ----- DeepSeek balance line -------------------------------------------------
//
// Distinct from the MiniMax percentage thresholds (0/20/40/60/80): a balance
// is an ABSOLUTE amount, not a percentage, so the bands live at the
// configured thresholds (default 5/10/20/50 — red / orange / yellow / dark
// green / bright green). Lower balance = more urgent, so the lowest band
// (red) corresponds to the LOWEST value — same intuitive direction as the
// "remaining" mode of the MiniMax render.

function balanceThresholds(): readonly number[] {
  return cfg().thresholds.deepseekBalance;
}

// Lowest value → RED, then orange → yellow → dark green → bright green.
function balancePalette(): readonly string[] {
  const c = cfg().colors;
  return [c.red, c.orange, c.yellow, c.darkGreen, c.brightGreen];
}

function balanceBandIndex(value: number): number {
  const t = balanceThresholds();
  for (let i = 0; i < t.length; i++) {
    if (value < t[i]) return i;
  }
  return t.length; // top band
}

export function colorForBalance(value: number): string {
  const v = Math.max(0, value);
  return balancePalette()[balanceBandIndex(v)];
}

// Format a single numeric value for display: integers as "100", floats as
// "110.00". Trim trailing zeros for cases like "110.10" → "110.1".
function formatBalanceValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  // toFixed(2) then strip trailing zeros and a dangling dot.
  return v.toFixed(2).replace(/\.?0+$/, "");
}

// Per-currency display prefix. The DeepSeek API may return any string in
// `currency`; we recognize the configured ones and fall back to the raw
// currency code for anything else (e.g. EUR → "EUR10.50"). Unknown
// currencies are still rendered (the user can see the code) rather than
// blanked, so a new provider currency never silently disappears.
function prefixForCurrency(currency: string): string {
  const upper = currency.toUpperCase();
  const mapped = cfg().currency.prefixes[upper];
  if (mapped !== undefined) return mapped;
  // Default: show the currency code itself, uppercased. If even the code
  // is empty, fall back to the configured fallback prefix.
  return upper || cfg().currency.fallback;
}

function formatBalanceChunk(currency: string, v: number): string {
  return `${prefixForCurrency(currency)}${formatBalanceValue(v)}`;
}

export type BalanceLike = {
  isAvailable: boolean;
  entries: ReadonlyArray<{ currency: string; totalBalance: number }>;
  minValue: number | null;
};

// v0.2.17: refactor of formatBalanceLine so the m_balance module can
// produce a complete colored chunk (prefix + " · "-joined entries
// wrapped in a single SGR block). Returns "" when there's nothing to
// render so the m_balance module can return null and the template
// renderer skips the surrounding s_0 separators cleanly.
//
// v0.3.3+ `override` parameter: when supplied, replaces the band-based
// `colorForBalance` choice (used by the inline-args m_balance path).
function formatBalanceEntriesColored(b: BalanceLike, override?: string): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return "";
  }
  const chunks = b.entries.map((e) => formatBalanceChunk(e.currency, e.totalBalance));
  // Color follows the LOWEST entry — most urgent currency drives the hue.
  const color = override ?? colorForBalance(b.minValue);
  return `${color}${chunks.join(" · ")}${RESET}`;
}

export function formatBalanceLine(b: BalanceLike, ageMs?: number, stale: boolean = false, tokens: TokenSnapshot | null = null): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    // "not available!" is rendered for BOTH the original "API said no" branch
    // (is_available: false) and the "fetch failed and we have no cache" branch
    // upstream. Neither carries an age to report, so the stale suffix is
    // intentionally NOT appended here. v0.2.17: this branch is NOT routed
    // through the lineTemplate (out of scope for v0.2.17) — it's a hardcoded
    // sentinel that always wins.
    return `Balance: ${RED}not available!${RESET}`;
  }
  // v0.2.17: delegate to the lineTemplate renderer. The default balance
  // template reproduces the v0.2.16 byte-for-byte output.
  return renderProviderLine("deepseek", {
    mode: resolveDisplayMode(),
    nowMs: Date.now(),
    balance: b,
    ageMs: ageMs ?? null,
    stale,
    version: cfg().version,
    tokens,
  });
}

// ----- lineTemplate / module renderer (v0.2.17) -------------------------
//
// A lineTemplate is an ordered list of tokens. Two token kinds:
//   m_<name>  — a display module (registered in MODULES below)
//   s_<n>     — a separator reference, looked up in cfg().separators[n]
//
// The renderer walks the template left-to-right, concatenating each
// module's output. Modules return null to signal "hidden in this
// context" — a null return SKIPS the surrounding separators too, so a
// hidden window doesn't leave orphan spaces or "·" in the output. This
// is what makes "drop the 7d window by removing m_window7d from the
// template" a clean operation rather than producing
// "Usage: <5h> ·  " with a trailing orphan separator.
//
// Unknown module names (typos) expand to "" and emit ONE stderr
// warning per render — capped at once-per-render to avoid log spam
// since the renderer runs on every statusline tick.
type RenderContext = {
  mode: DisplayMode;
  nowMs: number;
  fiveHour: Window | null;
  weekly: Window | null;
  balance: BalanceLike | null;
  ageMs: number | null;
  stale: boolean;
  version: string;
  // v0.4.0+ — live stdin snapshot for the m_token* modules. Always
  // present on the main flow (index.ts builds one before invoking
  // renderProviderLine); tests inject a fake via __resetForTest.
  tokens: TokenSnapshot | null;
  // v0.4.0+ — synthetic Window for the m_windowContext module.
  // Synthesized from tokens.contextWindow.usedPct; only `pct` is
  // read by formatOneChunk. Null when stdin lacks used_percentage.
  contextWindow: Window | null;
};

type Module = (ctx: RenderContext) => string | null;

// v0.4.0+ — per-session "previous tick" cache, used by the
// m_tokenInSpeed / m_tokenOutSpeed renderers to compute real
// per-API-call throughput instead of the session-cumulative
// average. The statusline fires a fresh child process on every
// tick, so this MUST persist across processes — it lives in the
// shared cacheStore (which already disk-shadows to
// ~/.claude/plugins/tokenplan-usage-hud/state/cache.json).
//
// Stored shape (one entry per sessionId):
//   { apiMs, in, out, at }   — snapshot of the previous tick's
//                              cost.total_api_duration_ms and
//                              current_usage.{input,output}.
//
// TTL: very long (1 hour). The cache only needs to survive the
// gap between two statusline ticks (typically < 5s); a longer TTL
// just protects against pathological pause/resume cases where the
// user closes the terminal and reopens it. Cache is automatically
// invalidated by the sessionId prefix in the key — switching
// sessions means the new sessionId misses the lookup, the new
// tick writes its baseline, and the next tick computes against it.
//
// Exported for tests (so unit tests can pre-seed the cache).
// v0.4.0+: cacheRead field added so the per-session running total
// m_totalTokenWithCacheIn can derive its delta from the same
// per-tick baseline that m_tokenInSpeed / m_tokenInAvg use. The
// field is populated automatically by every MODULES /
// INLINE_RENDERERS caller — call sites that construct literals
// just supply 0 for tests where cache is irrelevant.
export type PrevTickSnapshot = {
  apiMs: number;
  in: number;
  out: number;
  cacheRead: number;
};

// Public: looks up the previous tick for a given session. Returns
// null on miss (no prior tick, or session changed, or cache
// expired). The caller is responsible for the post-call
// `setPrevTick(sessionId, snapshot)` to keep the cache fresh —
// this function does NOT auto-write.
export function peekPrevTick(
  sessionId: string,
): PrevTickSnapshot | null {
  if (!sessionId) return null;
  // 1h TTL is well past any plausible inter-tick gap but well
  // before the user is likely to be back the next day. The
  // sessionId prefix already handles the "back tomorrow" case
  // (new sessionId → new key → miss → fresh baseline).
  return cacheStore.peek<PrevTickSnapshot>(`tickSpeed:${sessionId}`);
}

// Public: writes the current tick's snapshot for the next call to
// read. Fire-and-forget; the cache is non-critical (worst case on
// a cache write failure is "next tick drops the speed module",
// which is the same as a first tick).
export function setPrevTick(
  sessionId: string,
  snap: PrevTickSnapshot,
): void {
  if (!sessionId) return;
  cacheStore.set(`tickSpeed:${sessionId}`, snap);
}

// ----- v0.4.0+ — last-rendered speed cache -----
//
// m_tokenInSpeed / m_tokenOutSpeed store the LAST active-tick
// tps per session, so an idle tick (deltaApi == 0) that would
// otherwise render "-- t/s" can fall back to the cached value.
// This stops the speed module from "blinking" through ticks
// when Claude Code's statusline fires faster than the user
// reads it (e.g. multi-second thinking bursts produce a flurry
// of statusline ticks; only one or two carry a real API call).
//
// Writes happen ONLY on active ticks (hasDelta === true). The
// "inactive" state in the cache only ever holds a measurement
// taken during a real API call. Idle ticks do NOT overwrite —
// the cached value is "the last thing I measured" until the
// next active tick replaces it.
//
// 1h TTL matches tickSpeed: — long enough to span a
// thinking burst, short enough to clear by tomorrow's session.
// Different key prefix (`tickSpeedDisplay:`) from
// `tickSpeed:<sessionId>` so the prev-tick baseline and the
// last-rendered display value don't collide.
export type LastSpeedSnapshot = {
  direction: "in" | "out";
  tps: number;
};
export function peekLastSpeed(
  sessionId: string,
  direction: "in" | "out",
): number | null {
  if (!sessionId) return null;
  const snap = cacheStore.peek<LastSpeedSnapshot>(
    `tickSpeedDisplay:${direction}:${sessionId}`,
  );
  return snap?.tps ?? null;
}
export function setLastSpeed(
  sessionId: string,
  direction: "in" | "out",
  tps: number,
): void {
  if (!sessionId) return;
  cacheStore.set(`tickSpeedDisplay:${direction}:${sessionId}`, {
    direction,
    tps,
  });
}
// Test-only: clear the last-speed entry for a session.
export function __resetLastSpeedForTest(
  sessionId: string,
  direction: "in" | "out",
): void {
  if (!sessionId) return;
  cacheStore.clear(`tickSpeedDisplay:${direction}:${sessionId}`);
}

// Test-only: clear the in-memory + disk cache entry for a
// session. Production code never calls this.
export function __resetPrevTickForTest(sessionId: string): void {
  if (!sessionId) return;
  cacheStore.clear(`tickSpeed:${sessionId}`);
}

// v0.4.0+ — per-session accumulator for the m_tokenInAvg /
// m_tokenOutAvg modules. Each tick where the delta math
// produces valid numbers (deltaApi > 0 and deltaIn / deltaOut >=
// 0 — guarding against regressions), the running totals grow.
// The render is sum_in / sum_api * 1000 (and same for out). The
// cache is separate from the prevTick snapshot above because
// the lifetime is different: prevTick is "what was the last
// tick's stdin state" (1-tick memory), avg is "running totals
// across the session's lifetime" (whole-session memory).
export type AvgSnapshot = {
  sumIn: number;
  sumOut: number;
  sumApi: number;
  // v0.4.0+: running total of delta(cache_read_input_tokens)
  // across valid-API-call ticks. Single source of truth for
  // m_totalTokenWithCacheIn (and the avg module pair's cache slot
  // doubles as the totals slot — we deliberately reuse this
  // rather than introduce a parallel tickTotal: cache key).
  sumCache: number;
};

export function peekAvg(sessionId: string): AvgSnapshot | null {
  if (!sessionId) return null;
  return cacheStore.peek<AvgSnapshot>(`tickAvg:${sessionId}`);
}

export function setAvg(sessionId: string, snap: AvgSnapshot): void {
  if (!sessionId) return;
  cacheStore.set(`tickAvg:${sessionId}`, snap);
}

export function __resetAvgForTest(sessionId: string): void {
  if (!sessionId) return;
  cacheStore.clear(`tickAvg:${sessionId}`);
}

// Per-render memo: keyed by the RenderContext object itself, so
// the memo lives exactly as long as the render. A WeakMap means
// no manual cleanup and no leak when a render finishes. Several
// per-API-call modules (m_tokenIn / m_tokenOut / m_tokenInSpeed
// / m_tokenOutSpeed / m_tokenInAvg / m_tokenOutAvg) may all be in
// a single lineTemplate, and WITHOUT this memo, the second
// module's computeAndCacheTickDelta would read the cache that
// the first module just wrote — and see delta = 0 (which renders
// "--"). The memo freezes the result for the lifetime of the
// render so each module sees the SAME delta and only the FIRST
// caller fires the cache write.
type TickDeltaResult = {
  hasDelta: boolean;
  deltaIn: number;
  deltaOut: number;
  deltaApi: number;
  // v0.4.0+: delta of current_usage.cache_read_input_tokens
  // across the last tick. Used by m_totalTokenWithCacheIn (not by
  // the avg modules, which only need in/out/api). Defaults to 0
  // when either side of the subtraction is null (stdin lacked the
  // field — see computeAndCacheTickDelta).
  deltaCacheRead: number;
  writeBack: PrevTickSnapshot | null;
};
const _tickDeltaMemo = new WeakMap<RenderContext, TickDeltaResult>();
// Memo for the setAvg accumulator write. Both computeTickAvg
// AND computeTickTotals need to fire setAvg (each family must
// work as the sole per-API-call module in a template). On a
// render that has both — e.g. m_totalTokenIn + m_tokenInAvg —
// they'd otherwise double-count the delta. Idempotent: first
// caller wins; subsequent callers no-op.
const _tickAvgWriteMemo = new WeakMap<RenderContext, true>();

// One source of truth for the per-API-call delta math. Lives at
// the top of the per-tick pipeline so every v0.4.0+ per-API-call
// module (m_tokenIn / m_tokenOut / m_tokenInSpeed / m_tokenOutSpeed
// / m_tokenInAvg / m_tokenOutAvg) sees the same numbers and the
// same cache state.
//
// Per-render memoization: the first call within a render peeks
// the prev tick, computes the deltas, and returns writeBack. The
// caller fires setPrevTick. Subsequent calls within the same
// render return the SAME result WITHOUT re-peeking and WITHOUT
// triggering another setPrevTick on the caller side (writeBack is
// present on the memo so a late caller may also fire setPrevTick
// safely — the write is idempotent).
//
// Behavior:
//   1. If snapshot data is missing (no sessionId / no
//      totalApiDurationMs / no current.input/output), return
//      hasDelta=false and writeBack=null. The caller renders
//      "--" and skips the cache write. No state changes.
//   2. Otherwise, peek the prevTick. ALWAYS write the current
//      snapshot back so the next tick has a baseline — even when
//      we couldn't compute a delta (first tick, session changed,
//      idle tick, regression). The write is fire-and-forget; the
//      cache failure mode is "next tick drops", same as today.
//   3. If prev exists and (deltaApi > 0 AND deltaIn >= 0 AND
//      deltaOut >= 0), compute the three deltas and return
//      hasDelta=true. The caller (per-module) decides how to
//      render the numbers — speed, raw delta-in/out, or as
//      accumulators.
//
// Why ALL-FOUR fields together (not just the one direction):
//   - m_tokenInAvg needs (deltaIn, deltaApi); m_tokenOutAvg
//     needs (deltaOut, deltaApi). Computing both directions in
//     one pass avoids two cache peeks + writes per tick.
//   - Every per-API-call module is gated by the SAME data
//     validity conditions. Centralizing the gate logic makes it
//     impossible for one module to render numbers while another
//     drops without an explicit check.
function computeAndCacheTickDelta(ctx: RenderContext): TickDeltaResult {
  const memo = _tickDeltaMemo.get(ctx);
  if (memo) return memo;
  const t = ctx.tokens;
  let result: TickDeltaResult;
  if (!t || !t.sessionId) {
    result = {
      hasDelta: false, deltaIn: 0, deltaOut: 0, deltaApi: 0,
      deltaCacheRead: 0, writeBack: null,
    };
    _tickDeltaMemo.set(ctx, result);
    return result;
  }
  const currentApi = t.cost.totalApiDurationMs;
  const currentIn = t.current.input;
  const currentOut = t.current.output;
  const currentCacheRead = t.current.cacheRead;
  if (currentApi == null || currentIn == null || currentOut == null) {
    result = {
      hasDelta: false, deltaIn: 0, deltaOut: 0, deltaApi: 0,
      deltaCacheRead: 0, writeBack: null,
    };
    _tickDeltaMemo.set(ctx, result);
    return result;
  }
  const prev = peekPrevTick(t.sessionId);
  // Always write the current snapshot so the next tick has a
  // baseline for the `deltaApi` math, even when we render "--" /
  // skip the cache accumulator update. The `in` / `out` /
  // `cacheRead` fields of writeBack are unused by the new
  // accumulation model (we read current.* directly — they're
  // per-turn deltas, not running totals) but the field is kept
  // for schema stability and a 0-stamped baseline is harmless.
  const writeBack: PrevTickSnapshot = {
    apiMs: currentApi,
    in: currentIn,
    out: currentOut,
    cacheRead: currentCacheRead ?? 0,
  };
  // v0.4.0+ (revised 2026-06-29): when no previous tick exists
  // (first tick of a session, or a cache miss after a session
  // change), we DO NOT bail to "no data". We assume the prior
  // baseline was at zero — i.e. `prev.apiMs = 0` — so the first
  // tick still contributes. This matches the per-turn-delta
  // contract: current_usage.* values are THIS turn's
  // contribution, and on the very first turn there is no
  // "previous" to compare against, so the safe assumption is
  // "we started from a clean slate". The first tick therefore
  // accumulates into m_totalToken* (no "0" sentinel) and
  // m_tokenIn / m_tokenOut / m_tokenInSpeed render real values
  // when total_api_duration_ms > 0.
  const prevApiMs = prev?.apiMs ?? 0;
  // current_usage.{input_tokens, output_tokens,
  // cache_read_input_tokens} are PER-TURN DELTAS — they report
  // THIS turn's contribution, not a running total. We do NOT
  // subtract prev; the value is already the per-turn delta. The
  // only subtraction is deltaApi, where prev.apiMs tells us
  // "did total_api_duration_ms change this tick?".
  //
  // Gating is deltaApi > 0 ONLY. In / out / cache_read don't all
  // have to move together — e.g. a thinking-only turn adds zero
  // output tokens but may still count as a real API call. We
  // accumulate whatever current.* reports, and a zero per-turn
  // delta on one field is meaningful (it just means "no tokens
  // of that kind this turn"), not a regression. Per-turn deltas
  // are contractually non-negative (an API call can't subtract
  // input tokens), so the previous regression guard is gone.
  const deltaApi = currentApi - prevApiMs;
  const deltaIn = currentIn;
  const deltaOut = currentOut;
  const deltaCacheRead = currentCacheRead ?? 0;
  const hasDelta = deltaApi > 0;
  result = {
    hasDelta, deltaIn, deltaOut, deltaApi, deltaCacheRead, writeBack,
  };
  _tickDeltaMemo.set(ctx, result);
  return result;
}

// Test-only: clear the per-render memo for a given ctx. The memo
// is normally GC'd with the ctx via the WeakMap key. Production
// code never calls this — tests use it when they reuse a ctx
// across two renderTemplate calls in one test (rare, since the
// main test pattern seeds cache and builds a fresh ctx each time).
export function __resetTickDeltaMemoForTest(ctx: RenderContext): void {
  _tickDeltaMemo.delete(ctx);
  _tickAvgWriteMemo.delete(ctx);
}

// Compute the per-API-call throughput for one of {in, out}. v0.4.0+
// — always returns a non-null value. The module occupies a stable
// slot in the user's lineTemplate; a missing-data render is
// "in:-- t/s", not a drop. This keeps the line layout stable across
// ticks — the user always sees the module where they put it, and
// learns to read "--" as "no data / nothing to report".
//
// math (when hasDelta):
//   tps = current_in_or_out / delta_api * 1000
//
// Missing-data conditions (render "in:-- t/s"):
//   - no current snapshot data
//   - delta_api <= 0 (no API call between ticks) AND no cached
//     value from a previous active tick to fall back to
//
// v0.4.0+ (revised 2026-06-29 + 2026-06-29): per-turn deltas
// don't need a direction-specific zero-rejection gate. IN and
// OUT don't have to move together — a thinking-only turn adds
// 0 input tokens but 0 output tokens too; a synthesized-message
// turn adds 0 input but real output. The truthful rate is
// 0.0 t/s, not "-- t/s". We render 0.0 directly so the user
// sees the real measurement and learns the difference between
// "0 t/s" (real zero) and "in:-- t/s" (no data).
//
// v0.4.0+ second revision: cache the last ACTIVE-tick tps per
// session. On an idle tick (no API call this turn), fall back
// to the cached tps so the speed module doesn't blink
// in:-- t/s between real measurements during fast statusline
// ticks. The cache is only written on active ticks (idle ticks
// preserve the previous measurement). Returns an `active` flag
// so the caller can pick color: active = scale band, inactive
// = STALE_COLOR (the user reads the gray as "this is a stale
// measurement from a previous API call, not a real one now").
function computeTickSpeed(
  ctx: RenderContext,
  direction: "in" | "out",
  color: string,
): {
  value: string;
  writeBack: PrevTickSnapshot | null;
  active: boolean;
  tps: number | null;
} {
  const r = computeAndCacheTickDelta(ctx);
  if (!r.hasDelta) {
    // Idle tick — fall back to the last active measurement if
    // we have one, otherwise render the -- t/s sentinel.
    const sid = ctx.tokens?.sessionId;
    if (sid) {
      const cached = peekLastSpeed(sid, direction);
      if (cached != null) {
        return {
          value: `${STALE_COLOR}${direction}:${formatSpeed(cached)}${RESET}`,
          writeBack: r.writeBack,
          active: false,
          tps: cached,
        };
      }
    }
    return {
      value: `${STALE_COLOR}${direction}:-- t/s${RESET}`,
      writeBack: r.writeBack,
      active: false,
      tps: null,
    };
  }
  const deltaTok = direction === "in" ? r.deltaIn : r.deltaOut;
  const tps = (deltaTok / r.deltaApi) * 1000;
  // Write the active measurement to the cache so subsequent
  // idle ticks can display it.
  const sid = ctx.tokens?.sessionId;
  if (sid) setLastSpeed(sid, direction, tps);
  return {
    value: `${color}${direction}:${formatSpeed(tps)}${RESET}`,
    writeBack: r.writeBack,
    active: true,
    tps,
  };
}

// Per-API-call raw token delta. v0.4.0+ — mirrors the speed
// module's gate: only render a numeric value when delta_api > 0
// and the token delta is non-negative. When the gate is not
// satisfied (no snapshot data, first tick, idle tick, regression)
// we render "0" — not "--". The user reads "0" as "tracking, but
// nothing new this tick", which is a better signal than the
// ambiguous "--" for a quantity-shaped field. (The speed modules
// handle the same situation differently: there, a zero-delta is
// replaced with "-- t/s" because a 0.0 t/s rate is semantically
// empty — the user has already chosen to prefer "--" there.)
//
// Uses formatCompactToken so single-call token counts read the
// same as the cumulative modules (e.g. "in:140", "in:12.3k").
function computeTickDelta(
  ctx: RenderContext,
  direction: "in" | "out",
): { value: string; writeBack: PrevTickSnapshot | null } {
  const r = computeAndCacheTickDelta(ctx);
  const n = direction === "in" ? r.deltaIn : r.deltaOut;
  return {
    value: r.hasDelta ? `${direction}:${formatCompactToken(n)}` : `${direction}:0`,
    writeBack: r.writeBack,
  };
}

// Per-session running average speed across all valid API
// calls. Combines the prevTick (per-API-call math) with the
// AvgSnapshot (running totals). The math across the session:
//   sum_in  / sum_api  * 1000  (and same for out)
// Only valid-API-call ticks contribute (deltaApi > 0 AND
// deltaIn / deltaOut >= 0); idle and regression ticks don't.
// Renders "--" when no valid tick has accumulated yet (sumApi
// is still 0 after this tick — i.e. nothing usable came in).
// Color defaults to STALE_COLOR; the inline :color: path
// overrides it.
//
// Side effects: fires BOTH the prevTick write (so the next
// tick's computeAndCacheTickDelta sees a fresh baseline) AND
// the avg accumulate write. This means computeTickAvg is
// self-sufficient — putting m_tokenInAvg alone in a template
// with no speed / raw-delta modules still works.
function computeTickAvg(
  ctx: RenderContext,
  direction: "in" | "out",
  color: string,
): { value: string; writeBack: PrevTickSnapshot | null } {
  const t = ctx.tokens;
  if (!t || !t.sessionId) {
    return { value: `${color}${direction}:--${RESET}`, writeBack: null };
  }
  const r = computeAndCacheTickDelta(ctx);
  if (r.hasDelta && !_tickAvgWriteMemo.get(ctx)) {
    _tickAvgWriteMemo.set(ctx, true);
    const prev = peekAvg(t.sessionId);
    const next: AvgSnapshot = {
      sumIn: (prev?.sumIn ?? 0) + r.deltaIn,
      sumOut: (prev?.sumOut ?? 0) + r.deltaOut,
      sumApi: (prev?.sumApi ?? 0) + r.deltaApi,
      // v0.4.0+: m_totalTokenWithCacheIn reads sumCache. The avg
      // module pair is the canonical accumulator — keeping the
      // sumCache update here means either module family alone in
      // a template still maintains the cache.
      sumCache: (prev?.sumCache ?? 0) + r.deltaCacheRead,
    };
    setAvg(t.sessionId, next);
  }
  const avg = peekAvg(t.sessionId);
  if (!avg || avg.sumApi <= 0) {
    return { value: `${color}${direction}:--${RESET}`, writeBack: r.writeBack };
  }
  const denom = direction === "in" ? avg.sumIn / avg.sumApi : avg.sumOut / avg.sumApi;
  const tps = denom * 1000;
  return { value: `${color}${direction}:${formatSpeed(tps)}${RESET}`, writeBack: r.writeBack };
}

// Per-session running totals: m_totalTokenIn / m_totalTokenOut /
// m_totalTokenWithCacheIn. Reads the same tickAvg:<sessionId>
// cache slot that computeTickAvg maintains — single source of
// truth, no parallel cache key. When ONLY a totals module is in
// the template (no avg / speed / delta modules), this helper
// MUST also fire the setAvg write itself, because computeTickAvg
// is the only place that does the read-modify-write on the
// accumulator. Both modules trigger on the same hasDelta gate,
// so the write is idempotent if both run.
//
// Render branches:
//   - tokens null or !sessionId     → "{prefix}:0" (mirrors
//                                      m_tokenIn / m_tokenOut
//                                      for the no-snapshot case;
//                                      the per-session cache is
//                                      unreachable without a
//                                      sessionId).
//   - kind === "cache" && current
//         .cacheRead == null        → "cache:--" (user-resolved
//                                      honest signal — cache
//                                      field wasn't carried by
//                                      stdin; not the same as
//                                      "no valid tick yet").
//   - otherwise                     →
//      "{prefix}:{formatCompactToken(sum)}". When peekAvg
//      returns null (very first render, before any valid tick
//      has landed) the slot is "{prefix}:0".
function computeTickTotals(
  ctx: RenderContext,
  kind: "in" | "out" | "cache",
): { value: string } {
  const t = ctx.tokens;
  const prefix = kind === "in" ? "in" : kind === "out" ? "out" : "cache";
  if (!t || !t.sessionId) return { value: `${prefix}:0` };
  if (kind === "cache" && t.current.cacheRead == null) {
    return { value: `${prefix}:--` };
  }
  // Idempotent on the tick-delta memo: if computeTickAvg ran
  // earlier in the same render, the memo is hot. If this totals
  // module is the ONLY per-API-call module in the template, we
  // are now the canonical primer and must fire the setAvg
  // accumulator write ourselves — otherwise peekAvg below
  // returns null on every tick and the module stays at "0"
  // forever. We also must fire setPrevTick when one is owed —
  // without it, the next tick re-derives deltaIn from the same
  // prev=0 baseline, double-counting the entire input total
  // instead of accumulating the per-tick delta. setAvg is gated
  // on _tickAvgWriteMemo so a render containing both this totals
  // module AND an avg module (or two totals modules) only
  // accumulates once.
  const r = computeAndCacheTickDelta(ctx);
  if (r.writeBack && t.sessionId) {
    setPrevTick(t.sessionId, r.writeBack);
  }
  if (r.hasDelta && !_tickAvgWriteMemo.get(ctx)) {
    _tickAvgWriteMemo.set(ctx, true);
    const prev = peekAvg(t.sessionId);
    const next: AvgSnapshot = {
      sumIn: (prev?.sumIn ?? 0) + r.deltaIn,
      sumOut: (prev?.sumOut ?? 0) + r.deltaOut,
      sumApi: (prev?.sumApi ?? 0) + r.deltaApi,
      sumCache: (prev?.sumCache ?? 0) + r.deltaCacheRead,
    };
    setAvg(t.sessionId, next);
  }
  const avg = peekAvg(t.sessionId);
  if (!avg) return { value: `${prefix}:0` };
  const n = kind === "in" ? avg.sumIn : kind === "out" ? avg.sumOut : avg.sumCache;
  return { value: `${prefix}:${formatCompactToken(n)}` };
}

const MODULES: Record<string, Module> = {
  // The leading prefix. For the plan path, picks the mode-aware
  // label ("Usage:" / "Remain:"). For the balance path, the label
  // is the dedicated modeLabels.balance entry (default "Balance:").
  // Returns the label WITHOUT a trailing space — the surrounding
  // s_0 separator token provides spacing.
  m_modeLabel: (c) => {
    if (c.balance) return cfg().modeLabels.balance;
    return cfg().modeLabels[c.mode];
  },
  m_window5h: (c) => (c.fiveHour ? formatOneChunk(c.fiveHour, c.mode) : null),
  m_window7d: (c) => (c.weekly ? formatOneChunk(c.weekly, c.mode) : null),
  // Reset-suffix portion of a window. Returns null only when the
  // whole window is missing; when resetAt is missing the helper
  // still emits " <label>" (e.g. " 5h") so the m_countdown5h token
  // doubles as the window-label module for legacy/no-reset data.
  m_countdown5h: (c) =>
    c.fiveHour ? formatOneResetSuffix("5h", c.fiveHour, c.nowMs) : null,
  m_countdown7d: (c) =>
    c.weekly ? formatOneResetSuffix("7d", c.weekly, c.nowMs) : null,
  // The DeepSeek balance chunk. Returns null when there's nothing
  // to render (unavailable / empty / no min) so the template can
  // opt out of showing it.
  m_balance: (c) => (c.balance ? formatBalanceEntriesColored(c.balance) || null : null),
  // Stale-age annotation. When present in the lineTemplate, this is
  // the primary render path — it emits unconditionally (no stale
  // gating). The emoji reflects the fetch state: 🔗 for fresh ticks
  // (showing the cache age), ⛓️‍💥 for stale (showing the time since
  // the last successful fetch). Returns null when ageMs is missing
// — that's the only signal that "no age info is available".
  m_age: (c) =>
    c.ageMs != null ? formatStaleSuffix(c.ageMs, !c.stale) : null,
  // Plugin version (e.g. "v0.2.17"). Hidden when version is empty
  // (the configStore never got setVersion()'d — e.g. tests that
  // don't care about the version).
  m_version: (c) => (c.version ? `v${c.version}` : null),
  // ----- v0.4.0+ token-usage modules -----
  // Each module is independent and returns null when its source data
  // isn't available, so users compose freely via lineTemplate. The
  // default plan / balance templates do NOT include any of these —
  // existing users see no change on upgrade.

  // Per-API-call input tokens. v0.4.0+ — semantics changed
  // again: from "raw current_usage.input_tokens (absolute)" to
  // "delta of current.input vs the previous tick's snapshot, but
  // ONLY when an actual API call happened between ticks". The
  // same prevTick cache that m_tokenInSpeed uses is read here;
  // the gate is identical (delta_api > 0). When no API call
  // landed, this module renders "in:--" — same stable-slot
  // pattern as the speed modules — so the user can SEE whether
  // the current turn produced output or just sat idle. For the
  // session-cumulative intent, see m_tokenInTotal / m_tokenTotal
  // / m_tokenSession.
  m_tokenIn: (c) => {
    const r = computeTickDelta(c, "in");
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack);
    return r.value;
  },
  // Per-API-call output tokens (see m_tokenIn for the gate
  // rationale — output-only turns, thinking-only turns, idle
  // turns all produce different "out:--" / "out:N" signals).
  m_tokenOut: (c) => {
    const r = computeTickDelta(c, "out");
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack);
    return r.value;
  },
  // Session cumulative in + out + cache (cache = ctx_creation + ctx_read
  // from the latest per-turn snapshot — close enough for "total tokens
  // spent in this session" intent; users wanting exact counts can split
  // into m_tokenIn / m_tokenOut).
  m_tokenTotal: (c) => {
    const t = c.tokens;
    if (!t) return null;
    const inT = t.totals.input ?? 0;
    const outT = t.totals.output ?? 0;
    const cache =
      (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
    return `tot:${formatCompactToken(inT + outT + cache)}`;
  },
  // Alias for m_tokenTotal — clearer when used in a template that
  // also has m_token5h/m_token7d (so the three read as "session / 5h /
  // 7d" rather than "tot / 5h / 7d").
  m_tokenSession: (c) => {
    const t = c.tokens;
    if (!t) return null;
    const inT = t.totals.input ?? 0;
    const outT = t.totals.output ?? 0;
    const cache =
      (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
    return `session:${formatCompactToken(inT + outT + cache)}`;
  },
  // Current post-turn context length (current_usage.input + creation + read,
  // excludes output per ccstatusline convention).
  m_ctx: (c) => {
    const t = c.tokens?.current;
    if (!t) return null;
    const len =
      (t.input ?? 0) + (t.cacheCreation ?? 0) + (t.cacheRead ?? 0);
    if (len === 0) return null;
    return `ctx:${formatCompactToken(len)}`;
  },
  // Cache hit rate — session-aggregate formula:
  //   sumCacheRead / (sumCacheRead + sumIn) * 100
  // i.e. the same total fields that m_totalTokenWithCacheIn and
  // m_totalTokenIn render. NOT the per-turn `cacheRead/(cacheRead
  // + cacheCreation)` ratio (which would compute a per-API-call hit
  // rate and lose all session context). Coloring still uses the
  // cacheHitColors palette (good ≥ 80%, warn ≥ 50%, bad < 50%).
  m_cacheHitRate: (c) => {
    const sid = c.tokens?.sessionId;
    if (!sid) return null;
    // Trigger the accumulator write so peekAvg reflects this tick's
    // delta even when this module is the ONLY per-API-call module
    // in the template (the totals/avg modules would otherwise be the
    // canonical primer; without them we'd see stale "0%" forever).
    // setAvg is idempotent via _tickAvgWriteMemo so coexisting
    // totals/avg modules in the same render don't double-count.
    const r = computeAndCacheTickDelta(c);
    if (r.writeBack && sid) setPrevTick(sid, r.writeBack);
    if (r.hasDelta && !_tickAvgWriteMemo.get(c)) {
      _tickAvgWriteMemo.set(c, true);
      const prev = peekAvg(sid);
      const next: AvgSnapshot = {
        sumIn: (prev?.sumIn ?? 0) + r.deltaIn,
        sumOut: (prev?.sumOut ?? 0) + r.deltaOut,
        sumApi: (prev?.sumApi ?? 0) + r.deltaApi,
        sumCache: (prev?.sumCache ?? 0) + r.deltaCacheRead,
      };
      setAvg(sid, next);
    }
    const avg = peekAvg(sid);
    if (!avg) return null;
    const denom = avg.sumCache + avg.sumIn;
    if (denom === 0) return null;
    const pct = (avg.sumCache / denom) * 100;
    const color = cacheHitColor(pct);
    return `${color}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  // Cache read tokens + context share (ccstatusline-style: "163k (99.2%)").
  // Single-color (STALE_COLOR); the percentage is informational, not
  // a health indicator on its own.
  m_cacheRead: (c) => {
    const t = c.tokens?.current;
    if (!t) return null;
    const read = t.cacheRead ?? 0;
    if (read === 0) return null;
    const denom =
      (t.input ?? 0) + read + (t.cacheCreation ?? 0);
    const pct = denom > 0 ? (read / denom) * 100 : null;
    const label = formatCompactToken(read);
    return pct == null
      ? `${STALE_COLOR}cache:${label}${RESET}`
      : `${STALE_COLOR}cache:${label} (${pct.toFixed(cachePctPrecision())}%)${RESET}`;
  },
  // Tokens used in the last 5h. Reads token-samples.jsonl filtered to
  // (now - 5h). Sums in+out per sample; uses delta vs FIRST sample in
  // the window to avoid double-counting cumulative growth across
  // samples (samples within the window each carry the SESSION-cumulative
  // value, not a delta).
  m_token5h: (c) =>
    windowedTokenLabel(c, 5 * 60 * 60 * 1000, "5h"),
  // Tokens used in the last 7d.
  m_token7d: (c) =>
    windowedTokenLabel(c, 7 * 24 * 60 * 60 * 1000, "7d"),
  // v0.4.0+ — per-API-call input speed. Reads the previous-tick
  // snapshot from cache (keyed by sessionId) and computes
  // delta(current.input) / delta(cost.totalApiDurationMs) * 1000.
  // The bare form (and `:color:scale`) applies the 5-band scale
  // color via speedScaleColor: faster = greener, slower = redder;
  // the `:color:<shortcut|SGR>` form overrides with a single color
  // (e.g. `:color:red`). computeTickSpeed handles the cached /
  // idle case by switching to STALE_COLOR regardless of the
  // caller's color — gray signals "inactive: this measurement is
  // from a previous API call, not this tick".
  m_tokenInSpeed: (c) => {
    // First call with a temporary color to discover the tps
    // (for the active case); the actual rendered value comes
    // from a second call with the proper color. Two
    // computeAndCacheTickDelta calls is fine — the per-render
    // memo makes the second call free.
    const probe = computeTickSpeed(c, "in", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("in", probe.tps ?? 0)
      : STALE_COLOR; // unused — computeTickSpeed forces STALE
    const r = computeTickSpeed(c, "in", color);
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack);
    return r.value;
  },
  // v0.4.0+ — per-API-call output speed (see m_tokenInSpeed for
  // the math + drop conditions).
  m_tokenOutSpeed: (c) => {
    const probe = computeTickSpeed(c, "out", STALE_COLOR);
    const color = probe.active
      ? speedScaleColor("out", probe.tps ?? 0)
      : STALE_COLOR;
    const r = computeTickSpeed(c, "out", color);
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack);
    return r.value;
  },
  // v0.4.0+ — per-session running-average input speed
  // (sum(deltaIn) / sum(deltaApi) * 1000). Always renders — a
  // valid-API-call contribution each tick; shows "--" when no
  // valid tick has accumulated yet. See computeTickAvg for the
  // accumulator semantics.
  m_tokenInAvg: (c) => {
    const r = computeTickAvg(c, "in", STALE_COLOR);
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack);
    return r.value;
  },
  // v0.4.0+ — per-session running-average output speed.
  m_tokenOutAvg: (c) => {
    const r = computeTickAvg(c, "out", STALE_COLOR);
    if (r.writeBack && c.tokens?.sessionId) setPrevTick(c.tokens.sessionId, r.writeBack);
    return r.value;
  },
  // v0.4.0+ — per-session running total of input tokens across
  // valid-API-call ticks. Reads the same tickAvg cache slot that
  // m_tokenInAvg maintains; when this module is alone in the
  // template, computeTickTotals fires the accumulator write
  // itself.
  m_totalTokenIn: (c) => computeTickTotals(c, "in").value,
  // v0.4.0+ — per-session running total of output tokens.
  m_totalTokenOut: (c) => computeTickTotals(c, "out").value,
  // v0.4.0+ — per-session running total of
  // cache_read_input_tokens. Renders "cache:--" when stdin lacks
  // the field (user-resolved honest "data unavailable" signal).
  m_totalTokenWithCacheIn: (c) => computeTickTotals(c, "cache").value,
  // v0.3.6+ — bare `m_quote` (no inline args). Picks a quote from
  // the hourly window and renders it plain (no SGR wrapper). Opt-in
  // — the default plan / balance templates do NOT include it.
  m_quote: (c) => {
    const freq = parseFreq("h");
    if (!freq) return null; // unreachable — "h" is always valid
    return pickQuote(freq, c.nowMs);
  },

  // ----- v0.4.0+ session-info / metadata modules -----
  // These read fields from the live stdin payload. The default
  // plan / balance templates do NOT include any of these — they are
  // strictly opt-in via lineTemplate.

  // Session name (stdin.session_name). Bare string; no prefix.
  m_session: (c) => c.tokens?.sessionName ?? null,
  // Model display name (stdin.model.display_name). Bare string.
  m_model: (c) => c.tokens?.modelDisplayName ?? null,
  // Effort level (stdin.effort, polymorphic — already coerced to
  // string by parseTokenSnapshot). Bare string.
  m_effort: (c) => c.tokens?.effort ?? null,
  // Repository identity (stdin.workspace.repo). Renders the non-null
  // host/owner/name components joined by "/" — drop-null policy so
  // missing fields don't produce a leading or trailing slash. Returns
  // null when no component is available, or when r.workspace.repo is
  // missing entirely.
  m_repo: (c) => {
    const r = c.tokens?.repo;
    if (!r) return null;
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    return parts.length > 0 ? parts.join("/") : null;
  },
  // Claude Code CLI version (stdin.version). Distinct from the
  // existing m_version which emits the *plugin* version.
  //
  // v0.4.0+ — also registered as `m_ccversion` for backwards
  // compatibility with pre-rename configs. Both keys resolve to
  // the same body. The camelCase form is the canonical / documented
  // one going forward; the lowercase form is the deprecated alias
  // that will keep working so existing lineTemplate strings don't
  // need an immediate edit.
  m_ccVersion: (c) => c.tokens?.ccversion ?? null,
  // Deprecated alias — see m_ccVersion above. Same body.
  m_ccversion: (c) => c.tokens?.ccversion ?? null,
  // Session elapsed wall-clock (stdin.cost.total_duration_ms). Formatted
  // with the same dhms formatter used for reset countdowns.
  m_sessionDuration: (c) => {
    const ms = c.tokens?.cost.totalDurationMs;
    return ms != null ? formatRemainingMs(ms) : null;
  },
  // Session API-call time (stdin.cost.total_api_duration_ms). Same
  // dhms format.
  m_sessionApiDuration: (c) => {
    const ms = c.tokens?.cost.totalApiDurationMs;
    return ms != null ? formatRemainingMs(ms) : null;
  },
  // Session-cumulative lines added (stdin.cost.total_lines_added).
  // Literal "+ 3965" format — leading space included.
  m_linesAdded: (c) => {
    const n = c.tokens?.cost.totalLinesAdded;
    return n != null ? `+ ${n}` : null;
  },
  // Session-cumulative lines removed (stdin.cost.total_lines_removed).
  // Literal "- 967" format — leading space included.
  m_linesRemoved: (c) => {
    const n = c.tokens?.cost.totalLinesRemoved;
    return n != null ? `- ${n}` : null;
  },
  // Session-cumulative input tokens (stdin.context_window.total_input_tokens).
  // v0.4.0: new module — replaces the pre-v0.4.0 m_tokenIn behavior.
  m_tokenInTotal: (c) =>
    c.tokens?.totals.input != null
      ? `in:${formatCompactToken(c.tokens.totals.input)}`
      : null,
  // Session-cumulative output tokens. v0.4.0: new module.
  m_tokenOutTotal: (c) =>
    c.tokens?.totals.output != null
      ? `out:${formatCompactToken(c.tokens.totals.output)}`
      : null,
  // Context window size (stdin.context_window.context_window_size).
  // Compact format (e.g. 200000 → "200.0k").
  m_contextSize: (c) => {
    const sz = c.tokens?.contextWindow?.size;
    return sz != null ? formatCompactToken(sz) : null;
  },
  // Context window used percentage (stdin.context_window.used_percentage).
  // Plain "63%" format. No color — the m_windowContext module is the
  // bar+color variant.
  m_contextUsed: (c) => {
    const pct = c.tokens?.contextWindow?.usedPct;
    return pct != null ? `${pct}%` : null;
  },
  // Context window bar + 5-band-colored percentage, parallel to
  // m_window5h / m_window7d. Reads from ctx.contextWindow (a
  // synthetic Window populated from stdin.context_window.used_percentage).
  m_windowContext: (c) =>
    c.contextWindow ? formatOneChunk(c.contextWindow, c.mode) : null,
};

// Cap unknown-module warnings to once per process so a template typo
// doesn't spam stderr on every statusline tick (which is every few
// seconds in active sessions). A one-shot warn is enough — the user
// will see it on the first invocation.
let _unknownModuleWarned = false;

// ----- v0.4.0+ token-module helpers -----

// Compact token formatter: <thresholds[0] → raw integer, <thresholds[1]
// → "<x.y>k", else "<x.y>M". Matches formatRemainingMs's tier shape
// but uses token-specific thresholds (default 1k / 1M). Negative or
// non-finite inputs fall back to "0". Exported so tests can pin the
// behavior at threshold boundaries.
export function formatCompactToken(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const t = cfg().tokenFormat;
  const [lo, hi] = t.thresholds;
  if (n < lo) return String(Math.floor(n));
  if (n < hi) return `${(n / 1_000).toFixed(t.precision)}k`;
  return `${(n / 1_000_000).toFixed(t.precision)}M`;
}

// Speed formatter: t/s with k suffix above 1000. Mirrors ccstatusline's
// formatSpeed. Null → "—". Exported for tests.
export function formatSpeed(tps: number | null): string {
  if (tps == null || !Number.isFinite(tps)) return "—";
  const precision = cfg().tokenFormat.speedPrecision;
  if (Math.abs(tps) >= 1000) {
    return `${(tps / 1000).toFixed(precision)}k t/s`;
  }
  return `${tps.toFixed(precision)} t/s`;
}

// v0.4.0+ — 5-band color picker for the speed scale.
// Faster = greener; slower = redder. Same color palette
// shape as the existing 5-band gauge modules
// (m_window5h/7d/context): bright green / dark green /
// yellow / orange / red, indexed from the FAST end.
//
// `in` uses 5× the `out` thresholds (per the user's spec:
// out: [10, 20, 40, 80], in: [50, 100, 200, 400]) — input
// streams naturally run hotter than output, so the bands
// are scaled accordingly. The thresholds are config-driven
// (cfg().tokenFormat.speedScaleBands) but the defaults match
// the user-requested bands. Returns an SGR string; the
// caller wraps the value with the RESET suffix.
export function speedScaleColor(
  direction: "in" | "out",
  tps: number,
): string {
  const c = cfg().colors;
  // Same 5-color palette the gauge modules use. Index 0 =
  // fastest (bright green); index 4 = slowest (red).
  const palette = [
    c.brightGreen, // brightest green — fastest
    c.darkGreen,
    c.yellow,
    c.orange,
    c.red,         // red — slowest
  ];
  const bands = direction === "in"
    ? cfg().tokenFormat.speedScaleBands.in
    : cfg().tokenFormat.speedScaleBands.out;
  // bands are sorted ascending; we want to pick the band
  // that the tps falls INTO from the FAST end. tps >= bands[3]
  // → fastest (palette[0]); tps < bands[0] → slowest
  // (palette[4]).
  if (tps >= bands[3]) return palette[0];
  if (tps >= bands[2]) return palette[1];
  if (tps >= bands[1]) return palette[2];
  if (tps >= bands[0]) return palette[3];
  return palette[4];
}

function cachePctPrecision(): number {
  return cfg().tokenFormat.cachePctPrecision;
}

// 3-band cache-hit color picker (good / warn / bad) using
// cacheHitColors + cacheHitThresholds from config. Exported for tests.
export function cacheHitColor(pct: number): string {
  const [lo, hi] = cfg().tokenFormat.cacheHitThresholds;
  const c = cfg().cacheHitColors;
  if (pct >= hi) return c.good;
  if (pct >= lo) return c.warn;
  return c.bad;
}

// Read samples for the (cwd, session) from the current snapshot,
// filter to the [now - windowMs, now] range, sum the delta between
// the FIRST and LAST sample in the window, and format as
// "<label>:<compact>". Returns null when:
//   - tokens/sessionId/cwd missing
//   - no samples in the window yet (fresh session)
//   - only one sample (can't compute a delta)
// The "first sample baseline + last sample now" approach matches how
// total_input_tokens / total_output_tokens are session-cumulative on
// stdin — delta = (cumulative at end of window) - (cumulative at start
// of window) = tokens used during the window.
function windowedTokenLabel(
  c: RenderContext,
  windowMs: number,
  label: string,
): string | null {
  const t = c.tokens;
  if (!t || !t.sessionId || !t.cwd) return null;
  const since = c.nowMs - windowMs;
  const samples = readSamples(t.cwd, t.sessionId, since);
  if (samples.length < 2) return null;
  // Sort defensively in case the JSONL wasn't appended in time order.
  const sorted = samples.slice().sort((a, b) => a.at - b.at);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const deltaIn = Math.max(0, last.in - first.in);
  const deltaOut = Math.max(0, last.out - first.out);
  // Per ADR: 5h/7d windows reuse tokenplan Window.resetStartAt when
  // available (so the window boundary lines up exactly). Falling back
  // to sliding `now - windowMs` when no plan data is loaded keeps the
  // module useful for non-tokenplan providers.
  const total = deltaIn + deltaOut;
  if (total === 0) return null;
  return `${label}:${formatCompactToken(total)}`;
}

function warnUnknownModuleOnce(name: string): void {
  if (_unknownModuleWarned) return;
  _unknownModuleWarned = true;
  process.stderr.write(`tokenplan-usage-hud: unknown lineTemplate module '${name}'; ignoring\n`);
}

// Reset the once-per-process warn flag. Exported so tests can clear
// it between cases and observe the warning on demand.
export function __resetUnknownModuleWarnForTest(): void {
  _unknownModuleWarned = false;
}

// Expand a template into rendered lines. Each output element is one
// rendered line — separators and module pieces that contain "\n" are
// split into separate line segments. Empty segments are dropped so a
// trailing "\n" separator doesn't emit a blank line at the end.
//
// Modules that return null (or "") cause their immediately adjacent
// s_N tokens to be skipped too — see the comment on RenderContext for
// the reasoning. Empty segments from the splitting pass get the same
// treatment.
// ----- v0.3.3+ inline-args tokens -----
//
// Three token forms now take colon-delimited parameters:
//
//   s_<n>[:color:<c>]
//   m_label:<string>[:color:<c>]
//   m_modeLabel[:color:<c>]
//
// General grammar: <prefix>(:<param>:<value>)*. Even segment count is
// required after the prefix; odd counts drop the token. Every
// (param, value) pair must be in the prefix's registered schema;
// unknown params drop the token. The renderer for the prefix takes the
// resolved { param: value } object plus the render context and returns
// the chunk text (or null to drop).
//
// Future parameterized modules (m_model, …) plug in by adding an entry
// to both INLINE_SCHEMAS and INLINE_RENDERERS. The bare <prefix> form
// (no colon) still routes through MODULES as before — so existing
// templates using bare `m_modeLabel` / `s_0` keep working byte-for-byte.

// Snapshot of `cfg().colors` + the `brightBlack` input shortcut. Read
// once at module load so render hot paths don't touch configStore per
// call. Mirrors the pattern at lines 56-63.
const LABEL_COLOR_SHORTCUTS: Record<string, string> = (() => {
  const c = configStore.get().colors;
  return {
    brightGreen: c.brightGreen,
    darkGreen: c.darkGreen,
    yellow: c.yellow,
    orange: c.orange,
    red: c.red,
    stale: c.stale,
    brightBlack: "\x1b[90m",
  };
})();

// Pure resolver for `<colorvalue>`. Accepts shortcut names and raw
// SGR strings (`\x1b[…m`). Returns null on anything else so the
// caller can warn + soft-fallback to plain text.
//
// v0.3.5+: the SPECIAL shortcut set (rainbow / rand-rainbow / hue)
// is NOT returned by this resolver — those need per-text processing
// (buildRainbow / buildHue from src/quotes.ts), not a single SGR
// string. They're handled at a higher level by `applyColor` below.
// This resolver only validates shortcut-as-SGR and raw-SGR strings.
// v0.4.0+ — sentinel string returned by resolveColor when the
// user writes `:color:scale`. The speed-module renderers
// (m_tokenInSpeed / m_tokenOutSpeed, both bare default and
// inline) detect this token and replace it with the per-band
// scale color via speedScaleColor(). For all other modules
// the value behaves as opaque — they'd never see it because
// their schema doesn't accept a custom color palette, and
// resolving it to the literal string means a bug in the
// caller that swallows it just renders uncolored (the SGR
// would be invalid, but the chunk would still display).
export const SCALE_COLOR_SENTINEL = "__SCALE__";

function resolveColor(value: string): string | null {
  if (value === "scale") return SCALE_COLOR_SENTINEL;
  if (LABEL_COLOR_SHORTCUTS[value]) return LABEL_COLOR_SHORTCUTS[value];
  if (/^\x1b\[[0-9;]*m$/.test(value)) return value;
  return null;
}

// Tagged result for the higher-level `resolveColorParam` (used by
// m_quote and any other future module that wants the
// rainbow/hue shortcuts). Not exported via INLINE_SCHEMAS's
// `ParamResolver` return type (which is `ResolvedValue | null`,
// i.e. string | number | null) — the m_quote schema's `color`
// resolver does a string-tag instead, and the renderer recognizes
// the 3 magic strings as "apply buildRainbow / buildHue".
export type ColorParam =
  | { kind: "sgr"; value: string } // wrap text with `<sgr>…<RESET>`
  | { kind: "rainbow"; salt: number } // per-char SGR; salt offsets the rotation
  | { kind: "hue" } // single-hue wrap from buildHue
  | { kind: "none" };

// Resolve the full `<colorvalue>` namespace: shortcut names, raw
// SGR strings, plus the 3 special values. Returns a tagged result
// the renderer pattern-matches against. Same null-on-bad-value
// contract as `resolveColor` so the dispatcher can warn + drop.
export function resolveColorParam(value: string): ColorParam | null {
  if (value === "rainbow") return { kind: "rainbow", salt: 0 };
  if (value === "rand-rainbow") return { kind: "rainbow", salt: 1 };
  if (value === "hue") return { kind: "hue" };
  const sgr = resolveColor(value);
  if (sgr === null) return null;
  return { kind: "sgr", value: sgr };
}

// Apply a resolved ColorParam to a plain-text body. Used by
// m_quote (and any future module that opts into the full color
// grammar). Safe ONLY for plain-text bodies — colored bodies must
// use their override-aware helpers (e.g. formatOneChunkColored).
//
// The `seed` argument seeds rainbow / hue color generation so a
// caller can tie color choice to a frequency window (same window
// → same color). Callers that don't care about per-window color
// stability can pass 0.
export function applyColor(
  body: string,
  param: ColorParam,
  seed: number,
): string {
  if (body === "") return body;
  switch (param.kind) {
    case "sgr":
      return `${param.value}${body}${RESET}`;
    case "rainbow":
      return buildRainbow(body, seed + param.salt);
    case "hue":
      return buildHue(body, seed);
    case "none":
      return body;
  }
}

// Encode a ColorParam as a string so it round-trips through the
// generic `params.color: string` channel that INLINE_RENDERERS uses.
// The decoder is `paramFromString`. This keeps the existing
// ResolvedValue = string | number contract intact.
const COLOR_KIND_SGR = "\x00COLOR:sgr:";
const COLOR_KIND_RAINBOW = "\x00COLOR:rainbow:";
const COLOR_KIND_HUE = "\x00COLOR:hue:";

export function encodeColorParam(p: ColorParam): string {
  switch (p.kind) {
    case "sgr":
      return COLOR_KIND_SGR + p.value;
    case "rainbow":
      return COLOR_KIND_RAINBOW + String(p.salt);
    case "hue":
      return COLOR_KIND_HUE;
    case "none":
      return "";
  }
}

export function decodeColorParam(encoded: string | undefined): ColorParam {
  if (encoded === undefined || encoded === "") return { kind: "none" };
  if (encoded.startsWith(COLOR_KIND_SGR)) {
    return { kind: "sgr", value: encoded.slice(COLOR_KIND_SGR.length) };
  }
  if (encoded.startsWith(COLOR_KIND_RAINBOW)) {
    const salt = Number(encoded.slice(COLOR_KIND_RAINBOW.length));
    return { kind: "rainbow", salt: Number.isFinite(salt) ? salt : 0 };
  }
  if (encoded.startsWith(COLOR_KIND_HUE)) {
    return { kind: "hue" };
  }
  // Fallback: treat the string as a raw SGR. (Shouldn't happen
  // since the resolver validates, but defensive.)
  return { kind: "sgr", value: encoded };
}

type ResolvedValue = string | number;

type ParamResolver = (raw: string) => ResolvedValue | null;

// Sentinel: renderers return this to signal "args parsed fine but
// semantically invalid" (e.g. m_label with an empty string, s_<n>
// with an out-of-range index). The dispatcher warns once on this;
// a plain null is treated as "no data to show" (silent drop, same
// as the bare MODULES path).
const INLINE_BADARG = Symbol("inline-badarg");

type InlineRenderer = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string | null | typeof INLINE_BADARG;

// Per-prefix inline schema. The first segment after the prefix is the
// value of the implicit param (`implicit`). Subsequent segments come in
// `name:value` pairs resolved against `named`. Future parameterized
// modules (m_model, …) plug in here.
type InlineSchema = {
  implicit?: { name: string; resolver: ParamResolver };
  named: Record<string, ParamResolver>;
};

// v0.3.3+: every existing module accepts an optional `:color:<c>`
// override via inline-args. The named param is `color` for all of
// them — same shortcut table and raw-SGR rules as `m_label`.
//
// For modules that emit plain text (no internal SGR), the override
// is a simple wrap. For modules that already apply a band-based /
// single-color SGR (m_window5h/7d, m_balance, m_cacheHitRate,
// m_cacheRead, m_age, m_tokenInSpeed, m_tokenOutSpeed), the override
// REPLACES the natural color choice — the user's `color` always wins.
// (Per spec: "如果与现有颜色方案冲突，则无视该参数" — interpreted as
// "if the user explicitly asked for a color, ignore the natural
// scheme in favor of theirs".)
const COLOR_PARAM = {
  named: {
    color: (raw: string) => resolveColor(raw),
  },
} as const;

// v0.4.0+ — per-module null-drop override. Accepts "true" or "false"
// verbatim; anything else is a parse-fail and the inline token is
// dropped (same as :color:<garbage>). Semantics:
//
//   nulldrop omitted / nulldrop:false  → DEFAULT. Force a stable
//     placeholder when the data is missing — the module ALWAYS
//     renders, regardless of whether the underlying field is null.
//     This keeps the line layout stable across ticks and matches
//     the user's expectation that an explicitly-listed module in
//     lineTemplate should occupy its slot.
//   nulldrop:true                      → opt out of the placeholder
//     and preserve the v0.3.x "drop on null" behavior. The module
//     disappears and adjacent separators are skipped.
//
// The bare MODULES path (no inline args) keeps the original drop
// semantics — bare `m_ctx` still drops on null. To get the
// placeholder behavior the user must use the inline form `m_ctx`
// (which now defaults to placeholder — see above). This is a
// BREAKING change for any existing inline template that lists a
// module whose value is sometimes null (the slot is now always
// visible). Users who want the old drop behavior add
// `:nulldrop:true` to those tokens.
//
// Placeholder shape per module (see PLACEHOLDERS in render.ts
// for the dispatch):
//   pure-number modules        → STALE_COLOR wrap on "n/a" (e.g.
//                                "in:n/a", "ctx:n/a", "cache:n/a")
//   number+unit modules        → STALE_COLOR wrap on "-- <unit>"
//                                (e.g. "5h:--", "session:--", "+ --")
//   gauge modules              → STALE_COLOR wrap on
//                                "░░░░░░░░ 0%" (parallel to the
//                                natural 0-value render)
//   bare-string modules        → STALE_COLOR wrap on "n/a"
const NULDROP_PARAM = {
  named: {
    nulldrop: (raw: string): ResolvedValue | null =>
      raw === "true" || raw === "false" ? raw : null,
  },
} as const;

// v0.4.0+ — per-module display-mode override (scoped to the bar
// computation for the window modules). Accepts "used" or
// "remaining" verbatim; anything else is a parse-fail and the
// inline token is dropped (same as :color:<garbage>). Resolution is
// deliberately narrow — the module-level `display` config field
// (RESOLVED via resolveDisplayMode) stays the default for the bare
// `m_window5h` form. Inline display wins when present, so users can
// e.g. show 5h as "remaining" while the global config is "used".
const DISPLAY_PARAM = {
  named: {
    display: (raw: string): ResolvedValue | null =>
      raw === "used" || raw === "remaining" ? raw : null,
  },
} as const;

// ----- v0.4.0+ placeholder shapes for nulldrop:false -----------------------
//
// Each constant is a closure over the inline-args params + ctx so the
// INLINE_RENDERERS can pull a precomputed placeholder body. Every
// placeholder wraps its body in `${STALE_COLOR}…${RESET}` so a missing
// gauge / number reads as "dim gray, no data" — visually distinct
// from a real value (which is colored by the band palette or wrapped
// in the user's :color: override). The :color: inline override still
// wins when present (it REPLACES the placeholder's STALE_COLOR wrap,
// matching the existing "user override always wins" rule).

// pure-number placeholder body: "<prefix>n/a" — PLAIN text. The
// STALE_COLOR wrap is applied by the INLINE_RENDERER (via
// wrapPlain / formatOneChunkColored) so a `:color:<c>` inline
// override REPLACES the default STALE_COLOR, matching the
// existing "user color always wins" rule for every other module.
// The prefix matches the module's normal inline label (e.g.
// "ctx:", "in:", "out:", "cache:") so a nulldrop placeholder reads
// like the same module just with "n/a" instead of a real number.
// Bare-string modules pass prefix="" (e.g. m_session → just "n/a").
function placeholderNA(
  prefix: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => `${prefix}n/a`;
}

// number+unit placeholder body: PLAIN text. The STALE_COLOR wrap
// is applied by the INLINE_RENDERER (via wrapPlain) for the same
// reason as placeholderNA. The `body` is the COMPLETE placeholder
// text the module would otherwise emit (e.g. "5h:--", "+ --",
// "-- t/s"). Bare-number modules pass body="--" with no suffix
// (e.g. m_sessionDuration → "--", matching the existing
// formatRemainingMs shape).
function placeholderDashesUnit(
  body: string,
): (_params: Record<string, ResolvedValue>, _ctx: RenderContext) => string {
  return (_p, _c) => body;
}

// gauge placeholder body: returns PLAIN text (no SGR). The
// INLINE_RENDERER handles the SGR wrap via wrapPlain (so a
// `:color:<c>` override can REPLACE the default STALE_COLOR just
// like every other module). The placeholder shape is a 0-value
// bar — "used" mode shows an empty bar with "0%"; "remaining"
// mode shows a full bar with "100%". The synthetic pct=0 keeps
// the bar geometry aligned with the natural 0-value render path
// (see render-tokens.test.ts: "m_windowContext: usedPct=0").
function placeholderGauge(
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string {
  const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
  const empty = cfg().bar.empty;
  const filled = cfg().bar.filled;
  const width = cfg().bar.width;
  if (mode === "used") {
    return `${empty.repeat(width)} 0%`;
  }
  // mode === "remaining": full filled bar, "100%".
  return `${filled.repeat(width)} 100%`;
}

// Module → placeholder dispatcher. Each module opts into ONE of
// the four shape families by listing its `placeholder` body. The
// INLINE_RENDERER consults this table when the data path returns
// null/empty AND params.nulldrop === "false".
//
// Add a module here ONLY if its bare-module null case is currently
// a `return null`. The four families cover every existing drop
// case: pure-number ("n/a"), number+unit ("-- <unit>"), gauge
// ("gray bar + 0%"), bare-string ("n/a").
type PlaceholderBody = (
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
) => string;

const PLACEHOLDERS: Record<string, PlaceholderBody> = {
  // pure-number — placeholder shape is "<prefix>n/a"
  m_tokenInTotal: placeholderNA("in:"),
  m_tokenOutTotal: placeholderNA("out:"),
  m_totalTokenIn: placeholderNA("in:"),
  m_totalTokenOut: placeholderNA("out:"),
  m_totalTokenWithCacheIn: placeholderNA("cache:"),
  m_ctx: placeholderNA("ctx:"),
  m_cacheRead: placeholderNA("cache:"),
  m_cacheHitRate: placeholderNA("hit:"),
  m_contextSize: placeholderNA(""),
  m_contextUsed: placeholderNA(""),
  // number+unit — placeholder shape is the module's normal body
  // with "--" swapped in for the numeric value (e.g. "5h:--",
  // "+ --", "-- t/s"). Empty body = bare dash.
  m_tokenInSpeed: placeholderDashesUnit("in:-- t/s"),
  m_tokenOutSpeed: placeholderDashesUnit("out:-- t/s"),
  m_tokenInAvg: placeholderDashesUnit("in:--"),
  m_tokenOutAvg: placeholderDashesUnit("out:--"),
  m_sessionDuration: placeholderDashesUnit("--"),
  m_sessionApiDuration: placeholderDashesUnit("--"),
  m_linesAdded: placeholderDashesUnit("+ --"),
  m_linesRemoved: placeholderDashesUnit("- --"),
  m_token5h: placeholderDashesUnit("5h:--"),
  m_token7d: placeholderDashesUnit("7d:--"),
  // gauge (placeholder shape is the gray 0% / 100% bar)
  m_window5h: placeholderGauge,
  m_window7d: placeholderGauge,
  m_windowContext: placeholderGauge,
  // bare-string (no prefix to recover from; just "n/a")
  m_session: placeholderNA(""),
  m_model: placeholderNA(""),
  m_effort: placeholderNA(""),
  m_repo: placeholderNA(""),
  m_ccVersion: placeholderNA(""),
  m_ccversion: placeholderNA(""),
};

// Render a placeholder body unless the user has explicitly opted
// out via `:nulldrop:true`, OR the module has no registered
// placeholder shape. The default is FORCED placeholder (every
// inline-listed module keeps its slot even when data is null).
// Returns null when the user opted out, so the caller's drop path
// takes over (matching the bare MODULES drop behavior).
//
// The returned string is PLAIN text (no SGR); the caller is
// expected to wrap it in the user's chosen color (defaults to
// STALE_COLOR via placeholderWithColor), matching the existing
// "override wins" pattern for every other inline module.
function placeholderOrNull(
  modKey: string,
  params: Record<string, ResolvedValue>,
  _ctx: RenderContext,
): string | null {
  if (params.nulldrop === "true") return null;
  const body = PLACEHOLDERS[modKey];
  if (!body) return null;
  return body(params, _ctx);
}

// Render a placeholder (when active) wrapped in the user's
// `:color:<c>` override, or STALE_COLOR by default. Returns null
// when the user opted out of the placeholder (`nulldrop:true`)
// OR the module has no registered placeholder shape — the caller's
// null-fall-through path takes over (drop, same as bare MODULES
// behavior).
//
// The STALE_COLOR default is what makes a missing-data placeholder
// visually distinct from a real value (a real `ctx:163.5k` is
// band-colored; a placeholder `ctx:n/a` is gray). Note: this is
// the OPPOSITE of wrapPlain (which returns plain text when no
// color is supplied) — placeholder rendering ALWAYS wraps, even
// without an override.
function placeholderWithColor(
  modKey: string,
  params: Record<string, ResolvedValue>,
  ctx: RenderContext,
): string | null {
  const body = placeholderOrNull(modKey, params, ctx);
  if (body == null) return null;
  const color = (params.color as string | undefined) ?? STALE_COLOR;
  return `${color}${body}${RESET}`;
}

// Extended-color schema used by `m_quote`. Accepts the standard
// 7 shortcuts + raw SGR + the 3 special shortcuts (rainbow /
// rand-rainbow / hue). The resolver encodes the tagged ColorParam
// as a string (using NUL-prefix sentinels in `encodeColorParam`)
// so it round-trips through the generic INLINE_SCHEMAS contract
// (`params.color: string | undefined`). The m_quote renderer
// decodes via `decodeColorParam`.
const QUOTE_COLOR_PARAM = {
  named: {
    color: (raw: string) => {
      const p = resolveColorParam(raw);
      if (p === null) return null;
      return encodeColorParam(p);
    },
  },
} as const;

const QUOTE_FREQ_PARAM = {
  named: {
    freq: (raw: string) => {
      // Shape-validate the single-unit time format up front so a
      // clearly-wrong token (e.g. "yearly", "2h10m", "5x") is
      // rejected before reaching the renderer. The renderer then
      // calls parseFreq() to extract the bucket size. We pass the
      // raw string through (rather than the parsed QuoteFreq
      // object) so the ResolvedValue = string | number channel
      // doesn't need a sentinel round-trip.
      if (raw === "") return null;
      // Bare unit letter → valid shorthand.
      if (raw === "d" || raw === "h" || raw === "m" || raw === "s") return raw;
      // Numeric form: <digits><unit>. Reject multi-unit, unknown
      // units, leading zeros, and empty digit runs here so the
      // renderer's parseFreq() never sees malformed input.
      if (raw.length < 2) return null;
      const unit = raw[raw.length - 1];
      if (unit !== "d" && unit !== "h" && unit !== "m" && unit !== "s") return null;
      const digits = raw.slice(0, -1);
      if (digits === "") return null;
      if (!/^[0-9]+$/.test(digits)) return null;
      if (digits.length > 1 && digits[0] === "0") return null;
      return raw;
    },
  },
} as const;

const INLINE_SCHEMAS: Record<string, InlineSchema> = {
  s_: {
    implicit: {
      name: "index",
      resolver: (raw) => {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) return null;
        return n;
      },
    },
    named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named },
  },
  m_label: {
    implicit: { name: "string", resolver: (raw) => raw },
    named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named },
  },
  m_modeLabel: {
    // No implicit — the string is derived from ctx. The first segment,
    // if present, MUST be a name in `named` (i.e. starts a name:value
    // pair). Otherwise the token is malformed.
    named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named },
  },
  // v0.3.3+ — every existing module also accepts an optional :color:
  // override. Schema is empty (`{}`) when the module takes no implicit
  // param; the renderer just reads params.color and applies it.
  m_window5h: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  m_window7d: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
  m_countdown5h: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_countdown7d: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_balance: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_age: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_version: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenSession: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ctx: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_cacheHitRate: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_cacheRead: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_token5h: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_token7d: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenOutSpeed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInAvg: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenOutAvg: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_totalTokenIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_totalTokenOut: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_totalTokenWithCacheIn: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  // v0.3.6+ — quote module. Accepts `:freq:<numeric-time>` and
  // `:color:<sgr|shortcut|rainbow|rand-rainbow|hue>`. The freq
  // grammar is the single-unit time format `<digits><unit>` (bare
  // unit letter = 1<unit>) — see QUOTE_FREQ_PARAM. Default freq
  // (`h` = 1h) is applied at the RENDERER level when params.freq
  // is undefined.
  m_quote: {
    named: {
      ...QUOTE_FREQ_PARAM.named,
      ...QUOTE_COLOR_PARAM.named,
      ...NULDROP_PARAM.named,
    },
  },
  // v0.4.0+ — session-info / metadata modules. All take only the
  // optional :color: override (mirror the m_token* pattern).
  m_session: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_model: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_effort: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_repo: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccVersion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_ccversion: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_sessionApiDuration: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_linesAdded: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_linesRemoved: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenInTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_tokenOutTotal: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_contextSize: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_contextUsed: { named: { ...COLOR_PARAM.named, ...NULDROP_PARAM.named } },
  m_windowContext: { named: { ...COLOR_PARAM.named, ...DISPLAY_PARAM.named, ...NULDROP_PARAM.named } },
};

// Pure helper: wrap a plain-text body in `<color>…<RESET>`. Returns
// the body unchanged when `color` is undefined. Safe ONLY for bodies
// that don't already contain SGR sequences — colored bodies must use
// their override-aware helper (e.g. formatOneChunkColored).
function wrapPlain(body: string, color: string | undefined): string {
  return color ? `${color}${body}${RESET}` : body;
}

// Per-prefix renderer. Returns the chunk text (or null to drop).
const INLINE_RENDERERS: Record<string, InlineRenderer> = {
  s_: (params, _ctx) => {
    const sep = cfg().separators[params.index as number];
    if (sep === undefined) return INLINE_BADARG; // out-of-range index
    return wrapPlain(sep, params.color as string | undefined);
  },
  m_label: (params, _ctx) => {
    const s = params.string as string;
    if (s === "") return INLINE_BADARG; // empty payload is malformed
    return wrapPlain(s, params.color as string | undefined);
  },
  m_modeLabel: (params, ctx) => {
    // Mirrors the MODULES["m_modeLabel"] body: balance path → balance
    // label, else the mode-aware label. The colored wrapper is added
    // here only (not in MODULES) so the bare `m_modeLabel` form keeps
    // its existing byte-for-byte output.
    const s = ctx.balance
      ? cfg().modeLabels.balance
      : cfg().modeLabels[ctx.mode];
    return wrapPlain(s, params.color as string | undefined);
  },
  m_window5h: (params, ctx) => {
    if (!ctx.fiveHour) return placeholderWithColor("m_window5h", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.fiveHour, mode, color);
    // No override → reproduce the bare-module output exactly.
    return formatOneChunk(ctx.fiveHour, mode);
  },
  m_window7d: (params, ctx) => {
    if (!ctx.weekly) return placeholderWithColor("m_window7d", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.weekly, mode, color);
    return formatOneChunk(ctx.weekly, mode);
  },
  m_countdown5h: (params, ctx) => {
    if (!ctx.fiveHour) return null;
    const body = formatOneResetSuffix("5h", ctx.fiveHour, ctx.nowMs);
    if (body === "") return null;
    return wrapPlain(body, params.color as string | undefined);
  },
  m_countdown7d: (params, ctx) => {
    if (!ctx.weekly) return null;
    const body = formatOneResetSuffix("7d", ctx.weekly, ctx.nowMs);
    if (body === "") return null;
    return wrapPlain(body, params.color as string | undefined);
  },
  m_balance: (params, ctx) => {
    // m_balance has no nulldrop placeholder — its no-data shape is
    // a multi-currency join ("CN¥10.50 · USDC5") that doesn't have
    // a natural placeholder. If the data is absent or the
    // formatted body is empty, drop the chunk. The MODULES path
    // has the same drop-on-null behavior, so inline parity is
    // preserved.
    if (!ctx.balance) return null;
    const color = params.color as string | undefined;
    const text = formatBalanceEntriesColored(ctx.balance, color);
    return text || null;
  },
  m_age: (params, ctx) => {
    if (ctx.ageMs == null) return null;
    const color = params.color as string | undefined;
    return formatStaleSuffix(ctx.ageMs, !ctx.stale, color);
  },
  m_version: (params, ctx) => {
    if (!ctx.version) return null;
    return wrapPlain(`v${ctx.version}`, params.color as string | undefined);
  },
  m_tokenIn: (params, ctx) => {
    const r = computeTickDelta(ctx, "in");
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack);
    return wrapPlain(r.value, params.color as string | undefined);
  },
  m_tokenOut: (params, ctx) => {
    const r = computeTickDelta(ctx, "out");
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack);
    return wrapPlain(r.value, params.color as string | undefined);
  },
  m_tokenTotal: (params, ctx) => {
    const body = inlineTokenTotalLabel(ctx);
    if (body == null) return placeholderWithColor("m_tokenTotal", params, ctx);
    return wrapPlain(body, params.color as string | undefined);
  },
  m_tokenSession: (params, ctx) => {
    const body = inlineTokenSessionLabel(ctx);
    if (body == null) return placeholderWithColor("m_tokenSession", params, ctx);
    return wrapPlain(body, params.color as string | undefined);
  },
  m_ctx: (params, ctx) => {
    const t = ctx.tokens?.current;
    if (!t) return placeholderWithColor("m_ctx", params, ctx);
    const len = (t.input ?? 0) + (t.cacheCreation ?? 0) + (t.cacheRead ?? 0);
    if (len === 0) return placeholderWithColor("m_ctx", params, ctx);
    return wrapPlain(
      `ctx:${formatCompactToken(len)}`,
      params.color as string | undefined,
    );
  },
  m_cacheHitRate: (params, ctx) => {
    const sid = ctx.tokens?.sessionId;
    if (!sid) return placeholderWithColor("m_cacheHitRate", params, ctx);
    // v0.4.0+ session-aggregate formula:
    //   sumCacheRead / (sumCacheRead + sumIn) * 100
    // Mirrors the totals modules: prime the accumulator from this
    // tick's delta so peekAvg reflects this turn even when cacheHitRate
    // is the only per-API-call module in the template.
    const r = computeAndCacheTickDelta(ctx);
    if (r.writeBack && sid) setPrevTick(sid, r.writeBack);
    if (r.hasDelta && !_tickAvgWriteMemo.get(ctx)) {
      _tickAvgWriteMemo.set(ctx, true);
      const prev = peekAvg(sid);
      const next: AvgSnapshot = {
        sumIn: (prev?.sumIn ?? 0) + r.deltaIn,
        sumOut: (prev?.sumOut ?? 0) + r.deltaOut,
        sumApi: (prev?.sumApi ?? 0) + r.deltaApi,
        sumCache: (prev?.sumCache ?? 0) + r.deltaCacheRead,
      };
      setAvg(sid, next);
    }
    const avg = peekAvg(sid);
    if (!avg) return placeholderWithColor("m_cacheHitRate", params, ctx);
    const denom = avg.sumCache + avg.sumIn;
    if (denom === 0) return placeholderWithColor("m_cacheHitRate", params, ctx);
    const pct = (avg.sumCache / denom) * 100;
    const color = (params.color as string | undefined) ?? cacheHitColor(pct);
    return `${color}hit:${pct.toFixed(cachePctPrecision())}%${RESET}`;
  },
  m_cacheRead: (params, ctx) => {
    const t = ctx.tokens?.current;
    if (!t) return placeholderWithColor("m_cacheRead", params, ctx);
    const read = t.cacheRead ?? 0;
    if (read === 0) return placeholderWithColor("m_cacheRead", params, ctx);
    const denom = (t.input ?? 0) + read + (t.cacheCreation ?? 0);
    const pct = denom > 0 ? (read / denom) * 100 : null;
    const label = formatCompactToken(read);
    const color = (params.color as string | undefined) ?? STALE_COLOR;
    return pct == null
      ? `${color}cache:${label}${RESET}`
      : `${color}cache:${label} (${pct.toFixed(cachePctPrecision())}%)${RESET}`;
  },
  m_token5h: (params, ctx) => {
    const body = windowedTokenLabel(ctx, 5 * 60 * 60 * 1000, "5h");
    if (body == null) return placeholderWithColor("m_token5h", params, ctx);
    return wrapPlain(body, params.color as string | undefined);
  },
  m_token7d: (params, ctx) => {
    const body = windowedTokenLabel(ctx, 7 * 24 * 60 * 60 * 1000, "7d");
    if (body == null) return placeholderWithColor("m_token7d", params, ctx);
    return wrapPlain(body, params.color as string | undefined);
  },
  // v0.4.0+ — :color:scale (or no :color: at all) → 5-band
  // scale color on the active tick, STALE_COLOR on the
  // cached/inactive tick. :color:<shortcut|SGR> → that exact
  // color on the active tick, STALE_COLOR on the cached
  // tick (per the user's "inactive 不受 :color: 影响"
  // decision — gray is the canonical "stale" signal).
  m_tokenInSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "in", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("in", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "in", activeColor);
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack);
    return r.value;
  },
  m_tokenOutSpeed: (params, ctx) => {
    const probe = computeTickSpeed(ctx, "out", STALE_COLOR);
    const userColor = params.color as string | undefined;
    const activeColor =
      userColor === SCALE_COLOR_SENTINEL || userColor == null
        ? speedScaleColor("out", probe.tps ?? 0)
        : (userColor ?? STALE_COLOR);
    const r = computeTickSpeed(ctx, "out", activeColor);
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack);
    return r.value;
  },
  m_tokenInAvg: (params, ctx) => {
    const color = (params.color as string | undefined) ?? STALE_COLOR;
    const r = computeTickAvg(ctx, "in", color);
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack);
    return r.value;
  },
  m_tokenOutAvg: (params, ctx) => {
    const color = (params.color as string | undefined) ?? STALE_COLOR;
    const r = computeTickAvg(ctx, "out", color);
    if (r.writeBack && ctx.tokens?.sessionId) setPrevTick(ctx.tokens.sessionId, r.writeBack);
    return r.value;
  },
  m_totalTokenIn: (params, ctx) => {
    const body = computeTickTotals(ctx, "in").value;
    return wrapPlain(body, params.color as string | undefined);
  },
  m_totalTokenOut: (params, ctx) => {
    const body = computeTickTotals(ctx, "out").value;
    return wrapPlain(body, params.color as string | undefined);
  },
  m_totalTokenWithCacheIn: (params, ctx) => {
    const body = computeTickTotals(ctx, "cache").value;
    return wrapPlain(body, params.color as string | undefined);
  },
  m_quote: (params, ctx) => {
    // Default freq = 1h (per-hour window). The schema resolver
    // already shape-validated the raw string; we now parse it
    // into a QuoteFreq {count, unit, ms} object that quoteIndex
    // and pickQuote need. params.freq is undefined when the
    // token is just `m_quote` or `m_quote:color:red` (no freq
    // segment). On a malformed-but-shape-valid string we
    // INLINE_BADARG here; in practice parseFreq rejects the
    // same set the resolver does.
    const raw = params.freq as string | undefined;
    const parsed: QuoteFreq | null = parseFreq(raw ?? "h");
    if (!parsed) return INLINE_BADARG;
    const seed = quoteIndex(parsed, ctx.nowMs);
    const text = pickQuote(parsed, ctx.nowMs);
    if (text === "") return null;
    const color = decodeColorParam(params.color as string | undefined);
    return applyColor(text, color, seed);
  },
  // v0.4.0+ — session-info / metadata inline renderers. All mirror
  // their MODULES counterparts but accept an optional :color: override.
  m_session: (params, ctx) => {
    const s = ctx.tokens?.sessionName;
    if (s == null) return placeholderWithColor("m_session", params, ctx);
    return wrapPlain(s, params.color as string | undefined);
  },
  m_model: (params, ctx) => {
    const s = ctx.tokens?.modelDisplayName;
    if (s == null) return placeholderWithColor("m_model", params, ctx);
    return wrapPlain(s, params.color as string | undefined);
  },
  m_effort: (params, ctx) => {
    const s = ctx.tokens?.effort;
    if (s == null) return placeholderWithColor("m_effort", params, ctx);
    return wrapPlain(s, params.color as string | undefined);
  },
  m_repo: (params, ctx) => {
    const r = ctx.tokens?.repo;
    if (!r) return placeholderWithColor("m_repo", params, ctx);
    const parts = [r.host, r.owner, r.name].filter(
      (p): p is string => p != null && p.length > 0,
    );
    if (parts.length === 0) return placeholderWithColor("m_repo", params, ctx);
    return wrapPlain(parts.join("/"), params.color as string | undefined);
  },
  m_ccVersion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccVersion", params, ctx);
    return wrapPlain(v, params.color as string | undefined);
  },
  // Deprecated alias — same body as m_ccVersion.
  m_ccversion: (params, ctx) => {
    const v = ctx.tokens?.ccversion;
    if (v == null) return placeholderWithColor("m_ccversion", params, ctx);
    return wrapPlain(v, params.color as string | undefined);
  },
  m_sessionDuration: (params, ctx) => {
    const ms = ctx.tokens?.cost.totalDurationMs;
    if (ms == null) return placeholderWithColor("m_sessionDuration", params, ctx);
    return wrapPlain(formatRemainingMs(ms), params.color as string | undefined);
  },
  m_sessionApiDuration: (params, ctx) => {
    const ms = ctx.tokens?.cost.totalApiDurationMs;
    if (ms == null) return placeholderWithColor("m_sessionApiDuration", params, ctx);
    return wrapPlain(formatRemainingMs(ms), params.color as string | undefined);
  },
  m_linesAdded: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesAdded;
    if (n == null) return placeholderWithColor("m_linesAdded", params, ctx);
    return wrapPlain(`+ ${n}`, params.color as string | undefined);
  },
  m_linesRemoved: (params, ctx) => {
    const n = ctx.tokens?.cost.totalLinesRemoved;
    if (n == null) return placeholderWithColor("m_linesRemoved", params, ctx);
    return wrapPlain(`- ${n}`, params.color as string | undefined);
  },
  m_tokenInTotal: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.input == null) return placeholderWithColor("m_tokenInTotal", params, ctx);
    return wrapPlain(
      `in:${formatCompactToken(t.totals.input)}`,
      params.color as string | undefined,
    );
  },
  m_tokenOutTotal: (params, ctx) => {
    const t = ctx.tokens;
    if (!t || t.totals.output == null) return placeholderWithColor("m_tokenOutTotal", params, ctx);
    return wrapPlain(
      `out:${formatCompactToken(t.totals.output)}`,
      params.color as string | undefined,
    );
  },
  m_contextSize: (params, ctx) => {
    const sz = ctx.tokens?.contextWindow?.size;
    if (sz == null) return placeholderWithColor("m_contextSize", params, ctx);
    return wrapPlain(formatCompactToken(sz), params.color as string | undefined);
  },
  m_contextUsed: (params, ctx) => {
    const pct = ctx.tokens?.contextWindow?.usedPct;
    if (pct == null) return placeholderWithColor("m_contextUsed", params, ctx);
    return wrapPlain(`${pct}%`, params.color as string | undefined);
  },
  m_windowContext: (params, ctx) => {
    if (!ctx.contextWindow) return placeholderWithColor("m_windowContext", params, ctx);
    const mode = (params.display as DisplayMode | undefined) ?? ctx.mode;
    const color = params.color as string | undefined;
    if (color) return formatOneChunkColored(ctx.contextWindow, mode, color);
    return formatOneChunk(ctx.contextWindow, mode);
  },
};

// Extract the `m_tokenTotal` body as a pure helper so the inline
// renderer can call it without duplicating the computation.
function inlineTokenTotalLabel(ctx: RenderContext): string | null {
  const t = ctx.tokens;
  if (!t) return null;
  const inT = t.totals.input ?? 0;
  const outT = t.totals.output ?? 0;
  const cache = (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
  return `tot:${formatCompactToken(inT + outT + cache)}`;
}

// Same for `m_tokenSession`.
function inlineTokenSessionLabel(ctx: RenderContext): string | null {
  const t = ctx.tokens;
  if (!t) return null;
  const inT = t.totals.input ?? 0;
  const outT = t.totals.output ?? 0;
  const cache = (t.current.cacheCreation ?? 0) + (t.current.cacheRead ?? 0);
  return `session:${formatCompactToken(inT + outT + cache)}`;
}

// Parse the colon-delimited remainder after a token prefix into a
// `{ param: value }` object. Pure; no side effects.
//
// Layout:
//   - If the schema has an `implicit` param, the FIRST segment is its
//     value. Remaining segments (if any) must form name:value pairs.
//   - If the schema has no `implicit`, the FIRST segment (if any) must
//     be a name in `named` — i.e. segment 0 is the name of a pair,
//     segment 1 is its value, etc.
//
// Returns null on:
//   - any resolver returning null (bad value)
//   - unknown param name in the named section
//   - odd number of named segments (last segment has no value)
function parseInlineArgs(
  remainder: string,
  schema: InlineSchema,
): Record<string, ResolvedValue> | null {
  if (remainder === "") {
    // Empty remainder with an implicit param means "missing required
    // param" → null. Empty remainder without an implicit is fine.
    return schema.implicit ? null : {};
  }
  const parts = remainder.split(":");

  let out: Record<string, ResolvedValue> = {};
  let startIdx = 0;

  if (schema.implicit) {
    const v = parts[0]!;
    const r = schema.implicit.resolver(v);
    if (r === null) return null;
    out[schema.implicit.name] = r;
    startIdx = 1;
  }

  // Trailing segments must form name:value pairs (even count).
  const tail = parts.length - startIdx;
  if (tail % 2 !== 0) return null;
  for (let i = startIdx; i < parts.length; i += 2) {
    const name = parts[i]!;
    const raw = parts[i + 1]!;
    if (!(name in schema.named)) return null;
    const r = schema.named[name]!(raw);
    if (r === null) return null;
    out[name] = r;
  }
  return out;
}

// Try to expand an inline-args token. Returns one of:
//   - { kind: "ok",     value }    — chunk text (possibly empty)
//   - { kind: "badarg" }            — parse failed (warn + drop)
//   - undefined                     — no schema for this prefix (caller
//                                     falls through to the unknown-module
//                                     path; rare — only fires when a
//                                     typo slips past the dispatcher).
//
// `key` is the bare prefix (used as the schema/renderer lookup key —
// no trailing colon). `skipLen` is how many characters of the token
// to consume before the remainder starts.
//
// v0.3.4+ — distinguish parse failure from "renderer returned null
// for valid args but missing data". Previously the dispatcher warned
// on ANY null return, which made modules like m_tokenOut (returns
// null when stdin lacks total_output_tokens) wrongly warn on the
// "unknown lineTemplate module" path.
type InlineResult =
  | { kind: "ok"; value: string | null }
  | { kind: "badarg" };

function expandInlineToken(
  tok: string,
  key: string,
  skipLen: number,
  ctx: RenderContext,
): InlineResult | undefined {
  const schema = INLINE_SCHEMAS[key];
  if (schema === undefined) return undefined;
  const params = parseInlineArgs(tok.slice(skipLen), schema);
  if (params === null) return { kind: "badarg" };
  const rendered = INLINE_RENDERERS[key]!(params, ctx);
  if (rendered === INLINE_BADARG) return { kind: "badarg" };
  return { kind: "ok", value: rendered };
}

export function renderTemplate(template: readonly string[], ctx: RenderContext): string[] {
  const seps = cfg().separators;
  const lines: string[] = [];
  let current = "";
  for (let i = 0; i < template.length; i++) {
    const tok = template[i];
    if (tok == null) continue;
    let piece: string | null = null;
    // v0.3.3+ — inline-args tokens (s_<n>:…, m_label:…, m_modeLabel:…,
    // and every other m_<name>:…). Only fire when the token contains
    // ":" so the bare forms (s_0, m_modeLabel, m_window5h, …) keep
    // routing through MODULES as before.
    if (tok.includes(":")) {
      // The prefix → key/skipLen table. Keep them in sync with the
      // INLINE_SCHEMAS / INLINE_RENDERERS entries above. A typo here
      // means the token silently routes through MODULES (which won't
      // match the literal colon-bearing string) and falls through
      // to the unknown-module warn.
      let inline: InlineResult | undefined;
      if (tok.startsWith("s_")) {
        // s_<n>:… → skip "s_" (length 2), remainder starts at the index.
        inline = expandInlineToken(tok, "s_", 2, ctx);
      } else if (tok.startsWith("m_label:")) {
        // m_label:<args> → skip "m_label:" (length 8), remainder starts
        // at the string value.
        inline = expandInlineToken(tok, "m_label", 8, ctx);
      } else if (tok.startsWith("m_modeLabel:")) {
        // m_modeLabel:<args> → skip "m_modeLabel:" (length 12).
        inline = expandInlineToken(tok, "m_modeLabel", 12, ctx);
      } else if (tok.startsWith("m_window5h:")) {
        // m_window5h:color:<c> → skip "m_window5h:" (length 11).
        inline = expandInlineToken(tok, "m_window5h", 11, ctx);
      } else if (tok.startsWith("m_window7d:")) {
        inline = expandInlineToken(tok, "m_window7d", 11, ctx);
      } else if (tok.startsWith("m_countdown5h:")) {
        inline = expandInlineToken(tok, "m_countdown5h", 14, ctx);
      } else if (tok.startsWith("m_countdown7d:")) {
        inline = expandInlineToken(tok, "m_countdown7d", 14, ctx);
      } else if (tok.startsWith("m_balance:")) {
        inline = expandInlineToken(tok, "m_balance", 10, ctx);
      } else if (tok.startsWith("m_age:")) {
        inline = expandInlineToken(tok, "m_age", 6, ctx);
      } else if (tok.startsWith("m_version:")) {
        inline = expandInlineToken(tok, "m_version", 10, ctx);
      } else if (tok.startsWith("m_tokenIn:")) {
        inline = expandInlineToken(tok, "m_tokenIn", 10, ctx);
      } else if (tok.startsWith("m_tokenOut:")) {
        inline = expandInlineToken(tok, "m_tokenOut", 11, ctx);
      } else if (tok.startsWith("m_tokenInTotal:")) {
        // Longer prefix must come BEFORE m_tokenIn: would match first;
        // m_tokenIn: would shadow m_tokenInTotal:color:… if ordered
        // the other way. Same rationale for m_tokenOutTotal vs
        // m_tokenOut.
        inline = expandInlineToken(tok, "m_tokenInTotal", 15, ctx);
      } else if (tok.startsWith("m_tokenOutTotal:")) {
        inline = expandInlineToken(tok, "m_tokenOutTotal", 16, ctx);
      } else if (tok.startsWith("m_tokenTotal:")) {
        inline = expandInlineToken(tok, "m_tokenTotal", 13, ctx);
      } else if (tok.startsWith("m_tokenSession:")) {
        inline = expandInlineToken(tok, "m_tokenSession", 15, ctx);
      } else if (tok.startsWith("m_ctx:")) {
        inline = expandInlineToken(tok, "m_ctx", 6, ctx);
      } else if (tok.startsWith("m_cacheHitRate:")) {
        inline = expandInlineToken(tok, "m_cacheHitRate", 15, ctx);
      } else if (tok.startsWith("m_cacheRead:")) {
        inline = expandInlineToken(tok, "m_cacheRead", 12, ctx);
      } else if (tok.startsWith("m_token5h:")) {
        inline = expandInlineToken(tok, "m_token5h", 10, ctx);
      } else if (tok.startsWith("m_token7d:")) {
        inline = expandInlineToken(tok, "m_token7d", 10, ctx);
      } else if (tok.startsWith("m_tokenInSpeed:")) {
        inline = expandInlineToken(tok, "m_tokenInSpeed", 15, ctx);
      } else if (tok.startsWith("m_tokenOutSpeed:")) {
        inline = expandInlineToken(tok, "m_tokenOutSpeed", 16, ctx);
      } else if (tok.startsWith("m_tokenInAvg:")) {
        // m_tokenInAvg:color:<…> → skip "m_tokenInAvg:" (length 14).
        // No prefix-shadowing conflict with m_tokenIn: above
        // (different char at index 10: 'A' vs ':'), but listed
        // here with the other speed-family modules for source
        // cohesion.
        inline = expandInlineToken(tok, "m_tokenInAvg", 14, ctx);
      } else if (tok.startsWith("m_tokenOutAvg:")) {
        inline = expandInlineToken(tok, "m_tokenOutAvg", 15, ctx);
      } else if (tok.startsWith("m_totalTokenWithCacheIn:")) {
        // Longer prefix listed first defensively — no actual
        // shadowing because the only other m_totalToken* prefixes
        // have different chars at index 17 (W vs I / O).
        inline = expandInlineToken(
          tok,
          "m_totalTokenWithCacheIn",
          25,
          ctx,
        );
      } else if (tok.startsWith("m_totalTokenIn:")) {
        // m_totalTokenIn: → skip the 15-char prefix INCLUDING the
        // trailing colon, so the remainder starts at the value.
        inline = expandInlineToken(tok, "m_totalTokenIn", 15, ctx);
      } else if (tok.startsWith("m_totalTokenOut:")) {
        inline = expandInlineToken(tok, "m_totalTokenOut", 16, ctx);
      } else if (tok.startsWith("m_quote:")) {
        // m_quote:freq:<…>:color:<…> → skip "m_quote:" (length 8).
        inline = expandInlineToken(tok, "m_quote", 8, ctx);
      } else if (tok.startsWith("m_session:")) {
        inline = expandInlineToken(tok, "m_session", 10, ctx);
      } else if (tok.startsWith("m_model:")) {
        inline = expandInlineToken(tok, "m_model", 8, ctx);
      } else if (tok.startsWith("m_effort:")) {
        inline = expandInlineToken(tok, "m_effort", 9, ctx);
      } else if (tok.startsWith("m_repo:")) {
        inline = expandInlineToken(tok, "m_repo", 7, ctx);
      } else if (tok.startsWith("m_ccVersion:")) {
        // m_ccVersion:color:<c> → skip "m_ccVersion:" (length 12).
        inline = expandInlineToken(tok, "m_ccVersion", 12, ctx);
      } else if (tok.startsWith("m_ccversion:")) {
        // Deprecated alias — same dispatch as m_ccVersion: above.
        // Pre-rename configs may still use the lowercase form.
        inline = expandInlineToken(tok, "m_ccversion", 12, ctx);
      } else if (tok.startsWith("m_sessionApiDuration:")) {
        // Longer prefix must come BEFORE m_sessionDuration: for the
        // same prefix-shadowing reason as the m_tokenIn family.
        inline = expandInlineToken(tok, "m_sessionApiDuration", 21, ctx);
      } else if (tok.startsWith("m_sessionDuration:")) {
        inline = expandInlineToken(tok, "m_sessionDuration", 18, ctx);
      } else if (tok.startsWith("m_linesAdded:")) {
        inline = expandInlineToken(tok, "m_linesAdded", 13, ctx);
      } else if (tok.startsWith("m_linesRemoved:")) {
        // m_linesRemoved:color:<c> → skip "m_linesRemoved:" (length 15).
        inline = expandInlineToken(tok, "m_linesRemoved", 15, ctx);
      } else if (tok.startsWith("m_contextSize:")) {
        inline = expandInlineToken(tok, "m_contextSize", 14, ctx);
      } else if (tok.startsWith("m_contextUsed:")) {
        inline = expandInlineToken(tok, "m_contextUsed", 14, ctx);
      } else if (tok.startsWith("m_windowContext:")) {
        inline = expandInlineToken(tok, "m_windowContext", 16, ctx);
      }
      // Parse failure (bad :color:, unknown param, odd segment count)
      // → warn + drop. Renderer returning null for valid args (e.g.
      // m_tokenOut when stdin lacks total_output_tokens) is NOT a
      // parse failure — silently skip the chunk, same as the bare
      // MODULES path. (v0.3.4+: previously we conflated the two
      // and wrongly warned "unknown module" on missing data.)
      if (inline?.kind === "badarg") {
        warnUnknownModuleOnce(tok);
        continue;
      }
      piece = inline?.kind === "ok" ? inline.value : null;
    } else if (tok.startsWith("s_")) {
      // Bare s_<n>: legacy fast path. Inline-args (with optional
      // color:) handles the `s_<n>` token via the new path above; the
      // branch below only fires for the no-colon shorthand.
      const n = Number(tok.slice(2));
      if (!Number.isInteger(n) || n < 0) {
        warnUnknownModuleOnce(tok);
        continue;
      }
      if (n >= seps.length) {
        warnUnknownModuleOnce(tok);
        continue;
      }
      piece = seps[n];
    } else if (tok.startsWith("m_")) {
      const mod = MODULES[tok];
      if (!mod) {
        warnUnknownModuleOnce(tok);
        continue;
      }
      piece = mod(ctx);
    } else {
      warnUnknownModuleOnce(tok);
      continue;
    }
    if (piece == null || piece === "") continue;
    // Split the piece on '\n' so a "\n" separator or a future module
    // that embeds newlines naturally produces multi-line output. The
    // first segment is appended to the in-progress current line; any
    // further segments start a new line (and the trailing one keeps
    // the new "current" line for the next piece to append to).
    const segments = piece.split("\n");
    for (let j = 0; j < segments.length; j++) {
      const seg = segments[j]!;
      if (j === 0) {
        current += seg;
      } else {
        // Push the completed line and start a new one. Skip empty
        // lines that arise from consecutive "\n\n" splits.
        if (current.length > 0) lines.push(current);
        current = seg;
      }
    }
  }
  // Flush whatever's left in the in-progress line.
  if (current.length > 0) lines.push(current);
  return lines;
}

// Top-level renderer used by dispatch.ts. Selects the right template
// for the provider, builds the context, and — critically — force-
// appends the m_age stale suffix when the result is `stale` AND the
// template didn't already emit it. This preserves the v0.2.16
// invariant that a stale-on-error tick always carries a visible
// broken-chain indicator, regardless of what the user put in their
// lineTemplate.
export function renderProviderLine(
  provider: import("./types.ts").Provider,
  ctx: Omit<RenderContext, "fiveHour" | "weekly" | "balance" | "tokens" | "contextWindow"> & {
    fiveHour?: Window | null;
    weekly?: Window | null;
    balance?: BalanceLike | null;
    // v0.4.0+ — optional for back-compat with tests/callers that
    // don't thread a TokenSnapshot. Defaults to null, which causes
    // all m_token* modules to skip rendering.
    tokens?: TokenSnapshot | null;
    // v0.4.0+ — optional. Synthesized from tokens.contextWindow.usedPct
    // when omitted. Only read by m_windowContext.
    contextWindow?: Window | null;
  },
): string {
  // v0.4.0+ — synthesize the contextWindow Window from
  // tokens.contextWindow.usedPct when not supplied. formatOneChunk
  // only reads `pct`, so this minimal shape is enough.
  const usedPct = ctx.tokens?.contextWindow?.usedPct;
  const contextWindow =
    ctx.contextWindow !== undefined
      ? ctx.contextWindow
      : usedPct != null
        ? { pct: usedPct }
        : null;
  const fullCtx: RenderContext = {
    mode: ctx.mode,
    nowMs: ctx.nowMs,
    fiveHour: ctx.fiveHour ?? null,
    weekly: ctx.weekly ?? null,
    balance: ctx.balance ?? null,
    ageMs: ctx.ageMs,
    stale: ctx.stale,
    version: ctx.version,
    tokens: ctx.tokens ?? null,
    contextWindow,
  };
  // v0.2.21: template picked by provider TYPE via providers.ts, not
  // by provider-name literal. Same outward behavior — defaults put
  // TOKEN_PLAN at "plan" and BALANCE at "balance" — but the
  // indirection lets a third provider slot in without code changes.
  const templateKey = templateKeyForProvider(provider);
  const template = cfg().lineTemplate[templateKey];
  const lines = renderTemplate(template, fullCtx);
  // Forced visibility for the age annotation (stale-only fallback):
  // when the user did NOT put m_age in their lineTemplate AND the
  // fetch was stale, append the broken-chain suffix to the rendered
  // line. This preserves the v0.2.16 invariant that a network
  // failure is always visible, no matter what the user put in their
  // template.
  //
  // Dedup is template-level: check whether "m_age" appears in the
  // template tokens directly, rather than scanning the rendered
  // output for " ago" (which would misfire if a separator string
  // happens to contain " ago" or anything overlapping with
  // formatStaleSuffix's output tail).
  //
  // v0.3.3+ also accepts the inline-args form "m_age:color:…" — the
  // renderer would still emit the chunk, so we must treat that as
  // "m_age is present" too. Match by prefix instead of by exact
  // string equality.
  const templateHasAgeModule = template.some(
    (tok) => tok === "m_age" || tok.startsWith("m_age:"),
  );
  if (ctx.ageMs != null && ctx.stale && !templateHasAgeModule) {
    const suffix = formatStaleSuffix(ctx.ageMs, false);
    // The suffix carries its own SGR close, so it slots onto the
    // last line regardless of how many lines the template emitted.
    if (lines.length === 0) {
      lines.push(suffix);
    } else {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + suffix;
    }
  }
  return lines.join("\n");
}
