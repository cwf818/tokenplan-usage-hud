// Tiny persistent TTL cache for the statusline.
//
// Single-process Map for the hot path; shadowed to disk under
// ~/.claude/plugins/tokenplan-usage-hud/state/cache.json so the
// cache survives across per-tick child-process invocations.
//
// The plugin runs as a fresh node process on every Claude Code
// statusLine tick — without persistence, `cacheTtlMs` is meaningless
// (the Map is empty on every spawn). v0.2.22 adds a disk shadow so
// a within-TTL hit on tick N+1 actually short-circuits the network
// fetch on tick N+1.
//
// Stale-on-error: callers should fall back to `peek(key)` if a fetch
// throws. peek ignores TTL — it returns whatever the disk has.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Entry<T> = { at: number; value: T };

// Exported for tests; treat as read-only outside of this module.
export const store = new Map<string, Entry<unknown>>;

// ----- Disk shadow -----
//
// One file, JSON-encoded Record<key, Entry>. Written synchronously on
// every set() / clear(). The statusLine child-process model means
// writes are infrequent (≤ once per cacheTtlMs), so a sync writeFile
// is fine — the alternative (async) would need a write-queue and a
// "did it flush before exit?" guarantee that's overkill here.
//
// The file lives in the existing state/ dir (sibling of config.json).
// scripts/uninstall.sh already wipes state/, so uninstall cleans up
// the cache file with no extra code.

function defaultCachePath(): string {
  return join(
    homedir(),
    ".claude",
    "plugins",
    "tokenplan-usage-hud",
    "state",
    "cache.json",
  );
}

let _pathResolver: () => string = defaultCachePath;

// Test hook: point the disk path at a temp file. Production code never
// sets it; the path is purely a function of $HOME.
export function setCachePathResolver(fn: () => string): void {
  _pathResolver = fn;
}

export function resetCachePathResolver(): void {
  _pathResolver = defaultCachePath;
}

// True once we've attempted to load from disk for this process. Guards
// against re-reading on every get() — the file is small (a handful of
// entries) but reading it on every tick is wasteful when the in-memory
// Map already has the data.
let _loaded = false;

// Test-only: simulate "new process" between two cache calls. Clears the
// in-memory Map AND resets the lazy-load guard so the next get/peek
// will hit the disk again. Production code never calls this.
export function __resetForTest(): void {
  store.clear();
  _loaded = false;
}

function loadFromDisk(): void {
  if (_loaded) return;
  _loaded = true;
  let raw: string;
  try {
    raw = readFileSync(_pathResolver(), "utf8");
  } catch {
    // ENOENT or unreadable: silent. An empty / missing cache file is
    // the steady state for a fresh install — there is nothing to load.
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON (truncated write, manual edit, etc): warn once but
    // do not crash the statusline. The next set() will overwrite the
    // file with valid JSON.
    process.stderr.write(
      "tokenplan-usage-hud: cache file is malformed; ignoring\n",
    );
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return;
  }
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const e = raw as { at?: unknown; value?: unknown };
    if (
      typeof e.at === "number" &&
      Number.isFinite(e.at) &&
      "value" in e
    ) {
      store.set(key, { at: e.at, value: e.value });
    }
  }
}

function flushToDisk(): void {
  const path = _pathResolver();
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // mkdir failure: don't try to write — the in-memory Map is still
    // authoritative for this process. Surface a one-line warning so
    // the user can investigate permissions / disk-full.
    process.stderr.write(
      "tokenplan-usage-hud: cache mkdir failed; in-memory only\n",
    );
    return;
  }
  // JSON.stringify of the Map gives an object literal — fine for our
  // purposes (small N, keys are provider names).
  const obj: Record<string, Entry<unknown>> = {};
  for (const [k, v] of store.entries()) obj[k] = v;
  try {
    writeFileSync(path, JSON.stringify(obj));
  } catch {
    process.stderr.write(
      "tokenplan-usage-hud: cache write failed; in-memory only\n",
    );
  }
}

export function get<T>(key: string, ttlMs: number): T | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) return null;
  return e.value;
}

// TTL-aware sibling of peekWithAge. Returns the entry's value AND its age
// when the entry is still within TTL; returns null on miss or after
// expiration. Use this when the caller wants the freshness signal even
// on a successful cache hit — a fresh hit at age=500ms is semantically
// different from a fresh hit at age=59s, and downstream consumers
// (e.g. the m_age lineTemplate module) can choose to surface that.
export function getWithAge<T>(
  key: string,
  ttlMs: number,
): { value: T; ageMs: number } | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  const ageMs = Date.now() - e.at;
  if (ageMs > ttlMs) return null;
  return { value: e.value, ageMs };
}

export function set<T>(key: string, value: T): void {
  loadFromDisk();
  store.set(key, { at: Date.now(), value });
  flushToDisk();
}

export function peek<T>(key: string): T | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  return e ? e.value : null;
}

// Sibling of peek that ALSO returns the entry's age in milliseconds. Used by
// the renderer to print a "stale" annotation (" · 5m ago") when we're
// displaying a cached value after a fetch error. Returns null on miss (same
// shape as peek), so callers can use `if (!cached) ...` uniformly.
export function peekWithAge<T>(key: string): { value: T; ageMs: number } | null {
  loadFromDisk();
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  return { value: e.value, ageMs: Date.now() - e.at };
}

export function clear(key?: string): void {
  loadFromDisk();
  if (key === undefined) store.clear();
  else store.delete(key);
  flushToDisk();
}