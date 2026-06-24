import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isMiniMaxBaseUrl, parseRemains } from "./api.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(here, "__fixtures__", name), "utf8"));

describe("isMiniMaxBaseUrl", () => {
  it("matches api.minimaxi.com host", () => {
    assert.equal(isMiniMaxBaseUrl("https://api.minimaxi.com"), true);
  });
  it("matches with /anthropic path suffix", () => {
    assert.equal(isMiniMaxBaseUrl("https://api.minimaxi.com/anthropic"), true);
  });
  it("is case-insensitive", () => {
    assert.equal(isMiniMaxBaseUrl("https://API.MiniMaxI.com"), true);
  });
  it("rejects vanilla Anthropic", () => {
    assert.equal(isMiniMaxBaseUrl("https://api.anthropic.com"), false);
  });
  it("rejects empty / undefined", () => {
    assert.equal(isMiniMaxBaseUrl(""), false);
    assert.equal(isMiniMaxBaseUrl(undefined), false);
    assert.equal(isMiniMaxBaseUrl(null), false);
  });
});

describe("parseRemains — model_remains array shape (real)", () => {
  it("parses the captured real fixture", () => {
    const r = parseRemains(fixture("remains.real.json"));
    assert.ok(r);
    // Most active model is "general" with interval remaining 66%, weekly 61%.
    // → used% = 34% interval, 39% weekly.
    assert.equal(r.fiveHour?.pct, 34);
    assert.equal(r.weekly?.pct, 39);
    assert.equal(typeof r.fiveHour?.resetAt, "string");
    assert.equal(typeof r.weekly?.resetAt, "string");
  });

  it("picks the most-active entry (lowest interval_remaining_percent)", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "video",
          current_interval_remaining_percent: 100,
          current_weekly_remaining_percent: 100,
        },
        {
          model_name: "general",
          current_interval_remaining_percent: 20,
          current_weekly_remaining_percent: 50,
        },
      ],
    });
    assert.ok(r);
    assert.equal(r.fiveHour?.pct, 80); // 100 - 20
    assert.equal(r.weekly?.pct, 50); // 100 - 50
  });

  it("uses weekly percent when interval percent is absent", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "general",
          // no interval percent
          current_weekly_remaining_percent: 75,
        },
      ],
    });
    assert.ok(r);
    // Interval has no data → null; weekly 75% remaining → 25% used.
    assert.equal(r.fiveHour, null);
    assert.equal(r.weekly?.pct, 25);
  });

  it("derives used% from raw counts when percentages absent", () => {
    const r = parseRemains({
      model_remains: [
        {
          model_name: "general",
          current_interval_total_count: 100,
          current_interval_usage_count: 80,
          current_weekly_total_count: 1000,
          current_weekly_usage_count: 200,
        },
      ],
    });
    assert.ok(r);
    assert.equal(r.fiveHour?.pct, 80);
    assert.equal(r.weekly?.pct, 20);
  });
});

describe("parseRemains — legacy single-window shape", () => {
  it("parses snake_case flat shape", () => {
    const r = parseRemains({
      five_hour: { remaining: 60, limit: 100 },
      weekly: { remaining: 400, limit: 1000 },
    });
    assert.ok(r);
    assert.equal(r.fiveHour?.pct, 40);
    assert.equal(r.weekly?.pct, 60);
  });

  it("parses data-envelope shape", () => {
    const r = parseRemains({
      data: {
        five_hour: { remaining: 25, limit: 100 },
        weekly: { remaining: 750, limit: 1000 },
      },
    });
    assert.ok(r);
    assert.equal(r.fiveHour?.pct, 75);
    assert.equal(r.weekly?.pct, 25);
  });

  it("returns null on non-zero base_resp.status_code", () => {
    assert.equal(parseRemains(fixture("remains.empty.json")), null);
  });

  it("returns null when no recognizable windows", () => {
    assert.equal(parseRemains({ data: { something: "else" } }), null);
  });

  it("handles malformed input gracefully", () => {
    assert.equal(parseRemains(null), null);
    assert.equal(parseRemains(undefined), null);
    assert.equal(parseRemains("string"), null);
    assert.equal(parseRemains(42), null);
    assert.equal(parseRemains([]), null);
  });
});