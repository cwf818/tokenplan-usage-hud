import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatLine, pctBar } from "./render.ts";

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
});