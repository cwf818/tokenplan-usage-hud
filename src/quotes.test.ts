// v0.3.6+ — Tests for the m_quote module + supporting helpers in
// src/quotes.ts and src/render.ts.
//
// Covers:
//   - parseFreq: accepts single-unit time strings; rejects multi-
//     unit, leading zeros, zero counts, oversize counts, unknown
//     units, empty input.
//   - utcAnchored: returns true iff bucketMs divides 86_400_000.
//   - pickQuote / quoteIndex: bucket stability (same freq + same
//     window = same quote), bucket rollover (different windows =
//     may differ), UTC-anchored vs rolling boundaries.
//   - buildRainbow: per-char SGR wraps, salt offset rotates the
//     palette, same text + same salt = identical output.
//   - buildHue: deterministic per text, falls in the 6×6×6 cube.
//   - m_quote bare form (MODULES path) picks a plain quote.
//   - m_quote inline-args: freq param, color shortcuts incl.
//     rainbow / rand-rainbow / hue.
//   - invalid freq / color values drop + warn (parse failure path).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderProviderLine,
  __resetUnknownModuleWarnForTest,
} from "./render.ts";
import { __resetForTest } from "./config.ts";
import {
  buildRainbow,
  buildHue,
  parseFreq,
  pickQuote,
  quoteIndex,
  QUOTES,
  utcAnchored,
} from "./quotes.ts";

const RESET = "\x1b[0m";

// Helper: capture stderr during a render. Restored in finally.
function withCapturedStderr<T>(fn: () => T): { value: T; warns: string[] } {
  const err = process.stderr as unknown as { write: (c: string) => boolean };
  const original = err.write;
  const captured: string[] = [];
  err.write = (c: string) => {
    captured.push(c);
    return true;
  };
  try {
    return { value: fn(), warns: captured };
  } finally {
    err.write = original;
  }
}

describe("quotes — pool", () => {
  it("has ≥100 entries", () => {
    assert.ok(QUOTES.length >= 100, `got ${QUOTES.length}`);
  });

  it("every entry is a non-empty string ≤ 70 chars", () => {
    for (let i = 0; i < QUOTES.length; i++) {
      const q = QUOTES[i]!;
      assert.ok(q.length > 0, `entry ${i} is empty`);
      assert.ok(
        q.length <= 70,
        `entry ${i} too long (${q.length} chars): ${JSON.stringify(q)}`,
      );
    }
  });

  it("entries are unique", () => {
    const seen = new Set(QUOTES);
    assert.equal(seen.size, QUOTES.length, "duplicate quotes found");
  });
});

describe("quotes — parseFreq", () => {
  it("accepts bare unit letters as shorthand for 1<unit>", () => {
    assert.deepEqual(parseFreq("d"), { count: 1, unit: "d", ms: 86_400_000 });
    assert.deepEqual(parseFreq("h"), { count: 1, unit: "h", ms: 3_600_000 });
    assert.deepEqual(parseFreq("m"), { count: 1, unit: "m", ms: 60_000 });
    assert.deepEqual(parseFreq("s"), { count: 1, unit: "s", ms: 1_000 });
  });

  it("accepts single-unit numeric forms", () => {
    assert.deepEqual(parseFreq("12h"), { count: 12, unit: "h", ms: 12 * 3_600_000 });
    assert.deepEqual(parseFreq("30m"), { count: 30, unit: "m", ms: 30 * 60_000 });
    assert.deepEqual(parseFreq("7d"), { count: 7, unit: "d", ms: 7 * 86_400_000 });
    assert.deepEqual(parseFreq("130m"), { count: 130, unit: "m", ms: 130 * 60_000 });
    assert.deepEqual(parseFreq("60s"), { count: 60, unit: "s", ms: 60_000 });
  });

  it("rejects multi-unit forms like '2h10m'", () => {
    assert.equal(parseFreq("2h10m"), null);
    assert.equal(parseFreq("1d2h"), null);
    assert.equal(parseFreq("2h30m"), null);
  });

  it("rejects leading zeros", () => {
    assert.equal(parseFreq("01h"), null);
    assert.equal(parseFreq("007"), null);
  });

  it("rejects zero counts", () => {
    assert.equal(parseFreq("0h"), null);
    assert.equal(parseFreq("0"), null);
  });

  it("rejects unknown units", () => {
    assert.equal(parseFreq("5x"), null);
    assert.equal(parseFreq("1y"), null);
    assert.equal(parseFreq("1w"), null);
  });

  it("rejects empty / malformed inputs", () => {
    assert.equal(parseFreq(""), null);
    // "h" alone IS valid (the 1h shorthand). "hh" alone is invalid
    // (not in {d,h,m,s}, not parseable as <digits><unit>).
    assert.equal(parseFreq("hh"), null);
    assert.equal(parseFreq("h10"), null);
    assert.equal(parseFreq("10"), null);
    assert.equal(parseFreq("+5h"), null);
    assert.equal(parseFreq("-1h"), null);
    assert.equal(parseFreq("5 h"), null);
    assert.equal(parseFreq("1.5h"), null);
  });

  it("rejects oversize counts (> 1_000_000)", () => {
    assert.equal(parseFreq("1000001s"), null);
    assert.equal(parseFreq("9999999d"), null);
  });

  it("accepts boundary count of 1_000_000", () => {
    assert.ok(parseFreq("1000000s") !== null);
  });
});

