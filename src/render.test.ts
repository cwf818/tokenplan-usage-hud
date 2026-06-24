import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  colorFor,
  formatLine,
  formatResetSuffix,
  pctBar,
  resolveDisplayMode,
  splitBar,
} from "./render.ts";

const RESET = "\x1b[0m";
const BRIGHT_GREEN = "\x1b[38;5;41m";
const DARK_GREEN = "\x1b[38;5;29m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[38;5;196m";

describe("splitBar", () => {
  it("remaining mode: left = used (▓), right = remaining (░, colored)", () => {
    // used=85 → remaining=15 (band 0 = red) → right 2/10 chars are red
    const bar = splitBar(85, "remaining", 10);
    // rightSize = round(15/100 * 10) = round(1.5) = 2 → 8 plain ▓, 2 colored ░
    assert.equal(bar.leftPlain, "▓▓▓▓▓▓▓▓");
    assert.equal(bar.rightColored, `${RED}${"░░"}${RESET}`);
  });

  it("used mode: left = remaining (░), right = used (▓, colored)", () => {
    // used=80 → right 8 chars (80%) colored, representing used
    const bar = splitBar(80, "used", 10);
    assert.equal(bar.leftPlain, "░░"); // 20% remaining
    assert.equal(bar.rightColored, `${RED}${"▓▓▓▓▓▓▓▓"}${RESET}`); // 80% used, red
  });

  it("colored chunk size = displayed value (rounded to width)", () => {
    // used=50, remaining mode: displayed=50 → 4 of 8 colored
    const bar = splitBar(50, "remaining", 8);
    assert.equal(bar.leftPlain.length + (bar.rightColored.length - (RED.length + RESET.length)), 8);
  });

  it("zero used → no colored chunk in used mode", () => {
    const bar = splitBar(0, "used", 8);
    assert.equal(bar.leftPlain, "░░░░░░░░");
    assert.equal(bar.rightColored, "");
  });
});

describe("pctBar (legacy filled-on-left)", () => {
  it("builds fixed-width bars", () => {
    assert.equal(pctBar(0, 8).filled.length + pctBar(0, 8).empty.length, 8);
    assert.equal(pctBar(50, 8).filled.length + pctBar(50, 8).empty.length, 8);
  });
  it("clamps percentage", () => {
    assert.equal(pctBar(-10, 8).filled, "");
    assert.equal(pctBar(150, 8).filled.length, 8);
  });
});

