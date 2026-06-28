// v0.3.5+ — Tests for the m_quote module + supporting helpers in
// src/quotes.ts and src/render.ts.
//
// Covers:
//   - pickQuote: bucket stability (same freq + same window = same
//     quote), bucket rollover (different windows = may differ), and
//     the 5 freq values land in expected ranges.
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
  pickQuote,
  quoteIndex,
  QUOTES,
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

describe("quotes — pickQuote / quoteIndex", () => {
  const nowMs = 1_700_000_000_000; // fixed reference time for deterministic tests

  it("same freq + same nowMs → same quote (bucket stability)", () => {
    const a = pickQuote("h", nowMs);
    const b = pickQuote("h", nowMs);
    assert.equal(a, b);
  });

  it("same freq + slightly later nowMs in the same hour bucket → same quote", () => {
    const a = pickQuote("h", nowMs);
    const b = pickQuote("h", nowMs + 30 * 60_000); // +30min, still in same hour
    assert.equal(a, b);
  });

  it("same freq + a later hour bucket → may differ", () => {
    const b = pickQuote("h", nowMs + 3_600_000); // +1h
    // The chance of collision is 1/QUOTES.length ≈ 0.9%. Asserting
    // "may differ" with a fixed time → we just check the index
    // changed (which is what we actually care about).
    assert.notEqual(quoteIndex("h", nowMs), quoteIndex("h", nowMs + 3_600_000));
    assert.ok(b.length > 0);
  });

  it("m vs h picks different buckets (smaller bucket = more rotation)", () => {
    // Two adjacent calls in the same hour: h returns same index,
    // m may differ. Verify m advances its index between minutes.
    const idxH = quoteIndex("h", nowMs);
    const idxHPlus1m = quoteIndex("h", nowMs + 60_000);
    const idxM = quoteIndex("m", nowMs);
    const idxMPlus1m = quoteIndex("m", nowMs + 60_000);
    assert.equal(idxH, idxHPlus1m);
    assert.notEqual(idxM, idxMPlus1m);
  });

  it("all 5 freq values return a valid in-range index", () => {
    const freqs = ["d", "hd", "h", "hh", "m"] as const;
    for (const f of freqs) {
      const idx = quoteIndex(f, nowMs);
      assert.ok(idx >= 0 && idx < QUOTES.length, `freq=${f} idx=${idx}`);
    }
  });

  it("handles negative nowMs (clock skew) gracefully", () => {
    const idx = quoteIndex("h", -1);
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
      lineTemplate: {
        plan: ["m_quote"],
        balance: ["m_quote"],
      },
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
      lineTemplate: {
        plan: ["m_quote:color:red"],
        balance: ["m_quote:color:red"],
      },
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
      lineTemplate: {
        plan: ["m_quote:color:rainbow"],
        balance: ["m_quote:color:rainbow"],
      },
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
      lineTemplate: {
        plan: ["m_quote:color:rainbow"],
        balance: ["m_quote:color:rainbow"],
      },
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
      lineTemplate: {
        plan: ["m_quote:color:rand-rainbow"],
        balance: ["m_quote:color:rand-rainbow"],
      },
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
      lineTemplate: {
        plan: ["m_quote:color:hue"],
        balance: ["m_quote:color:hue"],
      },
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
      lineTemplate: {
        plan: ["m_quote:freq:d"],
        balance: ["m_quote:freq:d"],
      },
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
      lineTemplate: {
        plan: ["m_quote:freq:m"],
        balance: ["m_quote:freq:m"],
      },
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
      lineTemplate: {
        plan: ["m_quote:freq:hd"],
        balance: ["m_quote:freq:hd"],
      },
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
      lineTemplate: {
        plan: ["m_quote:freq:hh"],
        balance: ["m_quote:freq:hh"],
      },
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
      lineTemplate: {
        plan: ["m_quote:freq:bogus"],
        balance: ["m_quote:freq:bogus"],
      },
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
      lineTemplate: {
        plan: ["m_quote:color:bogus"],
        balance: ["m_quote:color:bogus"],
      },
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
      lineTemplate: {
        plan: ["m_quote:freq:h:color:red"],
        balance: ["m_quote:freq:h:color:red"],
      },
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
    assert.equal(inner, pickQuote("h", 1_700_000_000_000));
  });

  it("bare m_quote across all freqs covers a wide index range", () => {
    // Sample 24 consecutive hours (1 day) with freq=h. We expect
    // up to 24 different indices (in practice some collide).
    const indices = new Set<number>();
    for (let h = 0; h < 24; h++) {
      indices.add(quoteIndex("h", 1_700_000_000_000 + h * 3_600_000));
    }
    // Loose lower bound: at least 5 unique in 24 hours (statistically
    // very likely; just guarding against degenerate buckets).
    assert.ok(
      indices.size >= 5,
      `expected ≥5 unique indices across 24 hours, got ${indices.size}`,
    );
  });
});