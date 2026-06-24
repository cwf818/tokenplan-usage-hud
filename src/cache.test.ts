import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as cache from "./cache.ts";
const { clear, get, peek, set } = cache;

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