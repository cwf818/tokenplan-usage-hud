import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildProviderLine, type FetchResult } from "./dispatch.ts";
import type { Remains } from "./api.ts";
import type { Balance } from "./api.deepseek.ts";

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

describe("buildProviderLine — fresh", () => {
  it("MiniMax: renders the two-window Usage line, no stale suffix", () => {
    const result: FetchResult<Remains> = { kind: "fresh", data: MINI_DATA };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    assert.ok(line!.startsWith("Usage: "));
    assert.ok(!line!.includes("ago"));
  });

  it("DeepSeek: renders the Balance line, no stale suffix", () => {
    const result: FetchResult<Balance> = { kind: "fresh", data: DEEP_DATA };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    assert.ok(line!.startsWith("Balance: "));
    assert.ok(strip(line!).startsWith("Balance: $25"));
    assert.ok(!line!.includes("ago"));
  });

  it("null provider: returns null even with fresh data", () => {
    const result: FetchResult<Remains> = { kind: "fresh", data: MINI_DATA };
    assert.equal(buildProviderLine(null, result), null);
  });
});

describe("buildProviderLine — stale", () => {
  it("MiniMax: appends dim '⛓️‍💥 5m ago' suffix", () => {
    const result: FetchResult<Remains> = { kind: "stale", data: MINI_DATA, ageMs: 5 * 60_000 };
    const line = buildProviderLine("minimax", result);
    assert.ok(line);
    // v0.2.11: broken emoji IS the indicator (no leading " · " separator).
    assert.ok(strip(line!).endsWith("⛓️‍💥 5m ago"));
    assert.ok(line!.endsWith(`${STALE_COLOR}⛓️‍💥 5m ago${RESET}`));
  });

  it("DeepSeek: appends dim '⛓️‍💥 1h30m ago' suffix (maxUnitCount=2, keeps minutes)", () => {
    const result: FetchResult<Balance> = {
      kind: "stale",
      data: DEEP_DATA,
      ageMs: 90 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(line);
    // v0.2.11: maxUnitCount=2 default keeps internal non-zero units.
    // 90 minutes = 1h30m, NOT "1h" (the old behavior).
    assert.ok(strip(line!).endsWith("⛓️‍💥 1h30m ago"));
  });

  it("stale line still renders the actual cached data (not 'not available!')", () => {
    const result: FetchResult<Balance> = {
      kind: "stale",
      data: DEEP_DATA,
      ageMs: 5 * 60_000,
    };
    const line = buildProviderLine("deepseek", result);
    assert.ok(strip(line!).includes("$25"));
    assert.ok(!strip(line!).includes("not available"));
  });
});

describe("buildProviderLine — fail", () => {
  it("MiniMax: renders 'Usage: not available!' in RED", () => {
    const result: FetchResult<Remains> = { kind: "fail" };
    const line = buildProviderLine("minimax", result);
    assert.equal(line, `Usage: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Usage: not available!");
  });

  it("DeepSeek: renders 'Balance: not available!' in RED", () => {
    const result: FetchResult<Balance> = { kind: "fail" };
    const line = buildProviderLine("deepseek", result);
    assert.equal(line, `Balance: ${RED}not available!${RESET}`);
    assert.equal(strip(line!), "Balance: not available!");
  });

  it("null provider: returns null on fail (no line at all)", () => {
    const result: FetchResult<Remains> = { kind: "fail" };
    assert.equal(buildProviderLine(null, result), null);
  });

  it("fail line does NOT carry a stale suffix (nothing to be stale-of)", () => {
    const result: FetchResult<Balance> = { kind: "fail" };
    const line = buildProviderLine("deepseek", result);
    assert.ok(!line!.includes("ago"));
    assert.ok(!line!.includes(STALE_COLOR));
  });
});