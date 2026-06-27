import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  colorFor,
  colorForBalance,
  formatBalanceLine,
  formatLine,
  formatResetSuffix,
  formatStaleSuffix,
  pctBar,
  resolveDisplayMode,
  splitBar,
} from "./render.ts";
import { __resetForTest, type Config } from "./config.ts";

const RESET = "\x1b[0m";
const BRIGHT_GREEN = "\x1b[38;5;41m";
const DARK_GREEN = "\x1b[38;5;29m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[38;5;196m";
const STALE_COLOR = "\x1b[90m";

// Strip ANSI escape codes so we can inspect content cleanly.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("splitBar — unified layout (left=used, right=remaining, glyphs flip by mode)", () => {
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

  it("remaining mode: left = used ░ (plain), right = remaining ▓ (colored)", () => {
    // used=80 → remaining=20 → displayed=20 → 2/10 colored → ORANGE (band 1)
    // Per v0.2.11: glyphs flip in remaining mode so the bar reads
    // left-to-right as "what's spent ░░ what's left ▓▓".
    const bar = splitBar(80, "remaining", 10);
    // LEFT chunk: 8 ░ plain (no color wrapping)
    assert.equal(bar.leftChunk, "░░░░░░░░");
    assert.ok(!bar.leftChunk.includes("\x1b["), "left must be plain in remaining mode");
    // RIGHT chunk: 2 ▓ colored ORANGE
    assert.equal(strip(bar.rightChunk), "▓▓");
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
    assert.equal(bar.leftChunk, "░░"); // plain ░ = used 25%
    assert.equal(strip(bar.rightChunk), "▓▓▓▓▓▓"); // 6 colored ▓ = remaining 75%
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
    // used=100 → remaining=0 → displayed=0 → 0 colored ▓ → bar.color is RED
    const bar = splitBar(100, "remaining", 8);
    assert.equal(bar.leftChunk, "░░░░░░░░");
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
  it("defaults to 'used' from DEFAULT_CONFIG", () => {
    assert.equal(resolveDisplayMode(), "used");
  });
  it("reflects config.json `display` field", () => {
    __resetForTest({ display: "remaining" });
    assert.equal(resolveDisplayMode(), "remaining");
    __resetForTest();
    assert.equal(resolveDisplayMode(), "used");
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

  it("remaining mode: colored ▓ on RIGHT represents remaining", () => {
    // used=75 → remaining=25 → displayed=25 (band 1 = ORANGE) → 2/8 right cells colored
    // Per v0.2.11: glyphs flip in remaining mode — left=░ (used),
    // right=▓ (remaining).
    const line = formatLine({ pct: 75 }, { pct: 0 }, "remaining");
    // Bar: 6 plain ░ + 2 colored ▓
    assert.ok(line.includes(`░░░░░░${ORANGE}▓▓${RESET} ${ORANGE}25%${RESET}`),
      `got: ${line}`);
    // No resetAt → bare " 5h" with no parens and no slash.
    assert.ok(line.includes(" 5h "), `got: ${line}`);
    assert.ok(!line.includes("/ 5h"), `got: ${line}`);
    assert.ok(!line.includes("("), `got: ${line}`);
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
    // No resetAt → bare " 5h" with no parens and no slash.
    assert.ok(line.includes(" 5h "), `got: ${line}`);
    assert.ok(!line.includes("/ 5h"), `got: ${line}`);
    assert.ok(!line.includes("("), `got: ${line}`);
  });

  it("full layout matches spec: 'Usage: <bar> <pct>% (<reset><arrow> <windowLabel>) · ...'", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 62, resetAt: "2026-06-24T12:38:00Z" },
      { pct: 42, resetAt: "2026-06-29T04:38:00Z" },
      "used",
      now
    );
    // 5h: used=62 → 5 colored ▓ (LEFT) + 3 plain ░ (RIGHT), ORANGE.
    // New template: "(38m🕛 5h)" — countdown + arrow + space + label, no slash.
    assert.ok(
      line.includes(`${ORANGE}▓▓▓▓▓${RESET}░░░ ${ORANGE}62%${RESET} (38m🕛 5h)`),
      `got: ${line}`
    );
    // 7d (was wk): used=42 → 3 colored ▓ (LEFT) + 5 plain ░ (RIGHT), YELLOW.
    assert.ok(
      line.includes(`${YELLOW}▓▓▓${RESET}░░░░░ ${YELLOW}42%${RESET} (4d16h🕛 7d)`),
      `got: ${line}`
    );
    // Mode label once at the front, ' · ' between windows.
    assert.ok(line.startsWith("Usage: "), `got: ${line}`);
    assert.ok(line.includes(" · "));
    // No double parens: "(38m🕛 5h)" not "(38m🕛) 5h".
    assert.ok(!line.includes("🕛)"), `got: ${line}`);
    // No slash inside the reset annotation.
    assert.ok(!line.includes("🕛 /"), `got: ${line}`);
  });
});

