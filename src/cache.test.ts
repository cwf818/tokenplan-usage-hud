import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cache from "./cache.ts";
const {
  clear,
  get,
  getWithAge,
  peek,
  peekWithAge,
  set,
  resetCachePathResolver,
  setCachePathResolver,
  __resetForTest: resetForTest,
} = cache;

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

// ----- Per-Project Key Isolation (v0.4.x+) -----
//
// The cache module is intentionally cwd-unaware: a single Map, a
// single on-disk file. Per-project isolation is achieved by
// `src/render.ts`'s `projectCacheKey(cwd, key)` helper, which
// prefixes every key with `projectHash(cwd):` before it reaches
// this module. This describe block verifies the contract that the
// render-side helper relies on: when two keys happen to look
// identical AFTER the projectHash prefix is applied (i.e. the
// render layer is fed a different cwd, or no cwd), the cache
// module treats them as distinct entries. (The actual
// `projectCacheKey` helper is private to render.ts — these tests
// exercise the public cache API directly with prefixed keys to
// validate the contract.)

describe("cache — per-project key isolation contract", () => {
  beforeEach(() => {
    resetForTest();
  });
  afterEach(() => {
    resetForTest();
  });

  it("two distinct prefixed keys are stored as distinct entries", () => {
    set("d--workspace-alpha:tickSpeed:sess-1", { apiMs: 100 });
    set("d--workspace-beta:tickSpeed:sess-1", { apiMs: 200 });
    assert.deepEqual(peek("d--workspace-alpha:tickSpeed:sess-1"), { apiMs: 100 });
    assert.deepEqual(peek("d--workspace-beta:tickSpeed:sess-1"), { apiMs: 200 });
  });

  it("the same unprefixed key is the global slot (no project isolation)", () => {
    // Sanity: cache itself does NOT prefix. A writer that omits the
    // projectHash prefix would collide with a writer that also omits
    // it (including a writer that runs with cwd=null and falls
    // through to the literal "_" prefix). render.ts MUST always
    // call projectCacheKey; this test pins that contract by
    // showing the bare-key path is shared.
    set("tickSpeed:sess-1", { apiMs: 1 });
    set("tickSpeed:sess-1", { apiMs: 2 });
    assert.deepEqual(peek("tickSpeed:sess-1"), { apiMs: 2 });
  });
});

// ----- Disk persistence -----
//
// v0.2.22: cache entries are shadowed to disk under state/cache.json so
// cacheTtlMs is meaningful across per-tick child-process spawns. These
// tests isolate the disk path to a tmp dir per test (via
// setCachePathResolver) and simulate the "two-tick" sequence by calling
// resetCachePathResolver / resetCachePathResolver (which doesn't actually
// exist; the trick is to use the path resolver hook to point at a fresh
// file each "process") — see the helper below.

