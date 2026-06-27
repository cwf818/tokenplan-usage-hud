// Tiny in-memory TTL cache for the statusline. Single-process; not persisted.
//
// Stale-on-error: callers should fall back to `peek(key)` if a fetch throws.

type Entry<T> = { at: number; value: T };

// Exported for tests; treat as read-only outside of this module.
export const store = new Map<string, Entry<unknown>>();

export function get<T>(key: string, ttlMs: number): T | null {
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
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  const ageMs = Date.now() - e.at;
  if (ageMs > ttlMs) return null;
  return { value: e.value, ageMs };
}

export function set<T>(key: string, value: T): void {
  store.set(key, { at: Date.now(), value });
}

export function peek<T>(key: string): T | null {
  const e = store.get(key) as Entry<T> | undefined;
  return e ? e.value : null;
}

// Sibling of peek that ALSO returns the entry's age in milliseconds. Used by
// the renderer to print a "stale" annotation (" · 5m ago") when we're
// displaying a cached value after a fetch error. Returns null on miss (same
// shape as peek), so callers can use `if (!cached) ...` uniformly.
export function peekWithAge<T>(key: string): { value: T; ageMs: number } | null {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  return { value: e.value, ageMs: Date.now() - e.at };
}

export function clear(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}