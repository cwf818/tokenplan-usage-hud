// Fetcher + defensive parser for a MiniMax-style /v1/token_plan/remains
// endpoint. Tolerant of multiple plausible field names so we don't break
// if the upstream schema shifts.
//
// Real shape (verified 2026-06-24):
//   { base_resp: { status_code, status_msg },
//     model_remains: [ { model_name,
//                        current_interval_remaining_percent,
//                        current_weekly_remaining_percent,
//                        start_time, end_time,
//                        weekly_start_time, weekly_end_time, ... }, ... ] }
//
// We pick the entry with the LOWEST `current_interval_remaining_percent` —
// i.e. the most-active model — as the source of truth, since statusline
// space is limited and the user cares about whichever model they're hitting.
//
// v0.2.21: endpoint is now passed in by the caller (the providers
// config block in src/config.ts holds the URL). The hardcoded
// `const ENDPOINT` is gone.

import type { Window } from "./render.ts";

export type Remains = {
  fiveHour: Window | null;
  weekly: Window | null;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function tsToIso(ms: number | null): string | null {
  if (ms == null) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

type ModelEntry = {
  model_name?: string;
  // Common field names observed / plausible.
  interval_remaining_percent?: number | null;
  interval_total_count?: number | null;
  interval_usage_count?: number | null;
  weekly_remaining_percent?: number | null;
  weekly_total_count?: number | null;
  weekly_usage_count?: number | null;
  start_time?: number | null;
  end_time?: number | null;
  weekly_start_time?: number | null;
  weekly_end_time?: number | null;
};

function normalizeModelEntry(raw: unknown): ModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const intervalPct = asNumber(
    pickFirst(r, [
      "current_interval_remaining_percent",
      "interval_remaining_percent",
      "five_hour_remaining_percent",
      "fiveHourRemainingPercent",
    ])
  );
  const weeklyPct = asNumber(
    pickFirst(r, [
      "current_weekly_remaining_percent",
      "weekly_remaining_percent",
      "seven_day_remaining_percent",
    ])
  );
  const intervalTotal = asNumber(pickFirst(r, ["current_interval_total_count", "interval_total_count"]));
  const intervalUsage = asNumber(pickFirst(r, ["current_interval_usage_count", "interval_usage_count"]));
  const weeklyTotal = asNumber(pickFirst(r, ["current_weekly_total_count", "weekly_total_count"]));
  const weeklyUsage = asNumber(pickFirst(r, ["current_weekly_usage_count", "weekly_usage_count"]));

  // Need *some* signal — either percentages or counts — for either window.
  const hasInterval =
    intervalPct != null || (intervalTotal != null && intervalTotal > 0 && intervalUsage != null);
  const hasWeekly =
    weeklyPct != null || (weeklyTotal != null && weeklyTotal > 0 && weeklyUsage != null);
  if (!hasInterval && !hasWeekly) return null;

  return {
    model_name: typeof r.model_name === "string" ? r.model_name : undefined,
    interval_remaining_percent: intervalPct,
    interval_total_count: intervalTotal,
    interval_usage_count: intervalUsage,
    weekly_remaining_percent: weeklyPct,
    weekly_total_count: weeklyTotal,
    weekly_usage_count: weeklyUsage,
    start_time: asNumber(pickFirst(r, ["start_time", "interval_start_time", "five_hour_start_time"])),
    end_time: asNumber(pickFirst(r, ["end_time", "interval_end_time", "five_hour_end_time"])),
    weekly_start_time: asNumber(pickFirst(r, ["weekly_start_time", "seven_day_start_time"])),
    weekly_end_time: asNumber(pickFirst(r, ["weekly_end_time", "seven_day_end_time"])),
  };
}

function pickMostActive(entries: ModelEntry[]): ModelEntry | null {
  if (entries.length === 0) return null;
  // Lowest interval_remaining_percent wins. Missing percent treated as 100
  // (so it's deprioritized). Stable: preserves order on ties.
  return [...entries].sort((a, b) => {
    const av = a.interval_remaining_percent ?? 100;
    const bv = b.interval_remaining_percent ?? 100;
    return av - bv;
  })[0];
}

function entryToWindows(entry: ModelEntry): Remains {
  // Build Window objects from either:
  //  (a) a direct "remaining percent" — used% = 100 - remaining%
  //  (b) raw counts: total & usage — used% = usage / total * 100
  function pctOrNull(
    remaining: number | null | undefined,
    total: number | null | undefined,
    usage: number | null | undefined,
    resetMs: number | null | undefined,
    startMs: number | null | undefined,
  ): Window | null {
    let usedPct: number | null = null;
    if (remaining != null) {
      usedPct = 100 - remaining;
    } else if (total != null && total > 0 && usage != null) {
      usedPct = (usage / total) * 100;
    }
    if (usedPct == null) return null;
    const resetIso = tsToIso(resetMs ?? null);
    const startIso = tsToIso(startMs ?? null);
    // resetDurationMs is only meaningful when BOTH endpoints are present
    // and start < end. The renderer treats it as the window-length signal
    // for picking the fill-state-appropriate reset arrow.
    let durationMs: number | null = null;
    if (startMs != null && resetMs != null && Number.isFinite(startMs) && Number.isFinite(resetMs) && resetMs > startMs) {
      durationMs = resetMs - startMs;
    }
    const w: Window = {
      pct: Math.max(0, Math.min(100, usedPct)),
      resetAt: resetIso,
    };
    if (startIso !== null) w.resetStartAt = startIso;
    if (durationMs !== null) w.resetDurationMs = durationMs;
    return w;
  }

  return {
    fiveHour: pctOrNull(
      entry.interval_remaining_percent,
      entry.interval_total_count,
      entry.interval_usage_count,
      entry.end_time,
      entry.start_time
    ),
    weekly: pctOrNull(
      entry.weekly_remaining_percent,
      entry.weekly_total_count,
      entry.weekly_usage_count,
      entry.weekly_end_time,
      entry.weekly_start_time
    ),
  };
}

function pickFirst<T>(obj: Record<string, unknown>, keys: readonly string[]): T | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
  }
  return undefined;
}

