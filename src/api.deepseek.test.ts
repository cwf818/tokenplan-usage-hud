import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isDeepSeekBaseUrl, parseBalance } from "./api.deepseek.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

describe("isDeepSeekBaseUrl", () => {
  it("matches api.deepseek.com", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com"), true);
  });
  it("matches trailing slash", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com/"), true);
  });
  it("matches /anthropic path suffix", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com/anthropic"), true);
  });
  it("is case-insensitive", () => {
    assert.equal(isDeepSeekBaseUrl("https://API.DeepSeek.COM/Anthropic"), true);
  });
  it("rejects suffix attacks (api.deepseek.com.evil.example)", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com.evil.example"), false);
  });
  it("rejects api.minimaxi.com", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.minimaxi.com"), false);
  });
  it("rejects http (not https)", () => {
    assert.equal(isDeepSeekBaseUrl("http://api.deepseek.com"), false);
  });
  it("rejects empty / undefined / null", () => {
    assert.equal(isDeepSeekBaseUrl(""), false);
    assert.equal(isDeepSeekBaseUrl(undefined), false);
    assert.equal(isDeepSeekBaseUrl(null), false);
  });
  it("accepts ?query and #fragment", () => {
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com?x=1"), true);
    assert.equal(isDeepSeekBaseUrl("https://api.deepseek.com#frag"), true);
  });
});

describe("parseBalance — single-currency real shape", () => {
  it("parses the captured real fixture", () => {
    const b = parseBalance(fixture("balance.real.json"));
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 1);
    assert.equal(b!.entries[0].currency, "CNY");
    assert.equal(b!.entries[0].totalBalance, 110);
    assert.equal(b!.minValue, 110);
  });
});

describe("parseBalance — multi-currency", () => {
  it("keeps all entries and picks the minimum for color", () => {
    const b = parseBalance(fixture("balance.multi.json"));
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 2);
    assert.deepEqual(
      b!.entries.map((e) => e.totalBalance),
      [110, 3.5]
    );
    // 3.5 < 110 → minValue is the USD entry.
    assert.equal(b!.minValue, 3.5);
  });
});

describe("parseBalance — unavailable / missing fields", () => {
  it("is_available=false → isAvailable=false, empty entries", () => {
    const b = parseBalance({ is_available: false, balance_infos: [] });
    assert.ok(b);
    assert.equal(b!.isAvailable, false);
    assert.equal(b!.entries.length, 0);
    assert.equal(b!.minValue, null);
  });
  it("is_available=true but balance_infos=[] → isAvailable=true, no entries", () => {
    const b = parseBalance({ is_available: true, balance_infos: [] });
    assert.ok(b);
    // We honor the is_available flag literally; the renderer falls back to
    // "not available!" when entries is empty.
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 0);
    assert.equal(b!.minValue, null);
  });
  it("missing balance_infos → isAvailable=true, no entries (renderer decides what to show)", () => {
    const b = parseBalance({ is_available: true });
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 0);
    assert.equal(b!.minValue, null);
  });
  it("entries with non-numeric total_balance are dropped", () => {
    const b = parseBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "abc" },
        { currency: "USD", total_balance: "5" },
      ],
    });
    assert.ok(b);
    assert.equal(b!.isAvailable, true);
    assert.equal(b!.entries.length, 1);
    assert.equal(b!.entries[0].currency, "USD");
    assert.equal(b!.entries[0].totalBalance, 5);
  });
  it("accepts numeric total_balance (not just string)", () => {
    const b = parseBalance({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: 42.5 }],
    });
    assert.ok(b);
    assert.equal(b!.entries[0].totalBalance, 42.5);
  });
  it("rejects non-object input", () => {
    assert.equal(parseBalance(null), null);
    assert.equal(parseBalance(undefined), null);
    assert.equal(parseBalance("string"), null);
    assert.equal(parseBalance(42), null);
  });
  it("tolerates truthy/falsy variants of is_available", () => {
    assert.equal(parseBalance({ is_available: 1, balance_infos: [] })!.isAvailable, true);
    assert.equal(parseBalance({ is_available: "true", balance_infos: [] })!.isAvailable, true);
    assert.equal(parseBalance({ is_available: "false", balance_infos: [] })!.isAvailable, false);
  });
});
