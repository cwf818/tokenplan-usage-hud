// Tiny in-memory TTL cache for the statusline. Single-process; not persisted.
// Stale-on-error: callers should fall back to `peek(key)` if a fetch throws.

type Entry<T> = { at: number; value: T };

// Exported for tests; treat as read-only outside of this module.
export const store = new Map<string, Entry<unknown>>();

export function get<T>(key: string, ttlMs = 60_000): T | null {
  const e = store.get(key) as Entry<T> | undefined;
  if (!e) return null;
  if (Date.now() - e.at > ttlMs) return null;
  return e.value;
}

export function set<T>(key: string, value: T): void {
  store.set(key, { at: Date.now(), value });
}

export function peek<T>(key: string): T | null {
  const e = store.get(key) as Entry<T> | undefined;
  return e ? e.value : null;
}

export function clear(key?: string): void {
  if (key === undefined) store.clear();
  else store.delete(key);
}