// Legacy single-window shape (in case the API ever returns flat objects like
// { five_hour: { remaining, limit }, weekly: { remaining, limit } }).
function parseLegacy(raw: unknown): Remains | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;

  const fhRaw = pickFirst(data, ["five_hour", "fiveHour", "fivehour", "5h", "hour5"]);
  const wkRaw = pickFirst(data, ["weekly", "week", "wk", "seven_day", "sevenDay", "7d"]);

  function fromLegacy(raw: unknown): Window | null {
    if (!raw || typeof raw !== "object") return null;
    const w = raw as Record<string, unknown>;
    const limit =
      asNumber(pickFirst(w, ["limit", "total", "quota", "max"])) ?? null;
    let remaining =
      asNumber(pickFirst(w, ["remaining", "left", "available", "remain"])) ?? null;
    const used = asNumber(pickFirst(w, ["used", "consumed"])) ?? null;
    let usedPct: number | null = null;
    if (limit && limit > 0 && remaining != null) {
      remaining = Math.max(0, Math.min(limit, remaining));
      usedPct = ((limit - remaining) / limit) * 100;
    } else if (limit && limit > 0 && used != null) {
      usedPct = (used / limit) * 100;
    }
    if (usedPct == null) return null;
    const resetRaw = pickFirst(w, ["reset_at", "resetAt", "reset"]);
    return {
      pct: Math.max(0, Math.min(100, usedPct)),
      resetAt: typeof resetRaw === "string" ? resetRaw : null,
    };
  }

  const fh = fhRaw ? fromLegacy(fhRaw) : null;
  const wk = wkRaw ? fromLegacy(wkRaw) : null;
  if (!fh && !wk) return null;
  return { fiveHour: fh, weekly: wk };
}

export function parseRemains(raw: unknown): Remains | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // Non-zero base_resp.status_code -> failure.
  const baseResp = root.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = asNumber((baseResp as Record<string, unknown>).status_code);
    if (code !== null && code !== 0) return null;
  }

  // Real shape: model_remains array.
  const arr = pickFirst(root, ["model_remains", "modelRemains"]);
  if (Array.isArray(arr) && arr.length > 0) {
    const entries = arr.map(normalizeModelEntry).filter((e): e is ModelEntry => e !== null);
    const chosen = pickMostActive(entries);
    if (chosen) {
      const w = entryToWindows(chosen);
      if (w.fiveHour || w.weekly) return w;
    }
  }

  // Legacy / fallback single-window shape.
  return parseLegacy(raw);
}

export async function fetchRemains(token: string, endpoint: string, signal?: AbortSignal): Promise<Remains | null> {
  if (!token) return null;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`token_plan/remains HTTP ${res.status}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseRemains(parsed);
}

/**
 * @deprecated v0.2.21: use `matchProvider(baseUrl) === "minimax"`
 * from src/providers.ts. Kept as a thin shim for one minor version
 * so external callers don't break. Preserves the v0.2.20 substring
 * behavior (case-insensitive `includes` of the configured host) so
 * callers passing `https://api.minimaxi.com` (without the
 * `/anthropic` suffix) still match — the configured
 * `COMPARE_METHOD` is ignored here, since this shim predates the
 * providers config block.
 */
export function isMiniMaxBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const lower = baseUrl.toLowerCase();
  return lower.includes("api.minimaxi.com");
}