describe("quotes — utcAnchored", () => {
  it("returns true for buckets that divide one day", () => {
    assert.equal(utcAnchored(86_400_000), true);  // 1d
    assert.equal(utcAnchored(43_200_000), true);  // 12h
    assert.equal(utcAnchored(28_800_000), true);  // 8h
    assert.equal(utcAnchored(21_600_000), true);  // 6h
    assert.equal(utcAnchored(14_400_000), true);  // 4h
    assert.equal(utcAnchored(10_800_000), true);  // 3h
    assert.equal(utcAnchored(7_200_000), true);   // 2h
    assert.equal(utcAnchored(3_600_000), true);   // 1h
    assert.equal(utcAnchored(1_800_000), true);   // 30m
    assert.equal(utcAnchored(60_000), true);      // 1m
    assert.equal(utcAnchored(1_000), true);       // 1s
  });

  it("returns false for buckets that don't divide one day", () => {
    assert.equal(utcAnchored(46_800_000), false);  // 13h
    assert.equal(utcAnchored(70_000), false);      // 70s (70 doesn't divide 86400)
    assert.equal(utcAnchored(5_500), false);       // 5.5s
    assert.equal(utcAnchored(604_800_000), false); // 7d — doesn't divide 1d
  });

  it("returns false for non-positive buckets", () => {
    assert.equal(utcAnchored(0), false);
    assert.equal(utcAnchored(-1), false);
  });
});

