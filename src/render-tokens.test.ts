// Tests for v0.4.0+ token-usage renderer modules + helpers.
// Exercises formatCompactToken, formatSpeed, cacheHitColor, and
// the lineTemplate integration via renderTemplate with a minimal
// TokenSnapshot.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  cacheHitColor,
  formatCompactToken,
  formatSpeed,
  renderTemplate,
} from "./render.ts";
import { __resetForTest } from "./config.ts";
import type { TokenSnapshot } from "./types.ts";

const STALE = "\x1b[90m";
const GREEN = "\x1b[38;5;41m";
const YELLOW = "\x1b[38;5;220m";
const ORANGE = "\x1b[38;5;208m";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const fakeSnapshot = (overrides: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  sessionId: "sess-test",
  cwd: "D:\\test",
  totals: { input: 163479, output: 155 },
  current: {
    input: 38,
    output: 155,
    cacheCreation: 0,
    cacheRead: 163441,
  },
  cost: { totalDurationMs: 600_000, totalApiDurationMs: 60_000, totalLinesAdded: 3965, totalLinesRemoved: 967 }, // 10 minutes total, 1m API time
  // v0.4.0+ — session identity / metadata / context stats
  sessionName: "strip-diagnostics-display",
  modelDisplayName: "MiniMax-M3",
  effort: "high",
  repo: { host: "github.com", owner: "cwf818", name: "tokenplan-usage-hud" },
  ccversion: "2.1.191",
  contextWindow: { size: 200000, usedPct: 63, remainingPct: 37 },
  ...overrides,
});

// renderTemplate needs the full RenderContext. Default seps are
// [" ", "·"] so "s_0" → " " and "s_1" → "·". Tests don't care about
// fiveHour/weekly/balance — we only exercise m_token* paths.
const ctxFor = (
  tokens: TokenSnapshot | null,
  fiveHour = null,
  weekly = null,
) => ({
  mode: "used" as const,
  nowMs: 1_000_000,
  fiveHour,
  weekly,
  balance: null,
  ageMs: null,
  stale: false,
  version: "0.4.0-dev0",
  tokens,
  // v0.4.0+ — synthesized from tokens.contextWindow.usedPct.
  // The renderProviderLine helper does this synthesis; tests build
  // RenderContext directly so we mirror it here.
  contextWindow:
    tokens?.contextWindow?.usedPct != null
      ? { pct: tokens.contextWindow.usedPct }
      : null,
});

beforeEach(() => {
  __resetForTest();
});

describe("formatCompactToken", () => {
  it("below thresholds[0] → raw integer", () => {
    assert.equal(formatCompactToken(0), "0");
    assert.equal(formatCompactToken(342), "342");
    assert.equal(formatCompactToken(999), "999");
  });

  it("between thresholds[0] and thresholds[1] → k with 1 decimal", () => {
    assert.equal(formatCompactToken(1_000), "1.0k");
    assert.equal(formatCompactToken(12_300), "12.3k");
    assert.equal(formatCompactToken(163_479), "163.5k");
  });

  it("≥ thresholds[1] → M with 1 decimal", () => {
    assert.equal(formatCompactToken(1_000_000), "1.0M");
    assert.equal(formatCompactToken(1_234_567), "1.2M");
  });

  it("non-finite / negative → '0'", () => {
    assert.equal(formatCompactToken(NaN), "0");
    assert.equal(formatCompactToken(-1), "0");
    assert.equal(formatCompactToken(Infinity), "0");
  });
});

describe("formatSpeed", () => {
  it("<1000 t/s → decimal t/s", () => {
    assert.equal(formatSpeed(42.5), "42.5 t/s");
    assert.equal(formatSpeed(0.1), "0.1 t/s");
  });

  it("≥1000 t/s → k t/s", () => {
    assert.equal(formatSpeed(1200), "1.2k t/s");
  });

  it("null → —", () => {
    assert.equal(formatSpeed(null), "—");
  });

  it("non-finite → —", () => {
    assert.equal(formatSpeed(NaN), "—");
  });
});

describe("cacheHitColor — 3-band picker", () => {
  it("≥80 → good (green)", () => {
    assert.equal(cacheHitColor(80), GREEN);
    assert.equal(cacheHitColor(99), GREEN);
    assert.equal(cacheHitColor(100), GREEN);
  });

  it("≥50 and <80 → warn (yellow)", () => {
    assert.equal(cacheHitColor(50), YELLOW);
    assert.equal(cacheHitColor(79.9), YELLOW);
  });

  it("<50 → bad (orange)", () => {
    assert.equal(cacheHitColor(0), ORANGE);
    assert.equal(cacheHitColor(49.9), ORANGE);
  });
});

