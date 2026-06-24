import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatLine, formatResetSuffix, pctBar } from "./render.ts";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

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

describe("formatLine color thresholds", () => {
  // Color logic:
  //   used% < 20  → green (plenty of room)
  //   used% < 50  → yellow
  //   used% >= 50 → red

  it("colors green when used < 20%", () => {
    const line = formatLine({ pct: 10 }, { pct: 5 });
    assert.ok(line.includes(GREEN), `expected green in ${JSON.stringify(line)}`);
  });

  it("colors yellow when used in [20, 50)%", () => {
    const line = formatLine({ pct: 30 }, { pct: 25 });
    assert.ok(line.includes(YELLOW), `expected yellow in ${JSON.stringify(line)}`);
    assert.ok(line.includes(`${YELLOW}30%${RESET}`));
  });

  it("colors red when used >= 50%", () => {
    const line = formatLine({ pct: 80 }, { pct: 90 });
    assert.ok(line.includes(RED), `expected red in ${JSON.stringify(line)}`);
    assert.ok(line.includes(`${RED}80%${RESET}`));
    assert.ok(line.includes(`${RED}90%${RESET}`));
  });

  it("wraps filled portion + percentage with color; empty portion stays uncolored", () => {
    // 5h at 50%: 4 filled, 4 empty, 50% → red
    const line = formatLine({ pct: 50 }, { pct: 50 });
    assert.ok(line.includes(`5h ${RED}▓▓▓▓${RESET}░░░░ ${RED}50%${RESET}`));
    assert.ok(line.includes(`wk ${RED}▓▓▓▓${RESET}░░░░ ${RED}50%${RESET}`));
  });

  it("joins windows with '·'", () => {
    const line = formatLine({ pct: 30 }, { pct: 40 });
    assert.ok(line.includes(" · "));
  });

  it("rounds fractional percentages", () => {
    const line = formatLine({ pct: 33.7 }, { pct: 66.4 });
    assert.ok(line.includes("34%"));
    assert.ok(line.includes("66%"));
  });

  it("appends (↻) suffix when resetAt is set", () => {
    // Pin now to a deterministic value: 2026-06-24T12:00:00Z.
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 30, resetAt: "2026-06-24T14:03:00Z" },
      { pct: 40, resetAt: "2026-06-27T17:00:00Z" },
      now
    );
    // 2h3m and 3d5h
    assert.ok(line.includes("(2h3m↻)"), `expected (2h3m↻) in ${JSON.stringify(line)}`);
    assert.ok(line.includes("(3d5h↻)"), `expected (3d5h↻) in ${JSON.stringify(line)}`);
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
    assert.equal(
      formatResetSuffix(at(2 * 3_600_000), NOW),
      "(2h↻)"
    );
    assert.equal(
      formatResetSuffix(at(2 * 24 * 3_600_000), NOW),
      "(2d↻)"
    );
  });

  it("does not show seconds — sub-minute remainder rounds down", () => {
    // 1h 0m 30s → "(1h↻)" (30s discarded)
    assert.equal(
      formatResetSuffix(at(3_600_000 + 30_000), NOW),
      "(1h↻)"
    );
  });
});