describe("formatLine — reset suffix integration", () => {
  it("appends reset countdown + arrow + label inside parens, no slash", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    const line = formatLine(
      { pct: 30, resetAt: "2026-06-24T14:03:00Z" },
      { pct: 40, resetAt: "2026-06-27T17:00:00Z" },
      "remaining",
      now
    );
    assert.ok(line.includes("(2h3m🕛 5h)"));
    assert.ok(line.includes("(3d5h🕛 7d)"));
  });

  it("no resetAt → bare ' 5h' / ' 7d' with no parens and no arrow", () => {
    const line = formatLine({ pct: 30 }, { pct: 40 });
    assert.ok(!line.includes("🕛"));
    assert.ok(!line.includes("("));
    assert.ok(line.includes(" 5h"));
    assert.ok(line.includes(" 7d"));
  });

  it("sub-minute remaining → '<1m' (still wrapped in parens, arrow preserved)", () => {
    const now = Date.parse("2026-06-24T12:00:00Z");
    // 5h window with 30 seconds remaining
    const line = formatLine(
      { pct: 99, resetAt: new Date(now + 30_000).toISOString() },
      { pct: 99, resetAt: new Date(now + 30_000).toISOString() },
      "used",
      now
    );
    assert.ok(line.includes("(<1m"), `got: ${line}`);
    // The parens must still be present even when the countdown is the "<1m" fallback.
    assert.ok(line.includes(")"), `got: ${line}`);
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

  it("returns '0m' when reset is in the past (default minUnit='m')", () => {
    // v0.2.11: past-due renders as "0m" — explicit "this window has
    // reset" signal, distinct from "<1m" which means "about to reset".
    assert.equal(formatResetSuffix(at(-60_000), NOW), "0m");
  });

  it("formats hours and minutes (drops zero days), no arrow", () => {
    // formatResetSuffix is now arrow-less — the caller (formatOne) adds the glyph.
    assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "2h3m");
  });

  it("formats minutes only when hours and days are zero", () => {
    assert.equal(formatResetSuffix(at(5 * 60_000), NOW), "5m");
  });

  it("keeps two units when all three are non-zero", () => {
    assert.equal(
      formatResetSuffix(at((24 + 2) * 3_600_000 + 3 * 60_000), NOW),
      "1d2h"
    );
  });

  it("formats days + hours when minutes are zero", () => {
    assert.equal(
      formatResetSuffix(at((3 * 24 + 5) * 3_600_000), NOW),
      "3d5h"
    );
  });

  it("formats a single unit when only one is non-zero", () => {
    assert.equal(formatResetSuffix(at(1 * 60_000), NOW), "1m");
    // 2h exactly → 2h0m (internal zero preserved per v0.2.11 rule)
    assert.equal(formatResetSuffix(at(2 * 3_600_000), NOW), "2h0m");
    // 2d exactly → 2d0h
    assert.equal(formatResetSuffix(at(2 * 24 * 3_600_000), NOW), "2d0h");
  });

  it("keeps internal/trailing zero units (e.g. 1h0m stays '1h0m')", () => {
    // v0.2.11: only LEADING zeros are dropped. Internal/trailing zeros
    // within the maxUnitCount window are preserved — "2h0m" stays
    // "2h0m" so the user can see "the window is 2 hours wide and
    // happens to be 0m into it" rather than the lossy "2h".
    assert.equal(formatResetSuffix(at(60 * 60_000), NOW), "1h0m");
    assert.equal(formatResetSuffix(at(2 * 60 * 60_000), NOW), "2h0m");
  });

  it("does not show seconds by default — sub-minute returns '<1m'", () => {
    // 30 seconds remaining → "<1m" (was "0m" before, but the user
    // pointed out that was confusing — the window is about to reset,
    // not exactly at 0).
    assert.equal(formatResetSuffix(at(30_000), NOW), "<1m");
    // 1 second remaining → still "<1m"
    assert.equal(formatResetSuffix(at(1_000), NOW), "<1m");
    // 59.999 seconds remaining → still "<1m"
    assert.equal(formatResetSuffix(at(59_999), NOW), "<1m");
  });

  describe("minUnit='s' (second granularity)", () => {
    beforeEach(() => {
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 }, stale: { ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" } }, countdown: { resetArrows: ["🕛","🕚","🕙","🕘","🕗","🕖","🕕","🕔","🕓","🕒","🕑","🕐"] } });
    });
    afterEach(() => {
      __resetForTest();
    });

    it("sub-minute → actual seconds", () => {
      assert.equal(formatResetSuffix(at(30_000), NOW), "30s");
      assert.equal(formatResetSuffix(at(1_000), NOW), "1s");
      assert.equal(formatResetSuffix(at(59_999), NOW), "59s");
    });

    it("exactly 1 minute → '1m0s' (unified algorithm keeps seconds when minUnit='s')", () => {
      // v0.2.15: unified algorithm. allUnits = [0d,0h,1m,0s]. After
      // dropping leading zeros: [1m, 0s]. Slice to maxUnitCount=2:
      // "1m0s". The trailing 0s is internal-zero — kept on purpose
      // because the user said "去掉前导0" (only LEADING zeros are dropped).
      assert.equal(formatResetSuffix(at(60_000), NOW), "1m0s");
    });

    it("past-due → '0s' (v0.2.11: explicit past-due signal)", () => {
      assert.equal(formatResetSuffix(at(-1_000), NOW), "0s");
    });

    it("≥ 1 unit: seconds appear in countdown when minUnit='s' AND the slice fits them", () => {
      // maxUnitCount=3 → all three units fit, so 2h3m45s → "2h3m45s".
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 3 } });
      assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000 + 45_000), NOW), "2h3m45s");
      assert.equal(formatResetSuffix(at(5 * 60_000 + 7_000), NOW), "5m7s");
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 } });
    });

    it("maxUnitCount slices off trailing seconds (unified algorithm)", () => {
      // maxUnitCount=2, minUnit="s". 2h3m45s → drop leading zeros (none
      // to drop) → [2h, 3m, 45s] → slice to 2 → "2h3m". Seconds are
      // dropped by the slice, NOT by minUnit (which kept them).
      assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000 + 45_000), NOW), "2h3m");
    });

    it("exactly 2h3m → '2h3m' (maxUnitCount=2 slices off the seconds slot)", () => {
      // With maxUnitCount=2, the seconds unit gets sliced off even
      // when minUnit="s". To see the trailing "0s", the user must
      // raise maxUnitCount to 3 (verified in a sibling test above).
      assert.equal(formatResetSuffix(at(2 * 3_600_000 + 3 * 60_000), NOW), "2h3m");
    });

    it("minUnit='s' + maxUnitCount=1: seconds visible only when they're the lead unit", () => {
      // 1d2h3m45s with maxUnitCount=1 → just "1d" (sliced off everything
      // but the first unit). To see seconds, the slice must reach them.
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 1 } });
      assert.equal(formatResetSuffix(at(24 * 3_600_000 + 2 * 3_600_000 + 3 * 60_000 + 45_000), NOW), "1d");
      // 50s with maxUnitCount=1 + minUnit="s" → [0d,0h,0m,50s] →
      // drop leading zeros → [50s] → "50s".
      assert.equal(formatResetSuffix(at(50_000), NOW), "50s");
      __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 } });
    });
  });
});

