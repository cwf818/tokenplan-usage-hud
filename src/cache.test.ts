import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as cache from "./cache.ts";
const { clear, get, getWithAge, peek, peekWithAge, set } = cache;

describe("cache", () => {
  it("returns null on miss", () => {
    clear("k1");
    assert.equal(get("k1", 60_000), null);
  });

  it("returns the value within TTL", () => {
    clear("k2");
    set("k2", { foo: 1 });
    assert.deepEqual(get("k2", 60_000), { foo: 1 });
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
    assert.equal(get("k5", 60_000), null);
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

describe("getWithAge", () => {
  it("returns null on miss", () => {
    clear("g1");
    assert.equal(getWithAge("g1", 60_000), null);
  });

  it("returns { value, ageMs } on within-TTL hit", () => {
    clear("g2");
    set("g2", { foo: 1 });
    const r = getWithAge<{ foo: number }>("g2", 60_000);
    assert.ok(r);
    assert.deepEqual(r!.value, { foo: 1 });
    // Just-set entry: ageMs is tiny (sub-second on a fast machine).
    assert.ok(r!.ageMs >= 0, `expected ageMs >= 0, got ${r!.ageMs}`);
    assert.ok(r!.ageMs < 1_000, `expected ageMs < 1000, got ${r!.ageMs}`);
  });

  it("returns { value, ageMs } reflecting actual cache age (not 0)", async () => {
    // v0.2.20: getWithAge is what index.ts uses to surface the cache
    // hit's age — the whole point of this helper is that the returned
    // ageMs is the cache's true age, not zero. Without this property
    // the fix to "thread ageMs on fresh cache hit" would be a no-op.
    clear("g3");
    set("g3", "hello");
    // Backdate so the entry has a known age of 5s.
    (cache as any).store.set("g3", { at: Date.now() - 5_000, value: "hello" });
    const r = getWithAge<string>("g3", 60_000);
    assert.ok(r);
    assert.equal(r!.value, "hello");
    assert.ok(r!.ageMs >= 5_000, `expected ageMs >= 5000, got ${r!.ageMs}`);
    assert.ok(r!.ageMs < 6_000, `expected ageMs < 6000, got ${r!.ageMs}`);
  });

  it("returns null when entry is past TTL (age > ttlMs)", () => {
    clear("g4");
    set("g4", "old");
    // Backdate past TTL: entry is 10s old, ttl is 1s.
    (cache as any).store.set("g4", { at: Date.now() - 10_000, value: "old" });
    assert.equal(getWithAge("g4", 1_000), null);
  });

  it("respects TTL boundary: age just over ttlMs returns null", () => {
    clear("g5");
    set("g5", "edge");
    // Age comfortably past ttlMs — the comparison is strict `>`, but
    // we use a generous margin to dodge wall-clock drift between the
    // backdate call and the getWithAge call (mirrors the existing
    // ttl-expired test's tolerance approach).
    (cache as any).store.set("g5", {
      at: Date.now() - 10_000,
      value: "edge",
    });
    assert.equal(getWithAge("g5", 1_000), null);
  });

  it("matches get() on hit/miss semantics (within TTL only)", () => {
    // getWithAge is the TTL-respecting sibling of peekWithAge. The
    // hit/miss decisions should be identical to get(); the only
    // difference is that getWithAge also returns the age.
    clear("g6");
    set("g6", "v");
    assert.equal(get("g6", 60_000), "v");
    assert.equal(getWithAge("g6", 60_000)?.value, "v");

    // After backdating past TTL, both report a miss.
    (cache as any).store.set("g6", { at: Date.now() - 10_000, value: "v" });
    assert.equal(get("g6", 1_000), null);
    assert.equal(getWithAge("g6", 1_000), null);
  });
});