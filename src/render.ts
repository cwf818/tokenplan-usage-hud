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

function formatOne(label: string, w: Window, width = 8): string {
  const pct = Math.max(0, Math.min(100, Math.round(w.pct)));
  const { filled, empty } = pctBar(pct, width);
  const color = colorFor(pct);
  // Color wraps just the filled portion + the percentage number, so the
  // empty bar stays readable in any terminal.
  return `${label} ${color}${filled}${RESET}${empty} ${color}${pct}%${RESET}`;
}

export function formatLine(fiveHour: Window, weekly: Window): string {
  return `${formatOne("5h", fiveHour)} · ${formatOne("wk", weekly)}`;
}