describe("pickResetArrow (stale.resetArrows[] by remaining/total)", () => {
  // index = floor(remainingMs / resetDurationMs * length), clamped to
  // [0, length-1]. Defaults are 12 clock-face emoji ordered by REMAINING
  // TIME, ascending (few → many): 🕛(0), 🕚(1), 🕙(2), …, 🕐(11). So
  // index 0 (🕛) is shown when the window is about to reset / just reset;
  // the last index (🕐) is shown when the window is fresh. When the
  // interval data is missing (DeepSeek, legacy, clock skew), falls back
  // to index 0.
  const NOW = Date.parse("2026-06-24T12:00:00Z");

  // Helper: call formatLine so the rendered glyph is what the user sees.
  // Builds a Window with the given remaining/total, sets nowMs via the
  // 4th arg. Reads the arrow off the rendered line.
  const arrow = (ratio: number, durMs: number = 5 * 3_600_000) => {
    const remaining = ratio * durMs;
    const startMs = NOW - (durMs - remaining);
    const line = formatLine(
      {
        pct: 50,
        resetAt: new Date(NOW + remaining).toISOString(),
        resetStartAt: new Date(startMs).toISOString(),
        resetDurationMs: durMs,
      },
      { pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() },
      "used",
      NOW
    );
    // The 5h segment is the first "(...)"; grab the arrow between
    // the last digit of the countdown and the space before "5h".
    const m = line.match(/\((?:[^\u{1F550}-\u{1F55B}]+)([\u{1F550}-\u{1F55B}]) 5h\)/u);
    return m?.[1] ?? "";
  };

  it("ratio≈0 → 🕛 (index 0, least remaining)", () => {
    // ~1 minute remaining out of 5h
    assert.equal(arrow(1 / 300), "🕛");
  });

  it("ratio≈1/12 → 🕚 (index 1)", () => {
    assert.equal(arrow(1 / 12), "🕚");
  });

  it("ratio≈0.5 → 🕕 (index 6)", () => {
    assert.equal(arrow(0.5), "🕕");
  });

  it("ratio=1 → 🕐 (index 11, clamped, not out-of-bounds)", () => {
    assert.equal(arrow(1), "🕐");
  });

  it("two-glyph hourglass pair: full→empty", () => {
    __resetForTest({ timeFormat: { minUnit: "m", maxUnitCount: 2 }, stale: { ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" } }, countdown: { resetArrows: ["⏳", "⌛"] } });
    try {
      // Use a small but non-trivial remaining so the countdown is non-empty.
      const arrowAt = (ratio: number) => {
        const remaining = ratio * 5 * 3_600_000;
        const startMs = NOW - (5 * 3_600_000 - remaining);
        const line = formatLine(
          {
            pct: 50,
            resetAt: new Date(NOW + remaining).toISOString(),
            resetStartAt: new Date(startMs).toISOString(),
            resetDurationMs: 5 * 3_600_000,
          },
          { pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() },
          "used",
          NOW
        );
        const m = line.match(/\((?:[^⏳⌛]+)([⏳⌛]) 5h\)/);
        return m?.[1] ?? "";
      };
      assert.equal(arrowAt(0.4), "⏳");
      assert.equal(arrowAt(0.5), "⌛");
      assert.equal(arrowAt(0.9), "⌛");
    } finally {
      __resetForTest();
    }
  });

  it("falls back to index 0 when resetStartAt is missing (DeepSeek path)", () => {
    const line = formatLine(
      { pct: 50, resetAt: new Date(NOW + 60_000).toISOString() },
      { pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() },
      "used",
      NOW
    );
    // The 5h segment is rendered — even with no start/duration, the
    // default index 0 is 🕛.
    assert.ok(line.includes("🕛 5h"), `got: ${line}`);
  });

  it("falls back to index 0 when resetDurationMs is missing", () => {
    const startAt = new Date(NOW - 3_600_000).toISOString();
    const line = formatLine(
      {
        pct: 50,
        resetAt: new Date(NOW + 2 * 3_600_000).toISOString(),
        resetStartAt: startAt,
      },
      { pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() },
      "used",
      NOW
    );
    assert.ok(line.includes("🕛 5h"), `got: ${line}`);
  });

  it("ignores clock skew — clamps to last index", () => {
    // startAt slightly in the future. elapsed negative → ratio > 1
    // → clamped to 1 → last index 🕐.
    const startAt = new Date(NOW + 5_000).toISOString();
    const dur = 5 * 3_600_000;
    const line = formatLine(
      {
        pct: 50,
        resetAt: new Date(NOW + dur).toISOString(),
        resetStartAt: startAt,
        resetDurationMs: dur,
      },
      { pct: 50, resetAt: new Date(NOW + 100_000_000).toISOString() },
      "used",
      NOW
    );
    assert.ok(line.includes("🕐 5h"), `got: ${line}`);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek balance line
// ---------------------------------------------------------------------------

describe("colorForBalance — 5-band thresholds (5/10/20/50)", () => {
  it("<5 is RED", () => {
    assert.equal(colorForBalance(0), RED);
    assert.equal(colorForBalance(4.99), RED);
  });
  it("[5,10) is ORANGE", () => {
    assert.equal(colorForBalance(5), ORANGE);
    assert.equal(colorForBalance(9.99), ORANGE);
  });
  it("[10,20) is YELLOW", () => {
    assert.equal(colorForBalance(10), YELLOW);
    assert.equal(colorForBalance(19.99), YELLOW);
  });
  it("[20,50) is DARK_GREEN", () => {
    assert.equal(colorForBalance(20), DARK_GREEN);
    assert.equal(colorForBalance(49.99), DARK_GREEN);
  });
  it(">=50 is BRIGHT_GREEN", () => {
    assert.equal(colorForBalance(50), BRIGHT_GREEN);
    assert.equal(colorForBalance(110), BRIGHT_GREEN);
    assert.equal(colorForBalance(1_000_000), BRIGHT_GREEN);
  });
  it("clamps negative input to 0 (RED)", () => {
    assert.equal(colorForBalance(-5), RED);
  });
});

describe("formatBalanceLine — single-currency", () => {
  it("CNY uses ￥ prefix, integer value, bright-green band", () => {
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [{ currency: "CNY", totalBalance: 110 }],
      minValue: 110,
    });
    assert.equal(strip(line), "Balance: ￥110");
    assert.ok(line.startsWith(`Balance: ${BRIGHT_GREEN}`));
    assert.ok(line.endsWith(RESET));
  });

  it("USD uses $ prefix", () => {
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [{ currency: "USD", totalBalance: 25 }],
      minValue: 25,
    });
    assert.equal(strip(line), "Balance: $25");
  });

  it("unknown currency falls back to uppercased code as prefix", () => {
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [{ currency: "EUR", totalBalance: 42 }],
      minValue: 42,
    });
    assert.equal(strip(line), "Balance: EUR42");
  });

  it("lowercase currency is uppercased", () => {
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [{ currency: "usd", totalBalance: 5 }],
      minValue: 5,
    });
    assert.equal(strip(line), "Balance: $5");
  });

  it("decimal value preserved up to 2 dp, trailing zeros stripped", () => {
    // 110.10 → "110.1"; 110.00 → "110"; 110.05 → "110.05".
    const a = formatBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 110.1 }], minValue: 110.1 });
    assert.equal(strip(a), "Balance: $110.1");
    const b = formatBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 110.05 }], minValue: 110.05 });
    assert.equal(strip(b), "Balance: $110.05");
  });

  it("color band reflects the lowest entry (single entry = that entry)", () => {
    // 3.5 → ORANGE band (5<=3.5<10? no, 3.5<5 → RED)
    const red = formatBalanceLine({ isAvailable: true, entries: [{ currency: "CNY", totalBalance: 3.5 }], minValue: 3.5 });
    assert.ok(red.startsWith(`Balance: ${RED}`));
    // 25 → DARK_GREEN band (20<=25<50)
    const dg = formatBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 });
    assert.ok(dg.startsWith(`Balance: ${DARK_GREEN}`));
  });
});

