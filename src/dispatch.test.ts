import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildProviderLine, type FetchResult } from "./dispatch.ts";
import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";
import { __resetForTest } from "./config.ts";

const RESET = "\x1b[0m";
const RED = "\x1b[38;5;196m";
const STALE_COLOR = "\x1b[90m";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// A minimally valid Remains payload (two windows) — enough for the renderer.
const MINI_DATA: Remains = {
  fiveHour: { pct: 38, resetAt: null },
  weekly: { pct: 39, resetAt: null },
};

// A minimally valid Balance payload.
const DEEP_DATA: Balance = {
  isAvailable: true,
  entries: [{ currency: "USD", totalBalance: 25 }],
  minValue: 25,
};

// Pin config defaults the tests rely on so a future config refactor
// doesn't quietly break the assertions below.
const pinDefaults = () =>
  __resetForTest({
    cacheTtlMs: 60_000,
    stale: {
      ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" },
    },
    timeFormat: { minUnit: "m", maxUnitCount: 2 },
  });

describe("buildProviderLine — fresh (no age suffix; data just arrived)", () => {
  it("MiniMax: fresh tick with ageMs=0 renders no X-ago suffix", () => {
    pinDefaults();
    const result: FetchResult<Remains> = { kind: "fresh", data: MINI_DATA, ageMs: 0 };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(line!.startsWith("Usage: "));
    assert.ok(!line!.includes("ago"));
    assert.ok(!line!.includes(STALE_COLOR));
  });

  it("DeepSeek: fresh tick with ageMs=0 renders no X-ago suffix (no window concept)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = { kind: "fresh", data: DEEP_DATA, ageMs: 0 };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    assert.ok(line!.startsWith("Balance: "));
    assert.ok(strip(line!).startsWith("Balance: $25"));
    assert.ok(!line!.includes("ago"));
  });

  it("MiniMax: within-TTL cache hit (ageMs>0) renders NO age suffix (default template has no m_age)", () => {
    // v0.4.0 priority: template presence wins. Default plan/balance
    // templates do NOT include m_age, so a within-TTL cache hit
    // (fresh, ageMs > 0) renders no suffix — the broken-chain
    // indicator is reserved for stale state. Users opt in to the
    // healthy-emoji path by listing m_age in their lineTemplate.
    pinDefaults();
    const result: FetchResult<Remains> = {
      kind: "fresh",
      data: MINI_DATA,
      ageMs: 30_000,
    };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(!line!.includes("ago"), `got: ${line}`);
    assert.ok(!line!.includes(STALE_COLOR), `got: ${line}`);
  });

  it("DeepSeek: within-TTL cache hit (ageMs>0) renders NO age suffix (default template has no m_age)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = {
      kind: "fresh",
      data: DEEP_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    assert.ok(!line!.includes("ago"), `got: ${line}`);
    assert.ok(!line!.includes(STALE_COLOR), `got: ${line}`);
  });

  it("MiniMax: fresh cache hit WITH m_age in template renders healthy 🔗", () => {
    // v0.4.0 priority: template presence wins. When the user lists
    // m_age in their lineTemplate, the module emits unconditionally
    // (no stale gating). Fresh + ageMs > 0 → 🔗 X ago.
    pinDefaults();
    __resetForTest({
      lineTemplate: {
        plan: [
          "m_label", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "m_age",
        ],
        balance: ["m_label", "s_0", "m_balance"],
      },
    });
    try {
      const result: FetchResult<Remains> = {
        kind: "fresh",
        data: MINI_DATA,
        ageMs: 30_000,
      };
      const line = buildProviderLine("minimax", result);
      assert.ok(line);
      assert.ok(strip(line!).endsWith("🔗 <1m ago"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });

  it("null provider: returns null even with fresh data", () => {
    pinDefaults();
    const result: FetchResult<Remains> = { kind: "fresh", data: MINI_DATA, ageMs: 0 };
    assert.equal(buildProviderLine(null, result), null);
  });
});

describe("buildProviderLine — stale (fetch failed, cache reused; broken emoji)", () => {
  it("MiniMax: appends dim '⛓️‍💥 5m ago' suffix (broken emoji on stale)", () => {
    pinDefaults();
    // Stale-on-error → ageMs from cache.peekWithAge (time since last
    // successful fetch), NOT from any API timestamp.
    const result: FetchResult<Remains> = {
      kind: "stale",
      data: MINI_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(strip(line!).endsWith("⛓️‍💥 5m ago"));
    assert.ok(line!.endsWith(`${STALE_COLOR}⛓️‍💥 5m ago${RESET}`));
  });

  it("DeepSeek: appends dim '⛓️‍💥 1h30m ago' suffix (maxUnitCount=2 keeps minutes)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = {
      kind: "stale",
      data: DEEP_DATA,
      ageMs: 90 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    // 90 minutes = 1h30m, NOT "1h" (maxUnitCount=2 keeps internal non-zero units).
    assert.ok(strip(line!).endsWith("⛓️‍💥 1h30m ago"));
  });

  it("stale line still renders the actual cached data (not 'not available!')", () => {
    pinDefaults();
    const result: FetchResult<Balance> = {
      kind: "stale",
      data: DEEP_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(strip(line!).includes("$25"));
    assert.ok(!strip(line!).includes("not available"));
  });

  it("MiniMax: stale ageMs=0 renders '⛓️‍💥 0m ago' (just-failed fetch)", () => {
    // v0.4.0: formatStaleSuffix no longer short-circuits on ageMs=0.
    // A fetch that just failed at this instant now shows
    // "⛓️‍💥 0m ago" (or "<1s ago" with minUnit=s) instead of a bare
    // emoji. The visibility gate is now stale=true at the renderer.
    pinDefaults();
    const result: FetchResult<Remains> = {
      kind: "stale",
      data: MINI_DATA,
      ageMs: 0,
    };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(strip(line!).endsWith("⛓️‍💥 0m ago"), `got: ${line}`);
  });
});

describe("buildProviderLine — fail", () => {
  it("MiniMax: renders 'Usage: not available!' in RED", () => {
    pinDefaults();
    const result: FetchResult<Remains> = { kind: "fail" };
    const line = buildProviderLine("minimax", result);
    assert.equal(line, `Usage: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Usage: not available!");
  });

  it("DeepSeek: renders 'Balance: not available!' in RED", () => {
    pinDefaults();
    const result: FetchResult<Balance> = { kind: "fail" };
    const line = buildProviderLine("deepseek", result);
    assert.equal(line, `Balance: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Balance: not available!");
  });

  it("null provider: returns null on fail (no line at all)", () => {
    pinDefaults();
    const result: FetchResult<Remains> = { kind: "fail" };
    assert.equal(buildProviderLine(null, result), null);
  });

  it("fail line does NOT carry a stale suffix (nothing to be stale-of)", () => {
    pinDefaults();
    const result: FetchResult<Balance> = { kind: "fail" };
    const line = buildProviderLine("deepseek", result);
    assert.ok(!line!.includes("ago"));
    assert.ok(!line!.includes(STALE_COLOR));
  });
});