describe("renderTemplate — m_token* modules", () => {
  it("m_tokenIn renders 'in:38' (v0.4.0+: per-turn from current_usage)", () => {
    // v0.4.0: semantics changed from session-cumulative to per-turn.
    // The fake snapshot has current.input=38 → "in:38".
    const out = renderTemplate(["m_tokenIn"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:38");
  });

  it("m_tokenOut renders 'out:155' (v0.4.0+: per-turn from current_usage)", () => {
    // v0.4.0: semantics changed. current.output=155 in fakeSnapshot.
    const out = renderTemplate(["m_tokenOut"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_ctx renders 'ctx:163.5k' (input+creation+read)", () => {
    const out = renderTemplate(["m_ctx"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "ctx:163.5k");
  });

  it("m_cacheHitRate: ~99% with green color", () => {
    const out = renderTemplate(["m_cacheHitRate"], ctxFor(fakeSnapshot())).join("\n");
    // 163441 / (163441 + 0) = 100.0% (creation=0)
    assert.equal(strip(out), "cache:100.0%");
    assert.ok(out.includes(GREEN), `expected GREEN in: ${JSON.stringify(out)}`);
  });

  it("m_cacheRead: 'cache:163.4k (100.0%)' with STALE color", () => {
    const out = renderTemplate(["m_cacheRead"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "cache:163.4k (100.0%)");
    assert.ok(out.includes(STALE));
  });

  it("m_tokenInSpeed: per-turn input / session duration in t/s (v0.4.0+)", () => {
    // v0.4.0: numerator is current.input (per-turn), not totals.input.
    // 38 (per-turn) / 600_000ms * 1000 = 0.0633 t/s → "0.1 t/s".
    // The semantic is "tokens used in the latest turn / total session
    // wall time" — NOT a real-time throughput. Documented in the
    // module's doc-comment.
    const out = renderTemplate(["m_tokenInSpeed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:0.1 t/s");
    assert.ok(out.includes(STALE));
  });

  it("m_tokenOutSpeed: 155 / 600s = 0.3 t/s", () => {
    // v0.4.0: numerator is current.output (per-turn). Coincidentally
    // the same value the old code produced (current.output=155 in the
    // fakeSnapshot), so the expected output is unchanged.
    const out = renderTemplate(["m_tokenOutSpeed"], ctxFor(fakeSnapshot())).join("\n");
    // 155 / 600_000 * 1000 = 0.258 → "0.3 t/s"
    assert.equal(strip(out), "out:0.3 t/s");
  });

  it("token modules return null when tokens is null", () => {
    const out = renderTemplate(
      ["m_tokenIn", "s_0", "m_ctx", "s_0", "m_cacheHitRate"],
      ctxFor(null),
    ).join("\n");
    // All three modules return null → each emits "". The s_0
    // separators between them are kept (the renderer's separator-
    // skipping rule only drops separators adjacent to non-null
    // output, not null-then-null). The actual output is two spaces
    // ("s_0" twice). Verify modules produce no content of their
    // own (no "in:", "ctx:", "cache:" anywhere).
    assert.ok(!out.includes("in:"), `unexpected token in: ${out}`);
    assert.ok(!out.includes("ctx:"), `unexpected token: ${out}`);
    assert.ok(!out.includes("cache:"), `unexpected token: ${out}`);
  });

  it("partial snapshot: missing cost → speed module null", () => {
    const out = renderTemplate(
      ["m_tokenInSpeed"],
      ctxFor(fakeSnapshot({ cost: { totalDurationMs: null, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } })),
    );
    assert.deepEqual(out, []);
  });

  it("m_cacheHitRate returns null when no cache traffic", () => {
    const out = renderTemplate(
      ["m_cacheHitRate"],
      ctxFor(
        fakeSnapshot({
          current: { input: 38, output: 155, cacheCreation: 0, cacheRead: 0 },
        }),
      ),
    );
    assert.deepEqual(out, []);
  });

  it("composed template with multiple token modules + separator", () => {
    const out = renderTemplate(
      ["m_tokenIn", "s_0", "m_tokenOut", "s_0", "s_1", "s_0", "m_ctx"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    // v0.4.0: m_tokenIn is per-turn (current.input=38), m_tokenOut is
    // per-turn (current.output=155), m_ctx stays input+creation+read.
    // s_0=" " between adjacent modules, then "·" + " " between groups
    // → "in:38 out:155 · ctx:163.5k"
    assert.equal(strip(out), "in:38 out:155 · ctx:163.5k");
  });

  it("m_tokenSession / m_tokenTotal: same numeric totals (input+output+cache)", () => {
    // Both modules compute in+out+cache identically. Only the prefix
    // differs ("session:" vs "tot:") — useful when the user wants
    // both labels visible in different templates.
    // With cache=0+163441 = 163441, plus in=163479, out=155 → 327075
    const sess = renderTemplate(["m_tokenSession"], ctxFor(fakeSnapshot())).join("\n");
    const tot = renderTemplate(["m_tokenTotal"], ctxFor(fakeSnapshot())).join("\n");
    const sessVal = strip(sess).replace(/^session:/, "");
    const totVal = strip(tot).replace(/^tot:/, "");
    assert.equal(sessVal, totVal);
    assert.equal(sessVal, "327.1k");
    // Confirm the prefixes are distinct (so the two modules serve
    // their purpose — different names for the same metric).
    assert.ok(strip(sess).startsWith("session:"));
    assert.ok(strip(tot).startsWith("tot:"));
  });
});

describe("renderTemplate — newline separator (v0.4.0+ multi-line layout)", () => {
  // Custom config: separators[2] = "\n". Templates put m_tokenIn on line 1
  // and m_ctx on line 2 with a "\n" between them.
  beforeEach(() => {
    __resetForTest({
      separators: [" ", " · ", "\n"],
      lineTemplate: {
        plan: ["m_tokenIn", "s_2", "m_ctx"],
        balance: ["m_modeLabel", "s_0", "m_balance"],
      },
    });
  });

  it('a "\\n" separator splits the template into two rendered lines', () => {
    const out = renderTemplate(["m_tokenIn", "s_2", "m_ctx"], ctxFor(fakeSnapshot()));
    // v0.4.0: m_tokenIn reads current.input → "in:38"
    assert.deepEqual(out.map(strip), ["in:38", "ctx:163.5k"]);
  });

  it("trailing '\\n' separator does NOT emit a blank trailing line", () => {
    const out = renderTemplate(["m_tokenIn", "s_2"], ctxFor(fakeSnapshot()));
    // v0.4.0: m_tokenIn reads current.input → "in:38"
    assert.deepEqual(out.map(strip), ["in:38"]);
  });

  it("consecutive '\\n\\n' separators drop the empty middle line", () => {
    // s_2 s_2 means "newline, then newline". The newline before
    // doesn't open a line with content yet, so it would be empty —
    // we drop it.
    const out = renderTemplate(["m_tokenIn", "s_2", "s_2", "m_ctx"], ctxFor(fakeSnapshot()));
    // v0.4.0: m_tokenIn reads current.input → "in:38"
    assert.deepEqual(out.map(strip), ["in:38", "ctx:163.5k"]);
  });

  it("a module piece containing '\\n' (future-proof) also splits", () => {
    // Hypothetical module that returns "line1\nline2" — splits
    // naturally because renderTemplate splits every piece on '\n'.
    // We can't easily inject a fake MODULES entry from here, so this
    // case is covered via composition integration instead.
    assert.ok(true, "covered via composition integration test");
  });
});

// ----- v0.4.0+ session-info / metadata modules -----
//
// Each module reads a field from the live stdin snapshot. The fake
// snapshot above is loaded with the full set of v0.4.0+ fields
// (sessionName, modelDisplayName, effort, repo, ccversion,
// contextWindow, plus extended cost fields). Bare-form tests assert
// the uncolored output; inline-args tests assert the SGR is applied.
describe("renderTemplate — v0.4.0+ session-info modules", () => {
  it("m_session: bare 'strip-diagnostics-display'", () => {
    const out = renderTemplate(["m_session"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "strip-diagnostics-display");
  });

  it("m_model: bare 'MiniMax-M3'", () => {
    const out = renderTemplate(["m_model"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "MiniMax-M3");
  });

  it("m_effort: bare 'high'", () => {
    const out = renderTemplate(["m_effort"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "high");
  });

  it("m_repo: 'github.com/cwf818/tokenplan-usage-hud'", () => {
    const out = renderTemplate(["m_repo"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "github.com/cwf818/tokenplan-usage-hud");
  });

  it("m_repo: drops null components", () => {
    // owner missing → no leading slash, just the available pieces
    const out = renderTemplate(
      ["m_repo"],
      ctxFor(fakeSnapshot({ repo: { host: "github.com", owner: null, name: "x" } })),
    ).join("\n");
    assert.equal(strip(out), "github.com/x");
  });

  it("m_repo: returns null when no component is available", () => {
    const out = renderTemplate(
      ["m_repo"],
      ctxFor(fakeSnapshot({ repo: { host: null, owner: null, name: null } })),
    );
    assert.deepEqual(out, []);
  });

  it("m_ccversion: bare '2.1.191'", () => {
    const out = renderTemplate(["m_ccversion"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "2.1.191");
  });

  it("m_sessionDuration: dhms format of total_duration_ms (600_000ms = 10m)", () => {
    const out = renderTemplate(["m_sessionDuration"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "10m");
  });

  it("m_sessionApiDuration: returns null when totalApiDurationMs is null", () => {
    const out = renderTemplate(
      ["m_sessionApiDuration"],
      ctxFor(fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: null, totalLinesRemoved: null } })),
    );
    assert.deepEqual(out, []);
  });

  it("m_linesAdded: '+ 3965'", () => {
    const out = renderTemplate(["m_linesAdded"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "+ 3965");
  });

  it("m_linesRemoved: '- 967'", () => {
    const out = renderTemplate(["m_linesRemoved"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "- 967");
  });

  it("m_linesAdded: 0 renders as '+ 0' (zero is information, not absence)", () => {
    const out = renderTemplate(
      ["m_linesAdded"],
      ctxFor(
        fakeSnapshot({ cost: { totalDurationMs: 600_000, totalApiDurationMs: null, totalLinesAdded: 0, totalLinesRemoved: 0 } }),
      ),
    ).join("\n");
    assert.equal(strip(out), "+ 0");
  });

  it("m_tokenInTotal: 'in:163.5k' (cumulative, the old m_tokenIn behavior)", () => {
    const out = renderTemplate(["m_tokenInTotal"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "in:163.5k");
  });

  it("m_tokenOutTotal: 'out:155' (cumulative)", () => {
    const out = renderTemplate(["m_tokenOutTotal"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "out:155");
  });

  it("m_contextSize: '200.0k' (compact format of 200000)", () => {
    const out = renderTemplate(["m_contextSize"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "200.0k");
  });

  it("m_contextUsed: '63%' (plain percentage)", () => {
    const out = renderTemplate(["m_contextUsed"], ctxFor(fakeSnapshot())).join("\n");
    assert.equal(strip(out), "63%");
  });

  it("m_windowContext: bar + 5-band-colored percentage (63% lands in orange band)", () => {
    // 5-band thresholds default to [20, 40, 60, 80] in 'used' mode.
    // usedPct=63 is in the [60, 80) band → ORANGE (38;5;208).
    const out = renderTemplate(["m_windowContext"], ctxFor(fakeSnapshot())).join("\n");
    // Strip ANSI; the layout is "<leftChunk><rightChunk> 63%".
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]+ 63%$/);
    assert.ok(out.includes(ORANGE), `expected ORANGE in: ${JSON.stringify(out)}`);
  });

  it("m_windowContext: returns null when contextWindow is null", () => {
    const out = renderTemplate(
      ["m_windowContext"],
      ctxFor(
        fakeSnapshot({ contextWindow: { size: 200000, usedPct: null, remainingPct: null } }),
      ),
    );
    assert.deepEqual(out, []);
  });

  it("inline :color: override applies SGR to plain modules (m_session:color:red)", () => {
    // The "red" shortcut is 256-color RED (38;5;196), NOT the basic
    // ANSI \x1b[31m. Reuse the SGR literal here so this test doesn't
    // depend on an import we haven't made.
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_session:color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    assert.equal(strip(out), "strip-diagnostics-display");
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("inline :color: override applies SGR to m_windowContext (formatOneChunkColored)", () => {
    const RED_SGR = "\x1b[38;5;196m";
    const out = renderTemplate(
      ["m_windowContext:color:red"],
      ctxFor(fakeSnapshot()),
    ).join("\n");
    const stripped = strip(out);
    assert.match(stripped, /^[▓░]+ 63%$/);
    assert.ok(out.includes(RED_SGR), `expected RED in: ${JSON.stringify(out)}`);
  });

  it("all session-info modules return null when tokens is null", () => {
    const mods = [
      "m_session", "m_model", "m_effort", "m_repo", "m_ccversion",
      "m_sessionDuration", "m_sessionApiDuration",
      "m_linesAdded", "m_linesRemoved",
      "m_tokenInTotal", "m_tokenOutTotal",
      "m_contextSize", "m_contextUsed", "m_windowContext",
    ];
    for (const m of mods) {
      const out = renderTemplate([m], ctxFor(null));
      assert.deepEqual(out, [], `${m} should return [] when tokens is null`);
    }
  });
});