describe("formatBalanceLine — multi-currency joined by ·", () => {
  it("renders all entries, joined by ' · ', single color from lowest", () => {
    // CNY 110 (BRIGHT_GREEN) + USD 3.5 (RED). minValue=3.5 → RED band.
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 110 },
        { currency: "USD", totalBalance: 3.5 },
      ],
      minValue: 3.5,
    });
    assert.equal(strip(line), "Balance: ￥110 · $3.5");
    assert.ok(line.startsWith(`Balance: ${RED}`));
    assert.ok(line.endsWith(RESET));
    // The colored chunk wraps both chunks together (single SGR block).
    const colored = line.slice("Balance: ".length, -RESET.length);
    assert.equal(colored, `${RED}￥110 · $3.5`);
  });

  it("integer formatting per-chunk", () => {
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [
        { currency: "CNY", totalBalance: 100 },
        { currency: "USD", totalBalance: 200.5 },
      ],
      minValue: 100,
    });
    assert.equal(strip(line), "Balance: ￥100 · $200.5");
  });
});

describe("formatBalanceLine — unavailable", () => {
  it("renders 'not available!' when isAvailable=false", () => {
    const line = formatBalanceLine({ isAvailable: false, entries: [], minValue: null });
    assert.equal(strip(line), "Balance: not available!");
    assert.ok(line.startsWith(`Balance: ${RED}`));
  });
  it("renders 'not available!' when entries is empty despite isAvailable=true", () => {
    const line = formatBalanceLine({ isAvailable: true, entries: [], minValue: null });
    assert.equal(strip(line), "Balance: not available!");
  });
  it("renders 'not available!' when minValue is null", () => {
    const line = formatBalanceLine({ isAvailable: true, entries: [{ currency: "USD", totalBalance: 0 }], minValue: null });
    assert.equal(strip(line), "Balance: not available!");
  });
});