describe("colorFor — 5-band thresholds on DISPLAYED value", () => {
  // Band boundaries at displayed value 20/40/60/80.
  // In "used" mode:    0-20 bright green, 20-40 dark green, 40-60 yellow,
  //                    60-80 orange, >=80 red.
  // In "remaining" mode: REVERSED — 0-20 red, 20-40 orange, 40-60 yellow,
  //                    60-80 dark green, >=80 bright green.
  const USED_COLORS = [BRIGHT_GREEN, DARK_GREEN, YELLOW, ORANGE, RED];
  const REMAINING_COLORS = [RED, ORANGE, YELLOW, DARK_GREEN, BRIGHT_GREEN];

  it("used mode colors (band-internal values)", () => {
    assert.equal(colorFor(0, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(10, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(19, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(25, "used"), DARK_GREEN);
    assert.equal(colorFor(39, "used"), DARK_GREEN);
    assert.equal(colorFor(45, "used"), YELLOW);
    assert.equal(colorFor(59, "used"), YELLOW);
    assert.equal(colorFor(65, "used"), ORANGE);
    assert.equal(colorFor(79, "used"), ORANGE);
    assert.equal(colorFor(85, "used"), RED);
    assert.equal(colorFor(100, "used"), RED);
  });

  it("remaining mode is the reverse of used mode", () => {
    assert.equal(colorFor(0, "remaining"), RED);
    assert.equal(colorFor(10, "remaining"), RED);
    assert.equal(colorFor(19, "remaining"), RED);
    assert.equal(colorFor(25, "remaining"), ORANGE);
    assert.equal(colorFor(39, "remaining"), ORANGE);
    assert.equal(colorFor(45, "remaining"), YELLOW);
    assert.equal(colorFor(59, "remaining"), YELLOW);
    assert.equal(colorFor(65, "remaining"), DARK_GREEN);
    assert.equal(colorFor(79, "remaining"), DARK_GREEN);
    assert.equal(colorFor(85, "remaining"), BRIGHT_GREEN);
    assert.equal(colorFor(100, "remaining"), BRIGHT_GREEN);
  });

  it("at exact threshold, value belongs to band above (less dangerous)", () => {
    // used=20 → band 1 (dark green), remaining=80 → band 4 (bright green)
    assert.equal(colorFor(20, "used"), DARK_GREEN);
    assert.equal(colorFor(80, "remaining"), BRIGHT_GREEN);
  });

  it("dark green is visibly distinct from bright green", () => {
    assert.notEqual(DARK_GREEN, BRIGHT_GREEN);
  });

  it("clamps out-of-range values", () => {
    assert.equal(colorFor(-50, "used"), BRIGHT_GREEN);
    assert.equal(colorFor(200, "used"), RED);
    assert.equal(colorFor(-50, "remaining"), RED);
    assert.equal(colorFor(200, "remaining"), BRIGHT_GREEN);
  });

  it("uses the exact 5-color palette", () => {
    for (let v = 0; v <= 100; v += 1) {
      const u = colorFor(v, "used");
      assert.ok(
        USED_COLORS.includes(u),
        `used mode at ${v} returned unexpected color ${JSON.stringify(u)}`
      );
      const r = colorFor(v, "remaining");
      assert.ok(
        REMAINING_COLORS.includes(r),
        `remaining mode at ${v} returned unexpected color ${JSON.stringify(r)}`
      );
    }
  });
});

describe("resolveDisplayMode", () => {
  it("defaults to 'used'", () => {
    assert.equal(resolveDisplayMode(undefined), "used");
    assert.equal(resolveDisplayMode(""), "used");
    assert.equal(resolveDisplayMode("bogus"), "used");
  });
  it("recognises 'remaining' (case-insensitive)", () => {
    assert.equal(resolveDisplayMode("remaining"), "remaining");
    assert.equal(resolveDisplayMode("REMAINING"), "remaining");
    assert.equal(resolveDisplayMode("Remaining"), "remaining");
  });
});

describe("formatLine — mode='used' (default)", () => {
  it("prefixes with 'Usage:' label by default", () => {
    const line = formatLine({ pct: 38 }, { pct: 60 });
    assert.ok(line.startsWith("Usage: "), `got: ${line}`);
    assert.ok(line.includes(" · "));
  });

  it("default mode displays used percentages (38% / 60%)", () => {
    const line = formatLine({ pct: 38 }, { pct: 60 });
    assert.ok(line.includes(`38%`));
    assert.ok(line.includes(`60%`));
  });

  it("displayed value = 100 - used", () => {
    // used=38 → display remaining=62 → dark green
    const line = formatLine({ pct: 38 }, { pct: 60 }, "remaining");
    assert.ok(line.includes(`${DARK_GREEN}62%${RESET}`));
    assert.ok(line.includes(`${YELLOW}40%${RESET}`));
  });

  it("colored chunk is on the RIGHT and represents remaining", () => {
    // used=75 → remaining=25 → right 2/8 chars are orange, representing remaining
    const line = formatLine({ pct: 75 }, { pct: 0 }, "remaining");
    assert.ok(line.includes(`▓▓▓▓▓▓${ORANGE}░░${RESET} ${ORANGE}25%${RESET}`),
      `got: ${line}`);
    // Window label sits at the END after the reset countdown.
    assert.ok(line.includes(` / 5h`), `got: ${line}`);
  });
});

describe("formatLine — mode='used'", () => {
  it("prefixes with 'Usage:' label", () => {
    const line = formatLine({ pct: 70 }, { pct: 90 }, "used");
    assert.ok(line.startsWith("Usage: "), `got: ${line}`);
  });

  it("displayed value = used", () => {
    // used=70 → display 70 → orange
    const line = formatLine({ pct: 70 }, { pct: 90 }, "used");
    assert.ok(line.includes(`${ORANGE}70%${RESET}`));
    assert.ok(line.includes(`${RED}90%${RESET}`));
  });

  it("colored chunk is on the RIGHT and represents used", () => {
    // used=75 → right 6/8 chars are orange, representing used
    const line = formatLine({ pct: 75 }, { pct: 0 }, "used");
    assert.ok(line.includes(`░░${ORANGE}▓▓▓▓▓▓${RESET} ${ORANGE}75%${RESET}`),
      `got: ${line}`);
    // Window label at the END after the reset countdown.
    assert.ok(line.includes(` / 5h`), `got: ${line}`);
  });

  it("full layout matches spec: 'Usage: <bar> <pct>% (<reset>↻ / 5h) · ...'", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 62, resetAt: "2026-06-24T12:38:00Z" },
      { pct: 42, resetAt: "2026-06-29T04:38:00Z" },
      "used",
      now
    );
    // 5h: used=62 → 3 plain + 5 colored
    assert.ok(
      line.includes(`░░░${ORANGE}▓▓▓▓▓${RESET} ${ORANGE}62%${RESET} (38m↻) / 5h`),
      `got: ${line}`
    );
    // wk: used=42 → 5 plain + 3 colored
    assert.ok(
      line.includes(`░░░░░${YELLOW}▓▓▓${RESET} ${YELLOW}42%${RESET} (4d16h↻) / wk`),
      `got: ${line}`
    );
    // Mode label once at the front, ' · ' between windows.
    assert.ok(line.startsWith("Usage: "), `got: ${line}`);
    assert.ok(line.includes(" · "));
  });
});

