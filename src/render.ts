// Pure rendering helpers: percentage, ASCII bar, ANSI coloring, line assembly.

export type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp string when the window resets, if known.
  resetAt?: string | null;
};

export type DisplayMode = "remaining" | "used";

const RESET = "\x1b[0m";

// 256-color SGR sequences — chosen for legibility on both light and dark
// terminals (the default 16-color green is muddy on dark backgrounds, and
// the 16-color set has no orange at all).
const GREEN = "\x1b[38;5;41m"; // #00d787 — bright green
const YELLOW = "\x1b[38;5;220m"; // #ffd75f — warm yellow
const ORANGE = "\x1b[38;5;208m"; // #ff8700 — true orange
const RED = "\x1b[38;5;196m"; // #ff5f5f — clear red

// 4-band color thresholds applied to the **displayed** value.
// Displayed value = remaining% (mode="remaining") or used% (mode="used").
// Thresholds therefore have the SAME numeric meaning in both modes — only
// the sign of the metric is flipped.
const COLOR_THRESHOLDS = {
  green: 40, // displayed value below this → green
  yellow: 60, // below this → yellow
  orange: 80, // below this → orange; otherwise red
} as const;

export function colorFor(displayedPct: number): string {
  const v = Math.max(0, Math.min(100, displayedPct));
  if (v < COLOR_THRESHOLDS.green) return GREEN;
  if (v < COLOR_THRESHOLDS.yellow) return YELLOW;
  if (v < COLOR_THRESHOLDS.orange) return ORANGE;
  return RED;
}

export function pctBar(usedPctValue: number, width = 8): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(100, usedPctValue));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  return {
    filled: "▓".repeat(filledCount),
    empty: "░".repeat(emptyCount),
  };
}

function formatOne(
  label: string,
  w: Window,
  mode: DisplayMode,
  width = 8,
  nowMs: number = Date.now()
): string {
  // Compute the value to display based on mode. "remaining" shows what's
  // left (more = healthier); "used" shows what's consumed (less = healthier).
  // The bar is always drawn against the USED percentage (filled blocks
  // intuitively mean "consumed").
  const usedPct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const displayedPct = mode === "remaining" ? 100 - usedPct : usedPct;

  const { filled, empty } = pctBar(usedPct, width);
  const color = colorFor(displayedPct);
  // Color wraps just the filled portion + the displayed percentage number,
  // so the empty bar stays readable in any terminal.
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  return `${label} ${color}${filled}${RESET}${empty} ${color}${displayedPct}%${RESET}${resetSuffix}`;
}

// Compact "remaining time until reset" formatter. Returns e.g. "(2h3m↻)"
// or "" when reset info is missing or already past. Drops the leading unit
// when it is zero; minimum unit is minutes.
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
  const text = shown.map(([v, u]) => `${v}${u}`).join("");
  return `(${text}↻)`;
}

// Parse the TOKENPLAN_DISPLAY env var (or any caller-provided string) into a
// DisplayMode. Defaults to "remaining" on anything unrecognized.
export function resolveDisplayMode(value: string | undefined | null): DisplayMode {
  if (value && value.toLowerCase() === "used") return "used";
  return "remaining";
}

export function formatLine(
  fiveHour: Window,
  weekly: Window,
  mode: DisplayMode = "remaining",
  nowMs: number = Date.now()
): string {
  return `${formatOne("5h", fiveHour, mode, 8, nowMs)} · ${formatOne("wk", weekly, mode, 8, nowMs)}`;
}