describe("formatStaleSuffix", () => {
  it("returns empty for non-positive or non-finite ageMs", () => {
    assert.equal(formatStaleSuffix(0), "");
    assert.equal(formatStaleSuffix(-1), "");
    assert.equal(formatStaleSuffix(Number.NaN), "");
    assert.equal(formatStaleSuffix(Number.POSITIVE_INFINITY), "");
  });

  it("sub-minute uses minUnit floor: 'm' → '<1m ago', 's' → '${seconds}s ago'", () => {
    // v0.2.14: no spurious round-up — minUnit governs the sub-minute
    // rendering. With default minUnit='m', sub-minute → "<1m ago".
    // With minUnit='s', sub-minute → "30s ago" / "59s ago".
    assert.equal(strip(formatStaleSuffix(30_000)), "⛓️‍💥 <1m ago");
    assert.equal(strip(formatStaleSuffix(59_000)), "⛓️‍💥 <1m ago");
    __resetForTest({ timeFormat: { minUnit: "s", maxUnitCount: 2 } } as Partial<Config>);
    assert.equal(strip(formatStaleSuffix(30_000)), "⛓️‍💥 30s ago");
    assert.equal(strip(formatStaleSuffix(59_000)), "⛓️‍💥 59s ago");
    __resetForTest();
  });

  it("sub-minute → 'Xm ago' (X >= 1)", () => {
    assert.equal(strip(formatStaleSuffix(60_000)), "⛓️‍💥 1m ago");
    assert.equal(strip(formatStaleSuffix(5 * 60_000)), "⛓️‍💥 5m ago");
    assert.equal(strip(formatStaleSuffix(59 * 60_000)), "⛓️‍💥 59m ago");
  });

  it(">= 1h shows up to 2 non-zero units (1h30m ago, not just '1h ago')", () => {
    // v0.2.11: maxUnitCount=2 → keep up to 2 non-zero units including
    // internal zeros. 1h30m stays "1h30m", NOT "1h". 1h0m (i.e. exactly
    // 60 minutes) stays "1h0m" — only LEADING zeros are dropped.
    assert.equal(strip(formatStaleSuffix(60 * 60_000)), "⛓️‍💥 1h0m ago");
    assert.equal(strip(formatStaleSuffix(90 * 60_000)), "⛓️‍💥 1h30m ago");
    assert.equal(strip(formatStaleSuffix(4 * 60 * 60_000 + 23 * 60_000)), "⛓️‍💥 4h23m ago");
    // 23h exactly → 23h0m (internal zero preserved per v0.2.11 rule)
    assert.equal(strip(formatStaleSuffix(23 * 60 * 60_000)), "⛓️‍💥 23h0m ago");
  });

  it(">= 24h shows up to 2 non-zero units (1d5h ago, not just '1d ago')", () => {
    // 24h exactly → 1d0h (internal zero preserved per v0.2.11 rule)
    assert.equal(strip(formatStaleSuffix(24 * 60 * 60_000)), "⛓️‍💥 1d0h ago");
    // 25h = 1d1h
    assert.equal(strip(formatStaleSuffix(25 * 60 * 60_000)), "⛓️‍💥 1d1h ago");
    assert.equal(strip(formatStaleSuffix(29 * 60 * 60_000)), "⛓️‍💥 1d5h ago");
    // 3d exactly → 3d0h (internal zero preserved per v0.2.11 rule)
    assert.equal(strip(formatStaleSuffix(3 * 24 * 60 * 60_000)), "⛓️‍💥 3d0h ago");
  });

  it("is wrapped in STALE_COLOR and ends with RESET", () => {
    const suffix = formatStaleSuffix(5 * 60_000);
    assert.equal(suffix, `${STALE_COLOR}⛓️‍💥 5m ago${RESET}`);
  });
});

