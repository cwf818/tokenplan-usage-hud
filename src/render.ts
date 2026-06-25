// Pure rendering helpers: split-bar (left colorless / right colored),
// 5-band thresholds, ANSI coloring, and line assembly.

export type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp string when the window resets, if known.
  resetAt?: string | null;
};

export type DisplayMode = "remaining" | "used";

const RESET = "\x1b[0m";

// 256-color SGR sequences.
// "Dark green" is intentionally not too dark — closer to a forest/jade tone
// so it stays distinguishable from bright green but still readable on dark
// terminals.
const BRIGHT_GREEN = "\x1b[38;5;41m"; // #00d787
const DARK_GREEN = "\x1b[38;5;29m"; // #00af5f — forest/jade, not muddy
const YELLOW = "\x1b[38;5;220m"; // #ffd75f
const ORANGE = "\x1b[38;5;208m"; // #ff8700
const RED = "\x1b[38;5;196m"; // #ff5f5f

// 5-band thresholds applied to the **displayed** value (so remaining/used
// modes share the same numeric thresholds — only the meaning flips).
// In "remaining" mode the bands run high → low: bright green / dark green /
// yellow / orange / red, because more remaining = healthier. In "used" mode
// the bands run low → high: bright green / dark green / yellow / orange /
// red, because less used = healthier. We achieve this by indexing into the
// SAME 5-color palette from opposite ends.
const COLOR_THRESHOLDS = [20, 40, 60, 80] as const; // 4 boundaries → 5 bands

// 5-color palette indexed by band (0..4). In "remaining" mode, band 0
// (lowest remaining) gets RED and band 4 (most remaining) gets BRIGHT_GREEN.
// In "used" mode the mapping is reversed.
const PALETTE_BY_USED = [BRIGHT_GREEN, DARK_GREEN, YELLOW, ORANGE, RED] as const;

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
  const idx = bandIndex(displayedPct, COLOR_THRESHOLDS);
  if (mode === "remaining") {
    // Remaining: low remaining = bad. band 0 (lowest displayed) = red.
    return [RED, ORANGE, YELLOW, DARK_GREEN, BRIGHT_GREEN][idx];
  }
  // Used: low used = good. band 0 (lowest displayed) = bright green.
  return PALETTE_BY_USED[idx];
}

// Split-bar with a fixed positional layout:
//   [<USED cells>][<REMAINING cells>]
// USED cells use '▓', REMAINING cells use '░'. The side that gets COLORED
// depends on the mode:
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
  width = 8
): SplitBar {
  const used = Math.max(0, Math.min(100, usedPct));
  const remaining = 100 - used;

  // Color follows the DISPLAYED value (the number shown next to the bar).
  const displayed = mode === "remaining" ? remaining : used;
  const color = colorFor(displayed, mode);

  const coloredSize = Math.round((displayed / 100) * width);
  const plainSize = Math.max(0, width - coloredSize);

  // Fixed layout: left = used cells (▓), right = remaining cells (░).
  // Which side gets the color is decided by mode.
  if (mode === "used") {
    // Color the LEFT (the used ▓ cells).
    const left = "▓".repeat(coloredSize);
    const right = "░".repeat(plainSize);
    return {
      leftChunk: coloredSize > 0 ? `${color}${left}${RESET}` : "",
      rightChunk: right,
      color,
    };
  }
  // mode === "remaining"
  // Color the RIGHT (the remaining ░ cells).
  const left = "▓".repeat(plainSize);
  const right = "░".repeat(coloredSize);
  return {
    leftChunk: left,
    rightChunk: coloredSize > 0 ? `${color}${right}${RESET}` : "",
    color,
  };
}

// Backwards-compatible simple "filled on left" bar — exported for tests but
// not used by formatOne anymore.
export function pctBar(usedPctValue: number, width = 8): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, usedPctValue));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  return {
    filled: "▓".repeat(filledCount),
    empty: "░".repeat(emptyCount),
  };
}

const MODE_LABELS: Record<DisplayMode, string> = {
  remaining: "Remain:",
  used: "Usage:",
};

function formatOne(
  windowLabel: string,
  w: Window,
  mode: DisplayMode,
  width = 8,
  nowMs: number = Date.now()
): string {
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const remainingPct = 100 - usedPct;
  const displayedPct = mode === "remaining" ? remainingPct : usedPct;

  const bar = splitBar(usedPct, mode, width);
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);

  // Layout: "<bar> <coloredDisplayedPct>%<RESET> (<reset>↻ / <windowLabel>)"
  // Window label sits at the END of each segment, after the reset countdown,
  // separated by ' / '. When reset info is missing we still emit the label
  // (without the parentheses) so the segment isn't orphaned. The mode label
  // (Usage:/Remain:) is prepended once by formatLine.
  const tail = resetSuffix ? ` (${resetSuffix} / ${windowLabel})` : ` / ${windowLabel}`;
  return `${bar.leftChunk}${bar.rightChunk} ${bar.color}${displayedPct}%${RESET}${tail}`;
}

