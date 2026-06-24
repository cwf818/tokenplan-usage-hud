// Pure rendering helpers: percentage, ASCII bar, ANSI coloring, line assembly.

export type Window = {
  // Percentage USED in [0, 100]. May be fractional; we'll round.
  pct: number;
  // ISO timestamp string when the window resets, if known.
  resetAt?: string | null;
};

const RESET = "\x1b[0m";

function colorFor(pct: number): string {
  // pct = percentage USED (0..100). More used → more concerning.
  // < 20% used = green (plenty of room)
  // 20..50% = yellow
  // > 50% = red
  if (pct < 20) return "\x1b[32m"; // green
  if (pct < 50) return "\x1b[33m"; // yellow
  return "\x1b[31m"; // red
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

function formatOne(label: string, w: Window, width = 8, nowMs: number = Date.now()): string {
  const pct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const { filled, empty } = pctBar(pct, width);
  const color = colorFor(pct);
  // Color wraps just the filled portion + the percentage number, so the
  // empty bar stays readable in any terminal.
  const resetSuffix = formatResetSuffix(w.resetAt, nowMs);
  return `${label} ${color}${filled}${RESET}${empty} ${color}${pct}%${RESET}${resetSuffix}`;
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

export function formatLine(fiveHour: Window, weekly: Window, nowMs: number = Date.now()): string {
  return `${formatOne("5h", fiveHour, 8, nowMs)} · ${formatOne("wk", weekly, 8, nowMs)}`;
}