describe("formatLine — stale suffix integration", () => {
  it("appends the stale suffix with broken emoji when stale=true", () => {
    const line = formatLine(
      { pct: 38, resetAt: null },
      { pct: 39, resetAt: null },
      "used",
      Date.now(),
      5 * 60_000,
      true,  // stale → broken emoji
    );
    // Stale suffix should be at the END of the line. v0.2.11: broken
    // emoji IS the indicator, no leading " · " separator.
    assert.ok(line.endsWith(`${STALE_COLOR}⛓️‍💥 5m ago${RESET}`), `unexpected tail: ${JSON.stringify(line)}`);
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"), `stripped: ${strip(line)}`);
  });

  it("appends the stale suffix with healthy emoji when stale=false", () => {
    const line = formatLine(
      { pct: 38, resetAt: null },
      { pct: 39, resetAt: null },
      "used",
      Date.now(),
      30_000,
      false,  // fresh → healthy emoji
    );
    assert.ok(line.endsWith(`${STALE_COLOR}🔗 <1m ago${RESET}`));
    assert.ok(strip(line).endsWith("🔗 <1m ago"));
  });

  it("does NOT append the stale suffix when ageMs is omitted", () => {
    const line = formatLine({ pct: 38, resetAt: null }, { pct: 39, resetAt: null });
    assert.ok(!line.includes("ago"));
    assert.ok(!line.includes(STALE_COLOR));
  });

  it("does NOT append the stale suffix when ageMs is 0", () => {
    const line = formatLine(
      { pct: 38, resetAt: null },
      { pct: 39, resetAt: null },
      "used",
      Date.now(),
      0
    );
    assert.ok(!line.includes("ago"));
  });
});

