import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorFor, formatLine, formatResetSuffix, pctBar, resolveDisplayMode } from "./render.ts";

const RESET = "\x1b[0m";
const GREEN = "\x1b[38;5;41m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[38;5;196m";

describe("pctBar", () => {
  it("builds fixed-width bars", () => {
    assert.equal(pctBar(0, 8).filled.length + pctBar(0, 8).empty.length, 8);
    assert.equal(pctBar(50, 8).filled.length + pctBar(50, 8).empty.length, 8);
    assert.equal(pctBar(100, 8).filled.length + pctBar(100, 8).empty.length, 8);
  });
  it("uses block characters", () => {
    assert.equal(pctBar(0, 8).filled, "");
    assert.equal(pctBar(100, 8).empty, "");
    assert.equal(pctBar(50, 8).filled, "▓▓▓▓");
    assert.equal(pctBar(50, 8).empty, "░░░░");
  });
  it("clamps percentage", () => {
    assert.equal(pctBar(-10, 8).filled, "");
    assert.equal(pctBar(150, 8).filled.length, 8);
  });
});

describe("colorFor — 4-band thresholds on DISPLAYED value", () => {
  // Default thresholds: green < 40, yellow < 60, orange < 80, else red.
  it("green below 40", () => {
    assert.equal(colorFor(0), GREEN);
    assert.equal(colorFor(39.9), GREEN);
  });
  it("yellow at 40..59", () => {
    assert.equal(colorFor(40), YELLOW);
    assert.equal(colorFor(59.9), YELLOW);
  });
  it("orange at 60..79", () => {
    assert.equal(colorFor(60), ORANGE);
    assert.equal(colorFor(79.9), ORANGE);
  });
  it("red at >= 80", () => {
    assert.equal(colorFor(80), RED);
    assert.equal(colorFor(100), RED);
  });
  it("clamps out-of-range values", () => {
    assert.equal(colorFor(-50), GREEN);
    assert.equal(colorFor(200), RED);
  });
});

describe("resolveDisplayMode", () => {
  it("defaults to 'remaining'", () => {
    assert.equal(resolveDisplayMode(undefined), "remaining");
    assert.equal(resolveDisplayMode(""), "remaining");
    assert.equal(resolveDisplayMode("bogus"), "remaining");
  });
  it("recognises 'used' (case-insensitive)", () => {
    assert.equal(resolveDisplayMode("used"), "used");
    assert.equal(resolveDisplayMode("USED"), "used");
    assert.equal(resolveDisplayMode("Used"), "used");
  });
});

describe("formatLine — mode='remaining' (default)", () => {
  it("displayed value = 100 - used", () => {
    // used=38 → display remaining=62 → orange
    const line = formatLine({ pct: 38 }, { pct: 60 }, "remaining");
    assert.ok(line.includes(`${ORANGE}62%${RESET}`));
    assert.ok(line.includes(`${YELLOW}40%${RESET}`));
  });

  it("color matches remaining % thresholds", () => {
    // used=10 → remaining=90 → red
    assert.ok(formatLine({ pct: 10 }, { pct: 0 }, "remaining").includes(RED));
    // used=50 → remaining=50 → yellow
    assert.ok(formatLine({ pct: 50 }, { pct: 0 }, "remaining").includes(YELLOW));
    // used=80 → remaining=20 → red
    assert.ok(formatLine({ pct: 80 }, { pct: 0 }, "remaining").includes(RED));
  });

  it("bar fill reflects USED (intuitive: filled = consumed)", () => {
    // used=50 → bar 4/8 filled
    const line = formatLine({ pct: 50 }, { pct: 0 }, "remaining");
    assert.ok(line.includes(`5h ${YELLOW}▓▓▓▓${RESET}░░░░`), `got: ${line}`);
  });
});

describe("formatLine — mode='used'", () => {
  it("displayed value = used", () => {
    // used=70 → display 70 → orange
    const line = formatLine({ pct: 70 }, { pct: 90 }, "used");
    assert.ok(line.includes(`${ORANGE}70%${RESET}`));
    assert.ok(line.includes(`${RED}90%${RESET}`));
  });

  it("color matches used % thresholds", () => {
    // used=10 → green
    assert.ok(formatLine({ pct: 10 }, { pct: 0 }, "used").includes(GREEN));
    // used=45 → yellow
    assert.ok(formatLine({ pct: 45 }, { pct: 0 }, "used").includes(YELLOW));
    // used=65 → orange
    assert.ok(formatLine({ pct: 65 }, { pct: 0 }, "used").includes(ORANGE));
    // used=85 → red
    assert.ok(formatLine({ pct: 85 }, { pct: 0 }, "used").includes(RED));
  });

  it("bar fill still reflects used (consistent with mode='remaining')", () => {
    const line = formatLine({ pct: 50 }, { pct: 0 }, "used");
    assert.ok(line.includes(`5h ${YELLOW}▓▓▓▓${RESET}░░░░`), `got: ${line}`);
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
    assert.equal(formatResetSuffix(at(-3 * 24 * 60 * 60_000), NOW), "");
  });

  it("formats hours and minutes (drops zero days)", () => {
    assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "(2h3m↻)");
  });

  it("formats minutes only when hours and days are zero (0h5m → 5m)", () => {
    assert.equal(formatResetSuffix(at(5 * 60_000), NOW), "(5m↻)");
  });

  it("keeps two units when all three are non-zero (1d2h3m → 1d2h)", () => {
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