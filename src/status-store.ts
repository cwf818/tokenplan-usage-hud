// Per-project tick-status state.
//
// v0.4.x — one JSON file per project at
// `state/<projectHash(cwd)>/status.json`. Holds three flavors of
// `tickStatus` records so the user can read either the project-wide
// running total OR per-session / per-provider slices:
//
//   tickStatus             (no suffix) — project-wide accumulator
//   tickStatus:<sessionId>             — per-session accumulator
//   tickStatus:<providerId>            — per-provider (model name) accumulator
//
// Each entry holds the per-tick snapshot fields AND the running
// totals across the lifetime of that scope:
//
//   {
//     "at":      1782808274334,   // wall-clock ms of the last update
//     "value": {
//       "in":          2468,       // this turn's input tokens
//       "out":          248,       // this turn's output tokens
//       "cacheRead":   33403,      // this turn's cache-read tokens
//       "sumIn":        3093,      // accumulated in  across API calls
//       "sumOut":        475,      // accumulated out
//       "sumCache":    66182,      // accumulated cache_read
//       "sumApiMs":   132311,      // accumulated total_api_duration_ms
//       "sumApiCount":    17,      // accumulated API-call count
//     }
//   }
//
// Also stores the simplified `lastActive` slot (formerly
// `tickSpeedDisplay:<direction>:<sessionId>`) with the same TTL
// contract but no session dimension:
//
//   lastActive:in   { direction, tps, at }
//   lastActive:out  { direction, tps, at }
//
// Why a separate file (vs. cache.json)?
//   - The legacy `state/cache.json` is the home for provider-specific
//     data (minimax, deepseek). Tick-status data is per-tick stdin
//     state — a completely different concern. Keeping them apart
//     means `:clean --purge-runtime` can keep provider caches
//     intact while wiping per-tick state.
//   - The file lives under `state/<projectHash>/` so concurrent
//     Claude Code instances running against different projects never
//     share a write stream.
//
// Mutation model:
//   - Reads return a snapshot of the entry's `value` (or null on
//     miss / file error).
//   - Writes are full-file rewrites — the file is small (a handful
//     of entries, < 1KB total), so an in-memory read-modify-write
//     followed by a single synchronous writeFileSync is the simplest
//     correct strategy. The per-tick child-process model means we
//     only have ONE writer per file (no concurrent-process races
//     within the same project), so we don't need an append journal.
//   - Failures are swallowed (stderr only) so a write error never
//     blocks the statusline.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectHash } from "./token-store.ts";

export type TickStatusValue = {
  in: number;
  out: number;
  cacheRead: number;
  sumIn: number;
  sumOut: number;
  sumCache: number;
  sumApiMs: number;
  sumApiCount: number;
};

export type LastActiveValue = {
  direction: "in" | "out";
  tps: number;
};

// Heterogeneous store: each key carries one of two typed payloads.
// `TickStatusValue` keys are exactly `tickStatus` / `tickStatus:*`.
// `LastActiveValue` keys are exactly `lastActive:in` / `lastActive:out`.
type Entry =
  | { at: number; value: TickStatusValue; kind: "tickStatus" }
  | { at: number; value: LastActiveValue; kind: "lastActive" };

type Store = Record<string, Entry>;

function stateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "tokenplan-usage-hud", "state");
}

// Public: per-project status file path. Exported so tests can point
// the resolver at a tmp dir.
export function statusFilePath(cwd: string): string {
  return join(stateRoot(), projectHash(cwd), "status.json");
}

let _pathResolver: (cwd: string) => string = statusFilePath;

// Test-only path hook. Production code never sets this.
export function setStatusPathResolver(fn: (cwd: string) => string): void {
  _pathResolver = fn;
}

export function resetStatusPathResolver(): void {
  _pathResolver = statusFilePath;
}

// Per-cwd lazy-load guard so we read the file at most once per
// (cwd, process). The statusStore is small (a handful of entries)
// and persists across per-tick child-process invocations through the
// on-disk file, just like cache.ts. The parsed `Store` is cached
// in-memory keyed by cwd so subsequent read-modify-write cycles
// within the same child process see prior writes without needing
// to re-parse the file every time.
const _stores = new Map<string, Store>();
const _loaded = new Set<string>();