describe("formatBalanceLine — stale suffix integration", () => {
  it("appends the stale suffix with broken emoji when stale=true", () => {
    const line = formatBalanceLine(
      { isAvailable: true, entries: [{ currency: "CNY", totalBalance: 110 }], minValue: 110 },
      5 * 60_000,
      true,  // stale → broken emoji
    );
    assert.ok(line.endsWith(`${STALE_COLOR}⛓️‍💥 5m ago${RESET}`));
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"));
  });

  it("appends the stale suffix on a multi-currency line", () => {
    const line = formatBalanceLine(
      {
        isAvailable: true,
        entries: [
          { currency: "CNY", totalBalance: 110 },
          { currency: "USD", totalBalance: 3.5 },
        ],
        minValue: 3.5,
      },
      90 * 60_000,
      true,
    );
    // 90m → 1h30m ago (v0.2.11: maxUnitCount=2 keeps internal non-zero units)
    assert.ok(strip(line).endsWith("⛓️‍💥 1h30m ago"));
  });

  it("does NOT append the stale suffix on the 'not available!' branch", () => {
    // Even when staleMs is passed, the API-failed branch must not append —
    // there's no cached value to be stale-OF.
    const line = formatBalanceLine(
      { isAvailable: false, entries: [], minValue: null },
      5 * 60_000,
      true,
    );
    assert.equal(strip(line), "Balance: not available!");
    assert.ok(!line.includes("ago"));
  });

  it("does NOT append the stale suffix when ageMs is omitted", () => {
    const line = formatBalanceLine({
      isAvailable: true,
      entries: [{ currency: "USD", totalBalance: 25 }],
      minValue: 25,
    });
    assert.ok(!line.includes("ago"));
  });
});