describe("quotes — pickQuote / quoteIndex", () => {
  const nowMs = 1_700_006_400_000; // exactly UTC 2023-11-15 00:00:00

  function f(raw: string) {
    const parsed = parseFreq(raw);
    if (!parsed) throw new Error(`bad freq: ${raw}`);
    return parsed;
  }

  it("same freq + same nowMs → same quote (bucket stability)", () => {
    const a = pickQuote(f("h"), nowMs);
    const b = pickQuote(f("h"), nowMs);
    assert.equal(a, b);
  });

  it("same freq + slightly later nowMs in the same hour bucket → same quote", () => {
    const a = pickQuote(f("h"), nowMs);
    const b = pickQuote(f("h"), nowMs + 30 * 60_000); // +30min, still in same hour
    assert.equal(a, b);
  });

  it("same freq + a later hour bucket → may differ", () => {
    const b = pickQuote(f("h"), nowMs + 3_600_000); // +1h
    assert.notEqual(quoteIndex(f("h"), nowMs), quoteIndex(f("h"), nowMs + 3_600_000));
    assert.ok(b.length > 0);
  });

  it("m vs h picks different buckets (smaller bucket = more rotation)", () => {
    const idxH = quoteIndex(f("h"), nowMs);
    const idxHPlus1m = quoteIndex(f("h"), nowMs + 60_000);
    const idxM = quoteIndex(f("m"), nowMs);
    const idxMPlus1m = quoteIndex(f("m"), nowMs + 60_000);
    assert.equal(idxH, idxHPlus1m);
    assert.notEqual(idxM, idxMPlus1m);
  });

  it("UTC-anchored bucket: 12h returns same index throughout the day", () => {
    // nowMs is exactly UTC 00:00:00, so the 12h bucket boundary sits
    // at 00:00. Sample at 00:00 and 06:00 (still in the same 12h
    // bucket) — index should match.
    const a = quoteIndex(f("12h"), nowMs);
    const b = quoteIndex(f("12h"), nowMs + 6 * 3_600_000);
    assert.equal(a, b);
  });

  it("UTC-anchored bucket: 12h returns different index across the UTC boundary", () => {
    const morning = quoteIndex(f("12h"), nowMs); // 00:00 UTC
    const evening = quoteIndex(f("12h"), nowMs + 12 * 3_600_000); // 12:00 UTC
    assert.notEqual(morning, evening);
  });

  it("UTC-anchored bucket: 7d (a divisor of 24h… actually no — 7d doesn't divide 24h, but does divide 1d trivially via 86_400_000 % 604_800_000 = 86_400_000 ≠ 0)", () => {
    // 7d = 604_800_000, 86_400_000 % 604_800_000 = 86_400_000 ≠ 0
    // so 7d is NOT UTC-anchored. It's rolling.
    assert.equal(utcAnchored(7 * 86_400_000), false);
  });

  it("rolling bucket: 13h returns different index from epoch-driven boundary", () => {
    // 13h doesn't divide 24h, so boundaries are at Unix-epoch
    // multiples. nowMs = 1.7e12 is comfortably past the first 13h
    // rollover at 13h*k for some integer k. Just verify the index
    // is in range and stable.
    const idx = quoteIndex(f("13h"), nowMs);
    assert.ok(idx >= 0 && idx < QUOTES.length);
  });

  it("rolling bucket: 13h increments at multiples of 13h from epoch", () => {
    // Two timestamps exactly 13h apart should map to different
    // seeds. (In UTC-anchored form they might also differ, but
    // here we just verify the rolling math: atBoundary+13h and
    // atBoundary differ by exactly one bucket.)
    const thirteenH = 13 * 3_600_000;
    const k = Math.floor(nowMs / thirteenH);
    const atBoundary = k * thirteenH;
    const a = quoteIndex(f("13h"), atBoundary);
    const b = quoteIndex(f("13h"), atBoundary + thirteenH);
    // a and b are guaranteed to differ: atBoundary+thirteenH is in
    // the next bucket by exactly 1, so seed increments by 1.
    assert.equal(b - a, 1);
  });

  it("numeric 130m parses and returns valid index", () => {
    const idx = quoteIndex(f("130m"), nowMs);
    assert.ok(idx >= 0 && idx < QUOTES.length);
  });

  it("all 4 unit letters return a valid in-range index", () => {
    const freqs = ["d", "h", "m", "s"];
    for (const raw of freqs) {
      const idx = quoteIndex(f(raw), nowMs);
      assert.ok(idx >= 0 && idx < QUOTES.length, `freq=${raw} idx=${idx}`);
    }
  });

  it("handles negative nowMs (clock skew) gracefully", () => {
    const idx = quoteIndex(f("h"), -1);
    assert.ok(idx >= 0 && idx < QUOTES.length);
  });
});