function loadFromDisk(cwd: string): Store {
  const cached = _stores.get(cwd);
  if (cached) return cached;
  if (_loaded.has(cwd)) {
    // First call saw a missing/malformed file — return an empty
    // store for this cwd so writes still get flushed, but don't
    // re-attempt the disk read on every call.
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  _loaded.add(cwd);
  let raw: string;
  try {
    raw = readFileSync(_pathResolver(cwd), "utf8");
  } catch {
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(
      "tokenplan-usage-hud: status file is malformed; ignoring\n",
    );
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const empty: Store = {};
    _stores.set(cwd, empty);
    return empty;
  }
  const out: Store = {};
  for (const [key, rawEntry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = rawEntry as { at?: unknown; value?: unknown };
    if (typeof e.at !== "number" || !e.value || typeof e.value !== "object") continue;
    if (key === "lastActive:in" || key === "lastActive:out") {
      const v = e.value as Record<string, unknown>;
      const dir: "in" | "out" = key === "lastActive:in" ? "in" : "out";
      const tps = typeof v.tps === "number" ? v.tps : 0;
      out[key] = {
        at: e.at,
        value: { direction: dir, tps },
        kind: "lastActive",
      };
      continue;
    }
    if (key === "tickStatus" || key.startsWith("tickStatus:")) {
      const v = e.value as Record<string, unknown>;
      out[key] = {
        at: e.at,
        value: {
          in: typeof v.in === "number" ? v.in : 0,
          out: typeof v.out === "number" ? v.out : 0,
          cacheRead: typeof v.cacheRead === "number" ? v.cacheRead : 0,
          sumIn: typeof v.sumIn === "number" ? v.sumIn : 0,
          sumOut: typeof v.sumOut === "number" ? v.sumOut : 0,
          sumCache: typeof v.sumCache === "number" ? v.sumCache : 0,
          sumApiMs: typeof v.sumApiMs === "number" ? v.sumApiMs : 0,
          sumApiCount: typeof v.sumApiCount === "number" ? v.sumApiCount : 0,
        },
        kind: "tickStatus",
      };
    }
  }
  _stores.set(cwd, out);
  return out;
}

function flushToDisk(cwd: string, store: Store): void {
  const path = _pathResolver(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    process.stderr.write(
      "tokenplan-usage-hud: status mkdir failed; in-memory only\n",
    );
    return;
  }
  try {
    writeFileSync(path, JSON.stringify(store));
  } catch {
    process.stderr.write(
      "tokenplan-usage-hud: status write failed; in-memory only\n",
    );
  }
}

// Construct a fresh empty TickStatusValue (zeroed). Centralized so
// the read and write paths agree on the field set.
export function emptyTickStatus(): TickStatusValue {
  return {
    in: 0,
    out: 0,
    cacheRead: 0,
    sumIn: 0,
    sumOut: 0,
    sumCache: 0,
    sumApiMs: 0,
    sumApiCount: 0,
  };
}

// Read the current value of `key` for a given project cwd. Returns
// null when the key has never been written. The in-memory cache is
// loaded lazily on the first call per cwd.
export function readTickStatus(
  cwd: string | null | undefined,
  key: string,
): TickStatusValue | null {
  if (!cwd) return null;
  const store = loadFromDisk(cwd);
  const e = store[key];
  if (!e || e.kind !== "tickStatus") return null;
  return e.value;
}

// Write `value` under `key` for the given cwd. Replaces any prior
// value at the same key. Synchronous; failures are swallowed.
export function writeTickStatus(
  cwd: string | null | undefined,
  key: string,
  value: TickStatusValue,
): void {
  if (!cwd) return;
  const store = loadFromDisk(cwd);
  store[key] = { at: Date.now(), value, kind: "tickStatus" };
  flushToDisk(cwd, store);
}

// ----- lastActive (v0.4.x) --------------------------------------------
//
// The pre-existing `tickSpeedDisplay:<direction>:<sessionId>` cache
// slot survives, simplified: no session dimension (single global
// per-project entry) and a 60s TTL. Used by m_tokenInSpeed /
// m_tokenOutSpeed so an idle tick (no API call this turn) can
// surface the last-active-tick tps instead of rendering "-- t/s".

const LAST_ACTIVE_TTL_MS = 60_000;

export function readLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out",
): number | null {
  if (!cwd) return null;
  const store = loadFromDisk(cwd);
  const key = `lastActive:${direction}`;
  const e = store[key];
  if (!e || e.kind !== "lastActive") return null;
  if (Date.now() - e.at > LAST_ACTIVE_TTL_MS) return null;
  return Number.isFinite(e.value.tps) ? e.value.tps : null;
}

export function writeLastActive(
  cwd: string | null | undefined,
  direction: "in" | "out",
  tps: number,
): void {
  if (!cwd) return;
  const store = loadFromDisk(cwd);
  const key = `lastActive:${direction}`;
  store[key] = {
    at: Date.now(),
    value: { direction, tps },
    kind: "lastActive",
  };
  flushToDisk(cwd, store);
}

// Test-only: wipe the in-memory cache so the next call hits disk
// again. Mirrors cache.ts's `__resetForTest`.
export function __resetForTest(): void {
  _loaded.clear();
  _stores.clear();
}