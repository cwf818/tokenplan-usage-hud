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

// Split-bar: width characters total, where the LAST `right` chars are
// colored and the first `width - right` chars are not. `right` is derived
// from the mode: in "remaining" mode the colored portion is the USED bar
// (the consumed part = danger); in "used" mode it's symmetrically the
// REMAINING bar (the remaining part = the danger of being close to the
// limit when interpreted as "what's left").
export type SplitBar = {
  leftPlain: string; // uncolored
  rightColored: string; // wrapped in color + RESET
  color: string;
};

export function splitBar(
  usedPct: number,
  mode: DisplayMode,
  width = 8
): SplitBar {
  const used = Math.max(0, Math.min(100, usedPct));
  const remaining = 100 - used;

  // The "displayed value" follows mode: shown to the user as a number.
  // Color is keyed off that displayed value, NOT off what portion is colored.
  const displayed = mode === "remaining" ? remaining : used;
  const color = colorFor(displayed, mode);

  // In "remaining" mode, color the USED portion (right side of bar: filled
  // cells mark consumed). In "used" mode, color the REMAINING portion (left
  // side of bar — the unconsumed cells, marking what's left). This makes
  // the colored chunk ALWAYS represent the metric the user is thinking
  // about as "danger".
  //
  // Wait — re-read the requirement: "颜色标在右侧" (color on the right) and
  // "余量20%时，左边80%无颜色，右边20%红色". So the rule is simpler:
  // the colored chunk is on the RIGHT of the bar, sized by the displayed
  // value in remaining mode (i.e. by REMAINING). The displayed number is
  // the colored chunk's size, in remaining-mode.
  //
  // In "used" mode, by symmetry the displayed value = used, and the colored
  // chunk is still on the right — sized by USED.
  const rightSize = Math.round((displayed / 100) * width);
  const leftSize = Math.max(0, width - rightSize);

  // In remaining mode, bar is "remaining on left, used on right". The
  // colored chunk represents the danger metric (used). Wait — the spec
  // says color is on the right, AND when remaining=20% the right 20% is red.
  // remaining=20% means the bar is 20% remaining + 80% used. So the right
  // 20% is the REMAINING portion. The bar visually goes: [used | remaining].
  //
  // Reinterpretation: in remaining mode the bar draws used on the LEFT and
  // remaining on the RIGHT. The colored chunk is the REMAINING portion (on
  // the right), and its color reflects the remaining % (red when low).
  // This way the user sees "this is how much is left, in the danger color".
  //
  // In used mode the bar draws remaining on the LEFT and used on the RIGHT.
  // The colored chunk is the USED portion (on the right), colored by used %.
  // "this is how much I've consumed, in the danger color".
  //
  // So:
  //   remaining mode:  bar = [used▓▓▓][remaining░░] with right ░░ in color
  //                   → ▓▓▓ for consumed, colored ░░ for what's left
  //                   → if remaining=20%, right 2 chars are colored red
  //   used mode:       bar = [remaining░░][used▓▓▓] with right ▓▓▓ in color
  //                   → colored chunk = consumed, colored by used %
  //
  // Net effect: colored chunk on the right, sized by displayed value, color
  // = colorFor(displayed).

  if (mode === "remaining") {
    // left = used (▓), right = remaining (░), colored portion = remaining
    const left = "▓".repeat(leftSize);
    const right = "░".repeat(rightSize);
    return {
      leftPlain: left,
      rightColored: rightSize > 0 ? `${color}${right}${RESET}` : "",
      color,
    };
  }
  // mode === "used"
  // left = remaining (░), right = used (▓), colored portion = used
  const left = "░".repeat(leftSize);
  const right = "▓".repeat(rightSize);
  return {
    leftPlain: left,
    rightColored: rightSize > 0 ? `${color}${right}${RESET}` : "",
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

  // Layout: "<windowLabel> <leftPlain><rightColored> <coloredDisplayedPct>%<RESET>(reset)"
  // The mode label (Usage:/Remain:) is prepended by formatLine, not here.
  return `${windowLabel} ${bar.leftPlain}${bar.rightColored} ${bar.color}${displayedPct}%${RESET}${resetSuffix}`;
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
  const modeLabel = MODE_LABELS[mode];
  return `${modeLabel} ${formatOne("5h", fiveHour, mode, 8, nowMs)} · ${formatOne("wk", weekly, mode, 8, nowMs)}`;
}