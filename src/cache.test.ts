import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as cache from "./cache.ts";
const { clear, get, peek, peekWithAge, set } = cache;

describe("cache", () => {
  it("returns null on miss", () => {
    clear("k1");
    assert.equal(get("k1"), null);
  });

  it("returns the value within TTL", () => {
    clear("k2");
    set("k2", { foo: 1 });
    assert.deepEqual(get("k2"), { foo: 1 });
  });

  it("returns null after TTL expires", async () => {
    clear("k3");
    set("k3", "v");
    // Past dates always have strictly-greater diff than any positive ttl.
    const past = Date.now() - 10_000;
    (cache as any).store.set("k3", { at: past, value: "v" });
    assert.equal(get("k3", 1000), null);
  });

  it("peek returns the last value regardless of TTL (stale-on-error)", () => {
    clear("k4");
    set("k4", "still-here");
    // Backdate so any positive ttl is exceeded.
    (cache as any).store.set("k4", { at: Date.now() - 10_000, value: "still-here" });
    assert.equal(peek("k4"), "still-here");
    assert.equal(get("k4", 1000), null); // expired for get
    assert.equal(peek("k4"), "still-here"); // still available for peek
  });

  it("clear removes a key", () => {
    set("k5", "x");
    clear("k5");
    assert.equal(get("k5"), null);
    assert.equal(peek("k5"), null);
  });
});

describe("peekWithAge", () => {
  it("returns null on miss", () => {
    clear("k6");
    assert.equal(peekWithAge("k6"), null);
  });

  it("returns { value, ageMs } on hit with ageMs >= 0", async () => {
    clear("k7");
    set("k7", { foo: 1 });
    // Backdate to give the entry a known age.
    const past = Date.now() - 5_000;
    (cache as any).store.set("k7", { at: past, value: { foo: 1 } });
    const r = peekWithAge<{ foo: number }>("k7");
    assert.ok(r);
    assert.deepEqual(r!.value, { foo: 1 });
    // ageMs is computed at peek time; allow a tiny tolerance for wall-clock
    // drift between the backdate and the assertion.
    assert.ok(r!.ageMs >= 5_000, `expected ageMs >= 5000, got ${r!.ageMs}`);
    assert.ok(r!.ageMs < 6_000, `expected ageMs < 6000, got ${r!.ageMs}`);
  });

  it("ignores TTL — peekWithAge returns data even when get() would expire", () => {
    clear("k8");
    set("k8", "stale");
    (cache as any).store.set("k8", { at: Date.now() - 10 * 60_000, value: "stale" });
    assert.equal(get("k8", 1_000), null); // expired for get
    const r = peekWithAge<string>("k8");
    assert.ok(r);
    assert.equal(r!.value, "stale");
    assert.ok(r!.ageMs >= 10 * 60_000);
  });
});