describe("formatLine — reset suffix integration", () => {
  it("appends (↻) suffix when resetAt is set", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 30, resetAt: "2026-06-24T14:03:00Z" },
      { pct: 40, resetAt: "2026-06-27T17:00:00Z" },
      "remaining",
      now
    );
    assert.ok(line.includes("(2h3m↻)"));
    assert.ok(line.includes("(3d5h↻)"));
  });

  it("omits suffix when resetAt is missing", () => {
    const line = formatLine({ pct: 30 }, { pct: 40 });
    assert.ok(!line.includes("↻"));
  });
});

describe("formatResetSuffix", () => {
  const NOW = Date.parse("2026-06-24T12:00:00Z");
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it("returns empty when resetAt is missing or invalid", () => {
    assert.equal(formatResetSuffix(undefined, NOW), "");
    assert.equal(formatResetSuffix(null, NOW), "");
    assert.equal(formatResetSuffix("", NOW), "");
    assert.equal(formatResetSuffix("not-a-date", NOW), "");
  });

  it("returns empty when reset is in the past", () => {
    assert.equal(formatResetSuffix(at(-60_000), NOW), "");
  });

  it("formats hours and minutes (drops zero days)", () => {
    assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "(2h3m↻)");
  });

  it("formats minutes only when hours and days are zero", () => {
    assert.equal(formatResetSuffix(at(5 * 60_000), NOW), "(5m↻)");
  });

  it("keeps two units when all three are non-zero", () => {
    assert.equal(
      formatResetSuffix(at((24 + 2) * 3_600_000 + 3 * 60_000), NOW),
      "(1d2h↻)"
    );
  });

  it("formats days + hours when minutes are zero", () => {
    assert.equal(
      formatResetSuffix(at((3 * 24 + 5) * 3_600_000), NOW),
      "(3d5h↻)"
    );
  });

  it("formats a single unit when only one is non-zero", () => {
    assert.equal(formatResetSuffix(at(1 * 60_000), NOW), "(1m↻)");
    assert.equal(formatResetSuffix(at(2 * 3_600_000), NOW), "(2h↻)");
    assert.equal(formatResetSuffix(at(2 * 24 * 3_600_000), NOW), "(2d↻)");
  });

  it("does not show seconds — sub-minute remainder rounds down", () => {
    assert.equal(formatResetSuffix(at(3_600_000 + 30_000), NOW), "(1h↻)");
  });
});