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

// Strip ANSI escape codes so we can inspect content cleanly.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("splitBar — unified layout (LEFT = used ▓, RIGHT = remaining ░)", () => {
  it("used mode: left = used ▓ (colored), right = remaining ░ (plain)", () => {
    // used=80 → displayed=80 → 8/10 colored → RED (band 4)
    const bar = splitBar(80, "used", 10);
    // LEFT chunk: 8 ▓ wrapped in RED/RESET
    assert.equal(strip(bar.leftChunk), "▓▓▓▓▓▓▓▓");
    assert.ok(bar.leftChunk.startsWith(RED), `left should start with RED: ${JSON.stringify(bar.leftChunk)}`);
    assert.ok(bar.leftChunk.endsWith(RESET), `left should end with RESET: ${JSON.stringify(bar.leftChunk)}`);
    // RIGHT chunk: 2 ░ plain
    assert.equal(bar.rightChunk, "░░");
    // Color field carries the band's RED
    assert.equal(bar.color, RED);
  });

  it("remaining mode: left = used ▓ (plain), right = remaining ░ (colored)", () => {
    // used=80 → remaining=20 → displayed=20 → 2/10 colored → ORANGE (band 1)
    const bar = splitBar(80, "remaining", 10);
    // LEFT chunk: 8 ▓ plain (no color wrapping)
    assert.equal(bar.leftChunk, "▓▓▓▓▓▓▓▓");
    assert.ok(!bar.leftChunk.includes("\x1b["), "left must be plain in remaining mode");
    // RIGHT chunk: 2 ░ colored ORANGE
    assert.equal(strip(bar.rightChunk), "░░");
    assert.ok(bar.rightChunk.startsWith(ORANGE), `right should start with ORANGE: ${JSON.stringify(bar.rightChunk)}`);
    assert.ok(bar.rightChunk.endsWith(RESET), `right should end with RESET: ${JSON.stringify(bar.rightChunk)}`);
    assert.equal(bar.color, ORANGE);
  });

  it("used mode at low usage (15%) — colored chunk is on LEFT, small", () => {
    // used=15 → displayed=15 → 1/8 colored (band 0 = BRIGHT_GREEN)
    const bar = splitBar(15, "used", 8);
    assert.equal(strip(bar.leftChunk), "▓");
    assert.equal(bar.leftChunk, `${BRIGHT_GREEN}▓${RESET}`);
    assert.equal(bar.rightChunk, "░░░░░░░");
    assert.equal(bar.color, BRIGHT_GREEN);
  });

  it("remaining mode at high remaining (75%) — colored chunk is on RIGHT, big", () => {
    // used=25 → remaining=75 → displayed=75 → 6/8 colored (band 3 = DARK_GREEN)
    const bar = splitBar(25, "remaining", 8);
    assert.equal(bar.leftChunk, "▓▓"); // plain ▓ = used 25%
    assert.equal(strip(bar.rightChunk), "░░░░░░"); // 6 colored ░ = remaining 75%
    assert.ok(bar.rightChunk.startsWith(DARK_GREEN));
    assert.equal(bar.color, DARK_GREEN);
  });

  it("zero usage: used mode emits no colored chunk; both sides stay plain", () => {
    const bar = splitBar(0, "used", 8);
    assert.equal(bar.leftChunk, ""); // nothing to color
    assert.equal(bar.rightChunk, "░░░░░░░░");
    // Even with no colored cells, the color field still reflects the band (bright green).
    assert.equal(bar.color, BRIGHT_GREEN);
  });

  it("full usage: remaining mode emits no colored chunk", () => {
    // used=100 → remaining=0 → displayed=0 → 0 colored ░ → bar.color is RED
    const bar = splitBar(100, "remaining", 8);
    assert.equal(bar.leftChunk, "▓▓▓▓▓▓▓▓");
    assert.equal(bar.rightChunk, "");
    assert.equal(bar.color, RED);
  });

  it("split sizes sum to width regardless of mode", () => {
    for (const u of [0, 10, 25, 50, 75, 90, 100]) {
      for (const m of ["used", "remaining"] as const) {
        const bar = splitBar(u, m, 8);
        const leftPlainLen = strip(bar.leftChunk).length;
        const rightPlainLen = strip(bar.rightChunk).length;
        assert.equal(leftPlainLen + rightPlainLen, 8, `u=${u} mode=${m}`);
      }
    }
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

  it("displayed value = 100 - used when mode='remaining'", () => {
    // used=38 → display remaining=62 → dark green
    const line = formatLine({ pct: 38 }, { pct: 60 }, "remaining");
    assert.ok(line.includes(`${DARK_GREEN}62%${RESET}`));
    assert.ok(line.includes(`${YELLOW}40%${RESET}`));
  });

  it("remaining mode: colored ░ on RIGHT represents remaining", () => {
    // used=75 → remaining=25 → displayed=25 (band 1 = ORANGE) → 2/8 right cells colored
    const line = formatLine({ pct: 75 }, { pct: 0 }, "remaining");
    // Bar: 6 plain ▓ + 2 colored ░
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

  it("used mode: colored ▓ on LEFT represents used", () => {
    // used=75 → displayed=75 (band 3 = ORANGE) → 6/8 LEFT cells colored
    const line = formatLine({ pct: 75 }, { pct: 0 }, "used");
    // Bar: 6 colored ▓ (LEFT) + 2 plain ░ (RIGHT)
    assert.ok(line.includes(`${ORANGE}▓▓▓▓▓▓${RESET}░░ ${ORANGE}75%${RESET}`),
      `got: ${line}`);
    // Window label at the END after the reset countdown.
    assert.ok(line.includes(` / 5h`), `got: ${line}`);
  });

  it("full layout matches spec: 'Usage: <bar> <pct>% (reset / 5h) · ...'", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 62, resetAt: "2026-06-24T12:38:00Z" },
      { pct: 42, resetAt: "2026-06-29T04:38:00Z" },
      "used",
      now
    );
    // 5h: used=62 → 5 colored ▓ (LEFT) + 3 plain ░ (RIGHT), ORANGE
    assert.ok(
      line.includes(`${ORANGE}▓▓▓▓▓${RESET}░░░ ${ORANGE}62%${RESET} (38m↻ / 5h)`),
      `got: ${line}`
    );
    // wk: used=42 → 3 colored ▓ (LEFT) + 5 plain ░ (RIGHT), YELLOW
    assert.ok(
      line.includes(`${YELLOW}▓▓▓${RESET}░░░░░ ${YELLOW}42%${RESET} (4d16h↻ / wk)`),
      `got: ${line}`
    );
    // Mode label once at the front, ' · ' between windows.
    assert.ok(line.startsWith("Usage: "), `got: ${line}`);
    assert.ok(line.includes(" · "));
    // No double parens: "(38m↻ / 5h)" not "(38m↻) / 5h".
    assert.ok(!line.includes("↻)"), `got: ${line}`);
  });
});