// Compact "remaining time until reset" formatter. Returns e.g. "2h3m↻"
// (no surrounding parens — the caller wraps the broader context) or "" when
// reset info is missing or already past. Drops the leading unit when it is
// zero; minimum unit is minutes.
export function formatResetSuffix(resetAt: string | null | undefined, nowMs: number = Date.now()): string {
  if (!resetAt) return "";
  const t = Date.parse(resetAt);
  if (!Number.isFinite(t)) return "";
  const remainingMs = t - nowMs;
  if (remainingMs <= 0) return "";

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  // Keep up to 2 non-zero units. Drop leading zero units.
  // Examples: 0d 0h 5m → "5m"; 1d 2h 3m → "1d2h"; 3d 5h 0m → "3d5h".
  const units: Array<[number, string]> = [
    [days, "d"],
    [hours, "h"],
    [minutes, "m"],
  ];
  const nonZero = units.filter(([v]) => v > 0);
  if (nonZero.length === 0) return "";
  const shown = nonZero.slice(0, 2);
  return shown.map(([v, u]) => `${v}${u}`).join("") + "↻";
}

// Parse the TOKENPLAN_DISPLAY env var (or any caller-provided string) into a
// DisplayMode. Defaults to "used" on anything unrecognized. Pass
// TOKENPLAN_DISPLAY=remaining to opt into remaining-mode.
export function resolveDisplayMode(value: string | undefined | null): DisplayMode {
  if (value && value.toLowerCase() === "remaining") return "remaining";
  return "used";
}

export function formatLine(
  fiveHour: Window,
  weekly: Window,
  mode: DisplayMode = "used",
  nowMs: number = Date.now()
): string {
  const modeLabel = MODE_LABELS[mode];
  return `${modeLabel} ${formatOne("5h", fiveHour, mode, 8, nowMs)} · ${formatOne("wk", weekly, mode, 8, nowMs)}`;
}

// ----- DeepSeek balance line -------------------------------------------------
//
// Distinct from the MiniMax percentage thresholds (0/20/40/60/80): a balance
// is an ABSOLUTE amount, not a percentage, so the bands live at 5/10/20/50
// (red / orange / yellow / dark green / bright green). Lower balance = more
// urgent, so the lowest band (red) corresponds to the LOWEST value — same
// intuitive direction as the "remaining" mode of the MiniMax render.

const BALANCE_THRESHOLDS = [5, 10, 20, 50] as const;
// Lowest value → RED, then orange → yellow → dark green → bright green.
const BALANCE_PALETTE = [RED, ORANGE, YELLOW, DARK_GREEN, BRIGHT_GREEN] as const;

function balanceBandIndex(value: number): number {
  for (let i = 0; i < BALANCE_THRESHOLDS.length; i++) {
    if (value < BALANCE_THRESHOLDS[i]) return i;
  }
  return BALANCE_THRESHOLDS.length; // top band
}

export function colorForBalance(value: number): string {
  const v = Math.max(0, value);
  return BALANCE_PALETTE[balanceBandIndex(v)];
}

// Format a single numeric value for display: integers as "100", floats as
// "110.00". Trim trailing zeros for cases like "110.10" → "110.1".
function formatBalanceValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  // toFixed(2) then strip trailing zeros and a dangling dot.
  return v.toFixed(2).replace(/\.?0+$/, "");
}

// One rendered chunk: `$/￥<value>`. The currency label is fixed by the
// user's spec — even though DeepSeek reports per-entry currencies, the
// display prefix is shared.
// Per-currency display prefix. The DeepSeek API may return any string in
// `currency`; we recognize the two common ones and fall back to the raw
// currency code for anything else (e.g. EUR → "EUR10.50"). Unknown
// currencies are still rendered (the user can see the code) rather than
// blanked, so a new provider currency never silently disappears.
function prefixForCurrency(currency: string): string {
  const upper = currency.toUpperCase();
  if (upper === "USD") return "$";
  if (upper === "CNY" || upper === "RMB") return "￥";
  // Default: show the currency code itself, uppercased.
  return upper || "￥";
}

function formatBalanceChunk(currency: string, v: number): string {
  return `${prefixForCurrency(currency)}${formatBalanceValue(v)}`;
}

export type BalanceLike = {
  isAvailable: boolean;
  entries: ReadonlyArray<{ currency: string; totalBalance: number }>;
  minValue: number | null;
};

export function formatBalanceLine(b: BalanceLike): string {
  if (!b.isAvailable || b.entries.length === 0 || b.minValue == null) {
    return `Balance: ${RED}not available!${RESET}`;
  }
  const chunks = b.entries.map((e) => formatBalanceChunk(e.currency, e.totalBalance));
  // Color follows the LOWEST entry — most urgent currency drives the hue.
  const color = colorForBalance(b.minValue);
  return `Balance: ${color}${chunks.join(" · ")}${RESET}`;
}