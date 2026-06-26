// Pure rendering helpers: split-bar (left colorless / right colored),
// 5-band thresholds, ANSI coloring, and line assembly.
//
// All tunable values (colors, thresholds, bar geometry, currency
// prefixes, display-mode labels, stale annotation formatting) come
// from the singleton in ./config.ts. The defaults in config.ts match
// today's hardcoded values exactly.

import { configStore } from "./config.ts";

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

function formatOne(
  windowLabel: string,
  w: Window,
  mode: DisplayMode,
  width = cfg().bar.width,
  nowMs: number = Date.now(),
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;

  const bar = splitBar(usedPct, mode, width);
  // Two pieces: the countdown (e.g. "2h3m") and the arrow (e.g. "🕛").
  // Both are derived from the same Window + nowMs; the arrow is the
  // single thing we always have even when the countdown is empty
  // (e.g. "<1m" or just the arrow alone if resetAt is present but
  // remaining is 0). Template:
  //   resetAt present → " (<countdown><arrow> <windowLabel>)"
  //   resetAt missing  → " <windowLabel>" (DeepSeek / legacy — no
  //   reset info at all, don't fake it with a default arrow)
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  const arrow = pickResetArrow(nowMs, w.resetStartAt, w.resetDurationMs);
  const tail = w.resetAt
    ? ` (${resetSuffix}${arrow} ${windowLabel})`
    : ` ${windowLabel}`;
  return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}${tail}`;
}

// Compact "remaining time until reset" formatter. Returns the countdown
// portion of the reset annotation (no arrow, no parens) — e.g. "2h3m",
// "<1m" for sub-minute, or "0m" for past-due. The caller (`formatOne`)
// appends the window label and the fill-state arrow glyph picked by
// `pickResetArrow`.
//
// Rules (per the v0.2.11 design):
//   - Past-due (remainingMs <= 0): "0m" / "0s" depending on minUnit, so
//     the user sees an explicit "this window has reset" signal.
//   - Sub-minUnit (>0 but < 1 unit): "<1m" / "<1s" — visually distinct
//     from "0m" so a window about to reset isn't confused with one
//     already reset.
//   - ≥ 1 unit: drop LEADING zero units, keep up to maxUnitCount units
//     from the start (including any internal/trailing zeros —
//     "2h0m" stays "2h0m", NOT "2h"). maxUnitCount default = 2.
//     Examples:
//       1d2h3m4s maxUnitCount=2 → "1d2h"
//       2h3m4s   maxUnitCount=2 → "2h3m"
//       2h0m4s   maxUnitCount=2 → "2h0m"
//       0d0h5m   maxUnitCount=2 → "5m"
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
// `1d2h3m4s` style countdown, respecting `stale.minUnit` for the
// sub-unit threshold and `stale.maxUnitCount` for the slice length.
// Clamped to a non-negative result — callers that need past-due
// handling should special-case `remainingMs <= 0` themselves.
export function formatRemainingMs(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "";

  const minUnit = cfg().stale.minUnit;
  const maxUnitCount = Math.max(
    1,
    Math.min(4, Math.floor(cfg().stale.maxUnitCount)),
  );

  // Past-due: explicit "0m" / "0s" so the user sees a clear "this
  // window has reset" signal — distinct from "<1m" which means
  // "less than 1 minute left" (i.e. about to reset).
  if (remainingMs <= 0) return minUnit === "s" ? "0s" : "0m";

  const totalSeconds = Math.floor(remainingMs / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const seconds = totalSeconds % 60;

  // Sub-minUnit handling: > 0 but less than 1 unit of minUnit →
  // "<1unit" floor. Wins over maxUnitCount — "<1unit" is the truth.
  if (minUnit === "m" && totalMinutes === 0) return "<1m";
  if (minUnit === "s" && totalMinutes === 0) return `${seconds}s`;

  // ≥ 1 unit: drop leading zero units (so `0d0h5m` → `5m`, not `0d0h5m`),
  // keep up to maxUnitCount units from the start (including internal /
  // trailing zeros — `2h0m` stays `2h0m`). The countdown always uses
  // d/h/m granularity; minUnit only affects the sub-unit floor above.
  const allUnits: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [minutes, "m"],
  ];
  let leadingZeroCount = 0;
  while (
    leadingZeroCount < allUnits.length &&
    allUnits[leadingZeroCount][0] === 0
  ) {
    leadingZeroCount++;
  }
  const shown = allUnits.slice(leadingZeroCount, leadingZeroCount + maxUnitCount);
  // Unreachable: the <= 0 branch above already returned for past-due,
  // and we just verified totalMinutes > 0 in the sub-minute floor above.
  // The slice will always have at least one element.
  return shown.map(([v, u]) => `${v}${u}`).join("");
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
  const arrows = cfg().stale.resetArrows;
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

// Compact "age of cached value" formatter for the stale-on-error annotation.
// Returns e.g. "⛓️‍💥 5m ago" / "⛓️‍💥 1h30m ago" / "⛓️‍💥 1d5h ago",
// already SGR-wrapped in STALE_COLOR and RESET-terminated. Returns ""
// when ageMs is not positive.
//
// Per the v0.2.11 design, the broken-chain emoji IS the indicator
// (no leading "· " separator) — it visually announces the network
// failure. The X time itself uses minutes as the smallest unit
// (seconds never appear) and the same maxUnitCount rules as the
// reset countdown: drop leading zeros, keep internal/trailing zeros
// up to the configured count.
//
// Sub-minute remainder rounds UP to 1m so we never see "0m ago",
// which would look like the cache hasn't actually moved.
export function formatStaleSuffix(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return "";
  const emoji = cfg().stale.ageEmoji.broken;

  // Sub-minute: round up to 1 minute so we never see "0m ago".
  let totalMinutes = Math.floor(ageMs / 60_000);
  if (ageMs % 60_000 > 0) totalMinutes += 1;

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  // Build units in d/h/m order, drop leading zeros, take maxUnitCount.
  const maxUnitCount = Math.max(
    1,
    Math.min(4, Math.floor(cfg().stale.maxUnitCount)),
  );
  const allUnits: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [minutes, "m"],
  ];
  let leadingZeroCount = 0;
  while (
    leadingZeroCount < allUnits.length &&
    allUnits[leadingZeroCount][0] === 0
  ) {
    leadingZeroCount++;
  }
  const shown = allUnits.slice(leadingZeroCount, leadingZeroCount + maxUnitCount);
  const label = `${shown.map(([v, u]) => `${v}${u}`).join("")} ago`;
  return `${STALE_COLOR}${emoji} ${label}${RESET}`;
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
  staleMs?: number,
): string {
  const modeLabel = cfg().modeLabels[mode];
  const base = `${modeLabel} ${formatOne("5h", fiveHour, mode, undefined, nowMs)} · ${formatOne("7d", weekly, mode, undefined, nowMs)}`;
  return base + (staleMs ? formatStaleSuffix(staleMs) : "");
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

export function formatBalanceLine(b: BalanceLike, staleMs?: number): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    // "not available!" is rendered for BOTH the original "API said no" branch
    // (is_available: false) and the "fetch failed and we have no cache" branch
    // upstream. Neither carries an age to report, so the stale suffix is
    // intentionally NOT appended here.
    return `Balance: ${RED}not available!${RESET}`;
  }
  const chunks = b.entries.map((e) => formatBalanceChunk(e.currency, e.totalBalance));
  // Color follows the LOWEST entry — most urgent currency drives the hue.
  const color = colorForBalance(b.minValue);
  const base = `Balance: ${color}${chunks.join(" · ")}${RESET}`;
  return base + (staleMs ? formatStaleSuffix(staleMs) : "");
}