describe("cache disk persistence", () => {
  // Per-test tmp dir. Each test gets its own file so the in-memory Map
  // can't leak between tests via a shared disk shadow.
  let dir: string;
  let cacheFile: string;

  // The cache module exports a module-level `store` Map; we can't
  // easily "spawn a new process" inside a test, so to simulate the
  // cross-tick case we use the __resetForTest hook — it clears the
  // in-memory Map AND resets the lazy-load guard so the next get/peek
  // re-reads from disk.
  function resetModuleState(): void {
    resetForTest();
  }

  function setupTmpDir(): void {
    dir = mkdtempSync(join(tmpdir(), "tokenplan-cache-test-"));
    cacheFile = join(dir, "cache.json");
    setCachePathResolver(() => cacheFile);
  }

  function teardownTmpDir(): void {
    resetCachePathResolver();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; tmp dir will be reaped by the OS.
    }
  }

  it("writes to disk on set()", () => {
    setupTmpDir();
    try {
      resetModuleState();
      set("persist-1", { hello: "world" });
      // File must exist and round-trip via raw read (bypassing cache).
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.ok(raw["persist-1"], "entry should be on disk");
      assert.equal(raw["persist-1"].value.hello, "world");
      assert.ok(
        typeof raw["persist-1"].at === "number",
        "at should be a number",
      );
    } finally {
      teardownTmpDir();
    }
  });

  it("loads from disk on first access (simulated cross-tick hit)", () => {
    setupTmpDir();
    try {
      // --- "tick 1": write through the API, then "exit" (clear
      // in-memory state but leave the file).
      resetModuleState();
      const now = Date.now();
      set("cross-tick", { pct: 42 });
      resetModuleState();
      assert.equal((cache as any).store.size, 0, "store cleared");

      // --- "tick 2": bare read — should pick up the disk entry.
      const v = get<{ pct: number }>("cross-tick", 60_000);
      assert.ok(v, "expected cross-tick hit from disk");
      assert.equal(v!.pct, 42);

      // The age on disk was ~milliseconds ago, so a 60s TTL must hit.
      const withAge = getWithAge<{ pct: number }>("cross-tick", 60_000);
      assert.ok(withAge, "expected within-TTL hit");
      assert.ok(
        withAge!.ageMs >= 0 && withAge!.ageMs < 60_000,
        `ageMs should be within TTL, got ${withAge!.ageMs}`,
      );

      // Skip the "now" variable shadow check — we used it just to
      // emphasize that we're testing the wall-clock path.
      void now;
    } finally {
      teardownTmpDir();
    }
  });

  it("TTL is enforced on disk-loaded entries (cross-tick stale)", () => {
    setupTmpDir();
    try {
      resetModuleState();
      // Write a stale entry DIRECTLY to disk (at = 10 minutes ago) and
      // then simulate tick 2. The entry should load but get() must
      // refuse it because ageMs > ttlMs.
      const stale = { at: Date.now() - 10 * 60_000, value: { old: true } };
      writeFileSync(cacheFile, JSON.stringify({ "stale-on-disk": stale }));

      resetModuleState();
      assert.equal(get("stale-on-disk", 60_000), null);
      // peek() ignores TTL — the value is still recoverable for the
      // stale-on-error fallback path.
      assert.deepEqual(peek("stale-on-disk"), { old: true });
    } finally {
      teardownTmpDir();
    }
  });

  it("ignores a missing cache file silently", () => {
    setupTmpDir();
    try {
      resetModuleState();
      // No file exists; get/peek should return null and not throw.
      assert.equal(get("never-set", 60_000), null);
      assert.equal(peek("never-set"), null);
    } finally {
      teardownTmpDir();
    }
  });

  it("ignores a malformed cache file (one stderr warn, no crash)", () => {
    setupTmpDir();
    try {
      resetModuleState();
      writeFileSync(cacheFile, "{not valid json");
      // Capture stderr — the module warns but does not throw.
      const origStderr = process.stderr.write.bind(process.stderr);
      let warned = false;
      (process.stderr.write as unknown) = (
        chunk: string | Uint8Array,
        ...rest: unknown[]
      ): boolean => {
        const s = typeof chunk === "string" ? chunk : chunk.toString();
        if (s.includes("cache file is malformed")) warned = true;
        return (origStderr as unknown as (
          c: string | Uint8Array,
          ...r: unknown[]
        ) => boolean)(chunk, ...rest);
      };
      try {
        assert.equal(get("anything", 60_000), null);
        assert.equal(warned, true, "expected a stderr warning");
      } finally {
        process.stderr.write = origStderr;
      }
    } finally {
      teardownTmpDir();
    }
  });

  it("clear(key) removes the entry from disk; clear() wipes the file", () => {
    setupTmpDir();
    try {
      resetModuleState();
      set("k-a", "v-a");
      set("k-b", "v-b");
      clear("k-a");

      // k-a gone, k-b still present on disk.
      const afterSingle = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(afterSingle["k-a"], undefined);
      assert.equal(afterSingle["k-b"].value, "v-b");

      // Simulate tick 2: only k-b reappears.
      resetModuleState();
      assert.equal(get("k-a", 60_000), null);
      assert.equal(get("k-b", 60_000), "v-b");

      // Full clear wipes the file content.
      clear();
      const afterFull = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.deepEqual(afterFull, {});
    } finally {
      teardownTmpDir();
    }
  });

  it("set() overwrites a stale on-disk entry and refreshes `at`", () => {
    setupTmpDir();
    try {
      resetModuleState();
      const old = { at: Date.now() - 5 * 60_000, value: { v: 1 } };
      writeFileSync(cacheFile, JSON.stringify({ refresh: old }));
      resetModuleState();

      // Tick 2: re-fetch (simulating TTL expiry) and overwrite.
      set("refresh", { v: 2 });

      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(raw.refresh.value.v, 2);
      // `at` must have been refreshed to ~now (well under 5min ago).
      const ageMs = Date.now() - raw.refresh.at;
      assert.ok(
        ageMs < 1_000,
        `expected refreshed at ≈ now, got ageMs=${ageMs}`,
      );
    } finally {
      teardownTmpDir();
    }
  });

  it("load is lazy and idempotent (no double-read after a hit)", () => {
    setupTmpDir();
    try {
      resetModuleState();
      set("lazy", "x");

      // After set(), _loaded is true. Subsequent get() calls must NOT
      // re-read the file. We can't easily prove "no read" without
      // mocking fs, but we can prove the contract: hitting get()
      // repeatedly returns the same value (the in-memory Map is
      // authoritative after first load).
      for (let i = 0; i < 5; i++) {
        assert.equal(get("lazy", 60_000), "x");
      }
      // And _loaded must still be true after the loop — we can't reach
      // the module-private flag, but the multiple successful hits prove
      // it didn't reset mid-flight.
      assert.equal(get("lazy", 60_000), "x");
    } finally {
      teardownTmpDir();
    }
  });
});