describe("quotes — buildRainbow", () => {
  it("empty string returns empty", () => {
    assert.equal(buildRainbow("", 0), "");
  });

  it("produces one SGR wrap per character", () => {
    const out = buildRainbow("abc", 0);
    const opens = (out.match(/\x1b\[38;5;\d+m/g) ?? []).length;
    const closes = (out.match(/\x1b\[0m/g) ?? []).length;
    assert.equal(opens, 3);
    assert.equal(closes, 3);
  });

  it("each character uses a palette index from RAINBOW_PALETTE", () => {
    const out = buildRainbow("abcd", 0);
    const colors = [...out.matchAll(/\x1b\[38;5;(\d+)m/g)].map((m) =>
      Number(m[1]!),
    );
    assert.equal(colors.length, 4);
    // Palette indices are 16-231 range; we use 39,45,99,201,208,220.
    for (const c of colors) {
      assert.ok([39, 45, 99, 201, 208, 220].includes(c), `unexpected color ${c}`);
    }
  });

  it("same text + same seed = identical output (deterministic)", () => {
    const a = buildRainbow("hello world", 0);
    const b = buildRainbow("hello world", 0);
    assert.equal(a, b);
  });

  it("different seeds rotate the palette offset", () => {
    const a = buildRainbow("abc", 0);
    const b = buildRainbow("abc", 1);
    assert.notEqual(a, b);
    // Both should be valid output (3 chars wrapped).
    assert.equal((a.match(/\x1b\[38;5;\d+m/g) ?? []).length, 3);
    assert.equal((b.match(/\x1b\[38;5;\d+m/g) ?? []).length, 3);
  });

  it("preserves newlines verbatim (no SGR wrapping)", () => {
    const out = buildRainbow("a\nb", 0);
    assert.ok(out.includes("\n"));
    // 2 chars (excluding \n) → 2 wraps, not 3.
    const opens = (out.match(/\x1b\[38;5;\d+m/g) ?? []).length;
    assert.equal(opens, 2);
  });
});

describe("quotes — buildHue", () => {
  it("empty string returns empty", () => {
    assert.equal(buildHue("", 0), "");
  });

  it("produces a single SGR wrap for the whole text", () => {
    const out = buildHue("hello world", 0);
    assert.match(out, /^\x1b\[38;5;\d+mhello world\x1b\[0m$/);
  });

  it("same text = same hue (deterministic per text)", () => {
    assert.equal(buildHue("hello", 0), buildHue("hello", 0));
  });

  it("different texts land on different hues (with overwhelming probability)", () => {
    const a = buildHue("If you can dream it, you can do it.", 0);
    const b = buildHue("千里之行，始于足下。", 0);
    assert.notEqual(a, b);
  });

  it("hue index falls in the 6×6×6 cube range (16..231)", () => {
    const texts = ["a", "hello", "Stay hungry, stay foolish.", "千里之行"];
    for (const t of texts) {
      const out = buildHue(t, 0);
      const m = out.match(/^\x1b\[38;5;(\d+)m/);
      assert.ok(m, `no SGR prefix in: ${out}`);
      const idx = Number(m![1]!);
      assert.ok(
        idx >= 16 && idx <= 231,
        `idx ${idx} not in 6x6x6 cube for: ${t}`,
      );
    }
  });
});

describe("lineTemplate — m_quote inline-args", () => {
  beforeEach(() => {
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      statuslineTemplate:["m_quote"],
    });
  });
  afterEach(() => __resetForTest());

  it("bare m_quote emits a plain (non-SGR) quote", () => {
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(QUOTES.includes(line), `got: ${line}`);
    // No SGR wraps in the bare form.
    assert.ok(!line.includes("\x1b["), `bare m_quote should not include SGR, got: ${line}`);
  });

  it("m_quote:color:red wraps the quote in red SGR + RESET", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(line.startsWith("\x1b[38;5;196m"), `got: ${line}`);
    assert.ok(line.endsWith(RESET), `got: ${line}`);
    // The wrapped text should still be a known quote.
    const inner = line.slice("\x1b[38;5;196m".length, -RESET.length);
    assert.ok(QUOTES.includes(inner), `inner: ${JSON.stringify(inner)}`);
  });

  it("m_quote:color:rainbow produces per-character multi-color output", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:color:rainbow"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    // Multiple distinct 256-color wraps expected.
    const colors = new Set(
      [...line.matchAll(/\x1b\[38;5;(\d+)m/g)].map((m) => m[1]!),
    );
    assert.ok(colors.size >= 2, `expected ≥2 distinct colors, got: ${[...colors]}`);
    // Each wrap closes with RESET.
    const opens = (line.match(/\x1b\[38;5;\d+m/g) ?? []).length;
    const closes = (line.match(/\x1b\[0m/g) ?? []).length;
    assert.equal(opens, closes);
  });

  it("m_quote:color:rand-rainbow uses a different palette offset than :rainbow", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:color:rainbow"],
    });
    const a = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    __resetForTest({
      statuslineTemplate:["m_quote:color:rand-rainbow"],
    });
    const b = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    // Same quote (same time + same default freq), different palette
    // rotation → distinct output. (Both have the same number of
    // wraps; the wrap colors differ.)
    assert.notEqual(a, b);
  });

  it("m_quote:color:hue emits one SGR wrap around the whole quote", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:color:hue"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.match(line, /^\x1b\[38;5;\d+m.+\x1b\[0m$/);
    // Exactly one wrap, not per-character.
    const opens = (line.match(/\x1b\[38;5;\d+m/g) ?? []).length;
    assert.equal(opens, 1);
  });

  it("m_quote:freq:d uses the day bucket (1 quote per day)", () => {
    // Use a timestamp aligned to a UTC midnight so the day bucket
    // doesn't shift on a non-aligned base. 1_700_006_400_000 =
    // 2023-11-15 00:00:00 UTC; adding 6h stays in the same day.
    const baseMs = 1_700_006_400_000;
    __resetForTest({
      statuslineTemplate:["m_quote:freq:d"],
    });
    const a = renderProviderLine("minimax", {
      mode: "used",
      nowMs: baseMs,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    const b = renderProviderLine("minimax", {
      mode: "used",
      nowMs: baseMs + 6 * 3_600_000, // +6h, same UTC day
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.equal(a, b);
  });

  it("m_quote:freq:m uses the minute bucket (1 quote per minute)", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:freq:m"],
    });
    const a = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    const b = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000 + 60_000, // +1m
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.notEqual(a, b);
  });

  it("m_quote:freq:hd uses the half-day bucket", () => {
    // Half-day bucket = 12h, anchored to UTC midnight. Pick baseMs
    // = 1_700_006_400_000 (2023-11-15 00:00:00 UTC) so the bucket
    // index is consistent across the shift.
    const baseMs = 1_700_006_400_000;
    __resetForTest({
      statuslineTemplate:["m_quote:freq:hd"],
    });
    const a = renderProviderLine("minimax", {
      mode: "used",
      nowMs: baseMs,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    const b = renderProviderLine("minimax", {
      mode: "used",
      nowMs: baseMs + 6 * 3_600_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.equal(a, b);
  });

  it("m_quote:freq:hh uses the half-hour bucket", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:freq:hh"],
    });
    const a = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    // +10min: same half-hour.
    const b = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000 + 10 * 60_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.equal(a, b);
  });

  it("m_quote:freq:bogus drops and warns (parse failure)", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:freq:bogus"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used",
        nowMs: 1_700_000_000_000,
        fiveHour: null,
        weekly: null,
        balance: null,
        ageMs: null,
        stale: false,
        version: "",
      }),
    );
    assert.equal(line, "");
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      1,
    );
  });

  it("m_quote:color:bogus drops and warns (parse failure)", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:color:bogus"],
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used",
        nowMs: 1_700_000_000_000,
        fiveHour: null,
        weekly: null,
        balance: null,
        ageMs: null,
        stale: false,
        version: "",
      }),
    );
    assert.equal(line, "");
    assert.equal(
      warns.filter((w) => w.includes("unknown lineTemplate module")).length,
      1,
    );
  });

  it("m_quote:freq:h:color:red renders red with the hourly quote", () => {
    __resetForTest({
      statuslineTemplate:["m_quote:freq:h:color:red"],
    });
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: 1_700_000_000_000,
      fiveHour: null,
      weekly: null,
      balance: null,
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(line.startsWith("\x1b[38;5;196m"), `got: ${line}`);
    // Same as bare m_quote at this time → quote is the same.
    const inner = line.slice("\x1b[38;5;196m".length, -RESET.length);
    const hourFreq = parseFreq("h")!;
    assert.equal(inner, pickQuote(hourFreq, 1_700_000_000_000));
  });

  it("bare m_quote across all freqs covers a wide index range", () => {
    // Sample 24 consecutive hours (1 day) with freq=h. We expect
    // up to 24 different indices (in practice some collide).
    const indices = new Set<number>();
    const hourFreq = parseFreq("h")!;
    for (let h = 0; h < 24; h++) {
      indices.add(quoteIndex(hourFreq, 1_700_000_000_000 + h * 3_600_000));
    }
    // Loose lower bound: at least 5 unique in 24 hours (statistically
    // very likely; just guarding against degenerate buckets).
    assert.ok(
      indices.size >= 5,
      `expected ≥5 unique indices across 24 hours, got ${indices.size}`,
    );
  });
});