describe("formatLine — reset suffix integration", () => {
  it("appends reset countdown inside parens, label after slash", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 30, resetAt: "2026-06-24T14:03:00Z" },
      { pct: 40, resetAt: "2026-06-27T17:00:00Z" },
      "remaining",
      now
    );
    assert.ok(line.includes("(2h3m↻ / 5h)"));
    assert.ok(line.includes("(3d5h↻ / wk)"));
  });

  it("omits suffix and inner parens when resetAt is missing, label still appears", () => {
    const line = formatLine({ pct: 30 }, { pct: 40 });
    assert.ok(!line.includes("↻"));
    assert.ok(line.includes(" / 5h"));
    assert.ok(line.includes(" / wk"));
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

  it("formats hours and minutes (drops zero days), no surrounding parens", () => {
    assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "2h3m↻");
  });

  it("formats minutes only when hours and days are zero", () => {
    assert.equal(formatResetSuffix(at(5 * 60_000), NOW), "5m↻");
  });

  it("keeps two units when all three are non-zero", () => {
    assert.equal(
      formatResetSuffix(at((24 + 2) * 3_600_000 + 3 * 60_000), NOW),
      "1d2h↻"
    );
  });

  it("formats days + hours when minutes are zero", () => {
    assert.equal(
      formatResetSuffix(at((3 * 24 + 5) * 3_600_000), NOW),
      "3d5h↻"
    );
  });

  it("formats a single unit when only one is non-zero", () => {
    assert.equal(formatResetSuffix(at(1 * 60_000), NOW), "1m↻");
    assert.equal(formatResetSuffix(at(2 * 3_600_000), NOW), "2h↻");
    assert.equal(formatResetSuffix(at(2 * 24 * 3_600_000), NOW), "2d↻");
  });

  it("does not show seconds — sub-minute remainder rounds down", () => {
    assert.equal(formatResetSuffix(at(3_600_000 + 30_000), NOW), "1h↻");
  });
});