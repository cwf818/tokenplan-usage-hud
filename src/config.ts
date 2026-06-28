// User-tunable configuration for tokenplan-usage-hud.
//
// Loaded once at startup from
//   ~/.claude/plugins/tokenplan-usage-hud/config.json
// (Windows: %USERPROFILE%\.claude\plugins\tokenplan-usage-hud\config.json).
//
// Missing file → DEFAULT_CONFIG silently. Malformed JSON or a single
// bad field → one stderr line + DEFAULT_CONFIG. Never crashes.
//
// Precedence: config.json > hardcoded defaults. The earlier
// TOKENPLAN_DISPLAY env var is gone — anyone who used it must migrate
// to config.json's `display` field (see README "Configuration").

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompareMethod, ProviderEntry, ProviderType } from "./types.ts";
import * as diagnostics from "./diagnostics.ts";

// ----- Defaults — must match today's hardcoded values exactly -----

// Default separator strings referenced from lineTemplate as s_0, s_1, ….
// s_0 is the within-group separator (default: " "); s_1 is the
// between-group separator (default: "·" — just the symbol, no
// surrounding spaces). The default plan template composes
// s_0 + s_1 + s_0 around the inter-window boundary to produce
// the visual " · " (a space, the middot, a space). Users may
// override either or add more (s_2, s_3, …) by extending the array.
const DEFAULT_SEPARATORS: string[] = [" ", "·"];

// Default line layout. A template is an ordered list of tokens; each
// token is either a display module ("m_<name>") or a separator
// reference ("s_<n>"). The renderer walks the list left-to-right and
// concatenates the output of each module, with s_N looked up in
// `separators[N]`. See render.ts:renderTemplate for the full grammar.
//
// Defaults reproduce the v0.2.16 output byte-for-byte:
//   plan:    "Usage: <5h> <countdown5h> · <7d> <countdown7d>"
//   balance: "Balance: <balance>"
// with separators=[" ", "·"] expanding s_0→" " and s_1→"·".
const DEFAULT_LINE_TEMPLATE: {
  plan: string[];
  balance: string[];
} = {
  plan: [
    "m_modeLabel", "s_0",
    "m_window5h", "s_0", "m_countdown5h",
    "s_0", "s_1", "s_0",
    "m_window7d", "s_0", "m_countdown7d",
  ],
  balance: ["m_modeLabel", "s_0", "m_balance"],
};

// 256-color SGR sequences. The colors are kept as plain ANSI strings
// (not symbolic names) so a downstream user can copy/paste a value
// from `console.log` and paste it into config.json without translation.
// "brightBlack" is accepted on input as a shortcut for "\x1b[90m".
const DEFAULT_COLORS = {
  brightGreen: "\x1b[38;5;41m",
  darkGreen: "\x1b[38;5;29m",
  yellow: "\x1b[38;5;220m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[38;5;196m",
  stale: "\x1b[90m",
};

// v0.4.0+ — 3-band palette for the m_cacheHitRate module. Higher is
// better: cache_read / (cache_read + cache_creation) ≥ 80% → green,
// 50–80% → yellow, <50% → orange. Bands chosen to match the visual
// vocabulary of the existing 5-band thresholds (green/yellow/orange)
// so the cache-hit rate reads as "another health indicator" rather
// than a separate dimension.
const DEFAULT_CACHE_HIT_COLORS = {
  good: "\x1b[38;5;41m", // bright green, ≥ 80%
  warn: "\x1b[38;5;220m", // yellow, 50–80%
  bad: "\x1b[38;5;208m", // orange, < 50%
};

const DEFAULT_CACHE_HIT_THRESHOLDS: [number, number] = [50, 80];

const DEFAULT_THRESHOLDS: {
  minimaxPercent: [number, number, number, number];
  deepseekBalance: [number, number, number, number];
} = {
  // 5-band cutoffs for MiniMax percentage rendering.
  minimaxPercent: [20, 40, 60, 80],
  // 5-band cutoffs for DeepSeek balance rendering (absolute units, not %).
  deepseekBalance: [5, 10, 20, 50],
};

const DEFAULT_CURRENCY: {
  prefixes: Record<string, string>;
  fallback: string;
  default: string;
} = {
  prefixes: { USD: "$", CNY: "￥", RMB: "￥" },
  // Fallback prefix when the API returns an unknown currency code.
  fallback: "￥",
  // Currency assumed when an entry omits its `currency` field.
  default: "CNY",
};

const DEFAULT_STALE = {
  // Emoji pair prepended to the "X ago" annotation when the fetch
  // failed. The broken glyph is what the user actually sees (no
  // leading separator) — it's the indicator of network failure.
  // v0.2.17: removed the legacy `separator` field. The stale
  // annotation is now appended directly after the template output
  // (no leading separator). If a custom separator is needed, place
  // it in the lineTemplate explicitly.
  ageEmoji: { healthy: "🔗", broken: "⛓️‍💥" },
  // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
  // indexes into this array by `remainingMs / resetDurationMs`, so the
  // array reads left-to-right as "few remaining → many remaining":
  //   index 0        : remainingMs ≈ 0 (just reset / about to reset)
  //   last index     : remainingMs ≈ resetDurationMs (fresh)
  // `min(…, length-1)` clamps ratio=1.0 to the last entry instead of
  // running off the end. Twelve clock-face emoji give a smooth visual
  // ramp from 12 o'clock (🕛, least remaining) around to 1 o'clock
  // (🕐, most remaining); two glyphs give a binary "hourglass" pair
  // (full/empty); one glyph is a static indicator. Providers without
};

const DEFAULT_BAR = {
  width: 8,
  filled: "▓",
  empty: "░",
};

// v0.4.0+ — number-format knobs for the m_token* modules. Two layers:
//   `thresholds` drives the human-compact notation (matches formatRemainingMs:
//   below the smallest threshold → raw integer; otherwise k / M suffix).
//   `precision` controls decimal places per tier (currently 1; tests can
//   bump to 2 if a user wants more granularity).
//   `speedPrecision` / `cachePctPrecision` independently tune t/s and %.
//   `cacheHitThresholds` mirrors DEFAULT_CACHE_HIT_THRESHOLDS — exposed
//   as a config field so a user who wants different bands can override
//   without touching the colors block.
const DEFAULT_TOKEN_FORMAT = {
  // [<1k] → "342", [<1M] → "12.3k", [≥1M] → "1.2M". Aligns with the
  // readable upper bound of typical session totals (rare to see > 1M
  // tokens in a single Claude Code session, but possible over a 7d window).
  thresholds: [1_000, 1_000_000] as [number, number],
  precision: 1,
  speedPrecision: 1,
  cachePctPrecision: 1,
  cacheHitThresholds: DEFAULT_CACHE_HIT_THRESHOLDS,
};

type DisplayMode = "used" | "remaining";

// Top-level time-format knobs. They govern ALL time rendering in the
// plugin — reset countdown AND stale-age suffix AND any future caller
// (e.g. an "elapsed since session start" line). Keeping them at top
// level (rather than buried under `stale`) means a user who wants
// second-level granularity anywhere gets it everywhere consistently.
type TimeFormat = {
  // Smallest unit shown on time countdowns. Units BELOW this granularity
  // are never rendered directly — when all remaining units collapse to
  // zero (or get truncated), the formatter falls back to "<1<minUnit>"
  // (positive remaining) or "0<minUnit>" (past-due).
  //   "m" (default): sub-minute shows as "<1m".
  //   "s":           sub-minute shows as actual seconds (e.g. "47s").
  //   "h":           sub-hour shows as "<1h" (useful for windows where
  //                  minute-precision is noise — e.g. the weekly reset).
  minUnit: "m" | "s" | "h";
  // How many non-zero units to display. After dropping units below
  // minUnit AND dropping leading zero units, takes up to maxUnitCount
  // from the start — including any internal/trailing zero units.
  // Clamped to [1, 4]. Examples (minUnit="m"):
  //   1d2h3m4s → "1d2h"
  //   2h3m4s   → "2h3m"
  //   2h0m     → "2h0m"   (NOT "2h" — internal zeros preserved)
  //   0d0h5m   → "5m"     (leading zeros dropped)
  //   0d0h30s  → "<1m"    (all extracted units zero under minUnit)
  maxUnitCount: number;
};

const DEFAULT_TIME_FORMAT: TimeFormat = {
  minUnit: "m",
  maxUnitCount: 2,
};

// Reset-countdown visualization. Belongs with the countdown, NOT with
// the stale-on-error annotation (which is a separate concern).
type Countdown = {
  // Glyphs appended to the reset countdown (e.g. "2h3m🕛"). The picker
  // indexes into this array by remainingMs / resetDurationMs, so the array
  // reads left-to-right as "few remaining → many remaining":
  //   index 0  : remainingMs ≈ 0 (just reset / about to reset)
  //   last     : remainingMs ≈ resetDurationMs (fresh)
  // min(..., length-1) clamps ratio=1.0 to the last entry. Twelve clock-face
  // emoji give a smooth visual ramp from 12 o'clock (🕛, least remaining)
  // around to 1 o'clock (🕐, most remaining); two glyphs give a binary
  // hourglass pair; one glyph is static. Providers without start_time
  // (DeepSeek, legacy) fall back to index 0.
  resetArrows: string[];
};

const DEFAULT_COUNTDOWN: Countdown = {
  resetArrows: [
    "🕛",
    "🕚",
    "🕙",
    "🕘",
    "🕗",
    "🕖",
    "🕕",
    "🕔",
    "🕓",
    "🕒",
    "🕑",
    "🕐",
  ],
};


// v0.2.21: declarative provider list. Each entry is a self-contained
// provider spec: how to recognize its base URL, how to talk to its API,
// and how to dispatch the rendering. The defaults below reproduce the
// v0.2.20 hardcoded behavior exactly — same base URLs, same endpoints.
// Adding a new provider is a config-only change: drop a new entry into
// `providers` and the dispatcher / fetcher / template picker all pick
// it up automatically.
const DEFAULT_PROVIDERS: Record<string, ProviderEntry> = {
  minimax: {
    TYPE: "TOKEN_PLAN",
    BASE_URL_COMPARED_TO: "https://api.minimaxi.com/anthropic",
    COMPARE_METHOD: "EXACT",
    ENDPOINT: "https://www.minimaxi.com/v1/token_plan/remains",
    config: {},
  },
  deepseek: {
    TYPE: "BALANCE",
    BASE_URL_COMPARED_TO: "https://api.deepseek.com/anthropic",
    COMPARE_METHOD: "EXACT",
    ENDPOINT: "https://api.deepseek.com/user/balance",
    config: {},
  },
};

const VALID_PROVIDER_TYPES: ReadonlySet<ProviderType> = new Set([
  "TOKEN_PLAN",
  "BALANCE",
]);

const VALID_COMPARE_METHODS: ReadonlySet<CompareMethod> = new Set([
  "EXACT",
  "INCLUDE",
  "STARTWITH",
]);

const DEFAULT_CONFIG: {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  display: DisplayMode;
  modeLabels: { used: string; remaining: string; balance: string };
  colors: typeof DEFAULT_COLORS;
  cacheHitColors: typeof DEFAULT_CACHE_HIT_COLORS;
  thresholds: typeof DEFAULT_THRESHOLDS;
  currency: typeof DEFAULT_CURRENCY;
  stale: typeof DEFAULT_STALE;
  bar: typeof DEFAULT_BAR;
  countdown: Countdown;
  timeFormat: TimeFormat;
  separators: string[];
  lineTemplate: typeof DEFAULT_LINE_TEMPLATE;
  tokenFormat: typeof DEFAULT_TOKEN_FORMAT;
  // Plugin version, populated at startup by index.ts from
  // .claude-plugin/plugin.json. The m_version display module reads
  // this field; tests inject values via __resetForTest.
  version: string;
  // v0.2.21: declarative provider registry. See DEFAULT_PROVIDERS
  // above and src/providers.ts for the matcher / dispatcher.
  providers: Record<string, ProviderEntry>;
} = {
  cacheTtlMs: 60_000,
  fetchTimeoutMs: 5_000,
  display: "used",
  // "balance" was added in v0.2.17 alongside the lineTemplate refactor
  // so the m_modeLabel module for the DeepSeek path can pick it up. Defaults
  // to "Balance:" to preserve the v0.2.16 hardcoded literal.
  modeLabels: { used: "Usage:", remaining: "Remain:", balance: "Balance:" },
  colors: DEFAULT_COLORS,
  cacheHitColors: DEFAULT_CACHE_HIT_COLORS,
  thresholds: DEFAULT_THRESHOLDS,
  currency: DEFAULT_CURRENCY,
  stale: DEFAULT_STALE,
  bar: DEFAULT_BAR,
  countdown: DEFAULT_COUNTDOWN,
  timeFormat: DEFAULT_TIME_FORMAT,
  separators: DEFAULT_SEPARATORS,
  lineTemplate: DEFAULT_LINE_TEMPLATE,
  tokenFormat: DEFAULT_TOKEN_FORMAT,
  version: "",
  providers: DEFAULT_PROVIDERS,
};

export type Config = typeof DEFAULT_CONFIG;

// ----- Module-level singleton -----
//
// Set once via loadConfig() at startup. Tests use __resetForTest to
// inject overrides without touching disk. Reading is synchronous: every
// consumer just calls configStore.get() at the moment of need.

let _current: Config = DEFAULT_CONFIG;

export const configStore = {
  get(): Config {
    return _current;
  },
  // Inject the plugin version loaded from .claude-plugin/plugin.json
  // at startup. Mutates the current Config's `version` field in place
  // — the test reset path also resets it (see __resetForTest). Tests
  // can call this directly to simulate the startup injection without
  // touching the filesystem.
  setVersion(v: string): void {
    _current.version = v;
  },
};

// ----- Loader -----

function defaultConfigPath(): string {
  return join(
    homedir(),
    ".claude",
    "plugins",
    "tokenplan-usage-hud",
    "config.json",
  );
}

// Test hook: replace the path resolver so tests can point at a temp
// file without monkey-patching node:os. Production code never sets it.
let _pathResolver: () => string = defaultConfigPath;

export async function loadConfig(): Promise<Config> {
  const path = _pathResolver();
  // Cheap existence probe — the common case is no config file, no need
  // to even open the file descriptor.
  if (!existsSync(path)) {
    _current = DEFAULT_CONFIG;
    return _current;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    warn(`read failed (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    return _current;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`invalid JSON (${(e as Error).message}); using defaults`);
    _current = DEFAULT_CONFIG;
    return _current;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("root must be a JSON object; using defaults");
    _current = DEFAULT_CONFIG;
    return _current;
  }

  _current = mergeConfig(parsed as Record<string, unknown>);
  return _current;
}

// v0.4.0+ — apply a provider-specific Config override on top of the
// active snapshot. Called from index.ts:main() after loadConfig() and
// matchProvider() so the active Config seen by every consumer
// (configStore.get()) is already the merged view:
//
//   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
//             (lowest)                  (highest)
//
// Implementation: deep-clone the current snapshot, run the same
// per-field validators on top of the provider.config object, replace
// the active snapshot. Reusing the validators (rather than merging
// provider.config as JSON and re-running mergeConfig) keeps the
// precedence math explicit and avoids re-cloning defaults.
//
// Stale-on-error behavior: the active snapshot may have been built
// from a malformed user config (some fields silently fell back to
// defaults with a stderr warn). Re-validating provider.config on top
// of that snapshot means the provider layer's overrides get the SAME
// per-field validation as the top-level config — typos in
// provider.config still produce stderr warns, never silent acceptance.
export function applyProviderOverrides(raw: Record<string, unknown>): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  if ("providers" in raw) {
    warn(
      "provider.config must not contain a nested 'providers' key (would recurse); ignoring",
    );
    delete (raw as Record<string, unknown>).providers;
  }
  const base = JSON.parse(JSON.stringify(_current)) as Config;
  _current = applyOverrides(base, raw);
}

function warn(msg: string): void {
  process.stderr.write(`tokenplan-usage-hud: config ${msg}\n`);
  // v0.4.0+ — also append to the diagnostics JSONL log so the
  // m_warning module can surface the latest signal and the user can
  // postmortem the plugin's recent history. Stderr stays the
  // primary surface for live debugging; the log is the persistent
  // record. Disk errors are swallowed inside diagnostics.append.
  diagnostics.append("warning", "config", msg);
}

// ----- Per-field validation + merge -----
//
// Each validator returns the validated value, or DEFAULT_CONFIG's
// value on failure (with a stderr warning). Per-section isolation:
// a bad `colors` block does NOT poison `cacheTtlMs` — independent
// try/catches around each validator keep partial configs working.

function isFinitePositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isAscending4Tuple(v: unknown): v is [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4) return false;
  if (!v.every(isFiniteNumber)) return false;
  for (let i = 1; i < v.length; i++) {
    if ((v[i] as number) <= (v[i - 1] as number)) return false;
  }
  return true;
}

// Accept an ANSI SGR string OR a known symbolic shortcut.
const COLOR_SHORTCUTS: Record<string, string> = {
  brightBlack: "\x1b[90m",
  brightGreen: "\x1b[38;5;41m",
  darkGreen: "\x1b[38;5;29m",
  yellow: "\x1b[38;5;220m",
  orange: "\x1b[38;5;208m",
  red: "\x1b[38;5;196m",
};

function normalizeColor(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (COLOR_SHORTCUTS[v]) return COLOR_SHORTCUTS[v];
  // Accept any SGR sequence (\x1b[...m) — we don't try to validate the
  // exact byte sequence, just that it looks like an SGR. Reject strings
  // that contain newlines so a JSON mistake can't inject multi-line
  // escape codes into the rendered statusline.
  if (/^\x1b\[[0-9;]*m$/.test(v)) return v;
  return null;
}

// v0.4.0+ — internal helper that applies a raw override object on
// top of an existing Config snapshot. Used by both mergeConfig (the
// config.json loader) and applyProviderOverrides (the provider-level
// config overlay). Per-field validators are identical between the
// two callers, so the precedence is:
//
//   defaults  ⊕  config.json  ⊕  providerEntry.config
//
// where each step runs the same validators in sequence.
//
// Why a separate helper: extracting this from mergeConfig keeps the
// validation logic in ONE place. If we re-ran mergeConfig from scratch
// for the provider layer, we'd lose the user-config fixes (e.g. a
// top-level `cacheTtlMs` that was repaired with a stderr warn would
// get re-clobbered by an unrelated bad value in provider.config).
// Re-validating on top of the merged snapshot keeps each layer's
// effect independent.
function applyOverrides(base: Config, raw: Record<string, unknown>): Config {
  // Deep-clone the input Config — we mutate freely and don't want to
  // touch the caller's object. JSON round-trip is fine here: Config
  // is plain data, no functions / Dates / Maps.
  const out = JSON.parse(JSON.stringify(base)) as Config;

  // cacheTtlMs
  if ("cacheTtlMs" in raw) {
    if (isFinitePositiveNumber(raw.cacheTtlMs)) {
      out.cacheTtlMs = raw.cacheTtlMs;
    } else {
      warn("cacheTtlMs must be a positive number; using default");
    }
  }

  // cacheTtlMs
  if ("cacheTtlMs" in raw) {
    if (isFinitePositiveNumber(raw.cacheTtlMs)) {
      out.cacheTtlMs = raw.cacheTtlMs;
    } else {
      warn("cacheTtlMs must be a positive number; using default");
    }
  }

  // fetchTimeoutMs
  if ("fetchTimeoutMs" in raw) {
    if (isFinitePositiveNumber(raw.fetchTimeoutMs)) {
      out.fetchTimeoutMs = raw.fetchTimeoutMs;
    } else {
      warn("fetchTimeoutMs must be a positive number; using default");
    }
  }

  // display
  if ("display" in raw) {
    const d = raw.display;
    if (d === "used" || d === "remaining") {
      out.display = d;
    } else {
      warn('display must be "used" or "remaining"; using default');
    }
  }

  // modeLabels
  if ("modeLabels" in raw) {
    const ml = raw.modeLabels;
    if (ml && typeof ml === "object" && !Array.isArray(ml)) {
      const m = ml as Record<string, unknown>;
      if (typeof m.used === "string") out.modeLabels.used = m.used;
      else if ("used" in m)
        warn("modeLabels.used must be a string; using default");
      if (typeof m.remaining === "string")
        out.modeLabels.remaining = m.remaining;
      else if ("remaining" in m)
        warn("modeLabels.remaining must be a string; using default");
      // v0.2.17: added alongside the lineTemplate refactor so m_modeLabel
      // can pick it up for the DeepSeek (balance) path. Replaces the
      // hardcoded "Balance: " literal in the old formatBalanceLine.
      if (typeof m.balance === "string") out.modeLabels.balance = m.balance;
      else if ("balance" in m)
        warn("modeLabels.balance must be a string; using default");
    } else {
      warn("modeLabels must be an object; using default");
    }
  }

  // colors — per-field validation, partial acceptance
  if ("colors" in raw) {
    const c = raw.colors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of [
        "brightGreen",
        "darkGreen",
        "yellow",
        "orange",
        "red",
        "stale",
      ] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.colors[key] = norm;
          } else {
            warn(
              `colors.${key} must be an ANSI SGR string or a known shortcut; using default`,
            );
          }
        }
      }
    } else {
      warn("colors must be an object; using default");
    }
  }

  // v0.4.0+ — cacheHitColors. Same per-field validator as `colors`
  // (ANSI SGR or a known shortcut). Three bands: good / warn / bad.
  if ("cacheHitColors" in raw) {
    const c = raw.cacheHitColors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of ["good", "warn", "bad"] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.cacheHitColors[key] = norm;
          } else {
            warn(
              `cacheHitColors.${key} must be an ANSI SGR string or a known shortcut; using default`,
            );
          }
        }
      }
    } else {
      warn("cacheHitColors must be an object; using default");
    }
  }

  // thresholds
  if ("thresholds" in raw) {
    const t = raw.thresholds;
    if (t && typeof t === "object" && !Array.isArray(t)) {
      const tm = t as Record<string, unknown>;
      if ("minimaxPercent" in tm) {
        if (isAscending4Tuple(tm.minimaxPercent)) {
          out.thresholds.minimaxPercent = tm.minimaxPercent;
        } else {
          warn(
            "thresholds.minimaxPercent must be 4 ascending numbers; using default",
          );
        }
      }
      if ("deepseekBalance" in tm) {
        if (isAscending4Tuple(tm.deepseekBalance)) {
          out.thresholds.deepseekBalance = tm.deepseekBalance;
        } else {
          warn(
            "thresholds.deepseekBalance must be 4 ascending numbers; using default",
          );
        }
      }
    } else {
      warn("thresholds must be an object; using default");
    }
  }

  // currency
  if ("currency" in raw) {
    const c = raw.currency;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      if ("prefixes" in cm) {
        if (
          cm.prefixes &&
          typeof cm.prefixes === "object" &&
          !Array.isArray(cm.prefixes)
        ) {
          const merged: Record<string, string> = {
            ...DEFAULT_CURRENCY.prefixes,
          };
          for (const [k, v] of Object.entries(
            cm.prefixes as Record<string, unknown>,
          )) {
            if (typeof v === "string") merged[k.toUpperCase()] = v;
          }
          out.currency.prefixes = merged;
        } else {
          warn("currency.prefixes must be an object; using default");
        }
      }
      if ("fallback" in cm) {
        if (typeof cm.fallback === "string")
          out.currency.fallback = cm.fallback;
        else warn("currency.fallback must be a string; using default");
      }
      if ("default" in cm) {
        if (typeof cm.default === "string") out.currency.default = cm.default;
        else warn("currency.default must be a string; using default");
      }
    } else {
      warn("currency must be an object; using default");
    }
  }

  // stale — v0.2.17 dropped the legacy `separator` field. The stale
  // annotation is now appended directly after the template output
  // (no leading separator). The `stale` block is still accepted for
  // forward-compat (e.g. ageEmoji overrides), but only `ageEmoji` is
  // recognized; unknown sub-keys are silently ignored.
  if ("stale" in raw) {
    const s = raw.stale;
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      warn("stale must be an object; using default");
    }
  }

  // countdown — top-level (reset countdown visualization).
  if ("countdown" in raw) {
    const c = raw.countdown;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      if ("resetArrows" in cm) {
        const arr = cm.resetArrows;
        if (
          Array.isArray(arr) &&
          arr.every((v) => typeof v === "string" && !/\n/.test(v)) &&
          arr.length > 0
        ) {
          out.countdown.resetArrows = arr as string[];
        } else {
          warn(
            "countdown.resetArrows must be a non-empty array of single-line strings; using default",
          );
        }
      }
    } else {
      warn("countdown must be an object; using default");
    }
  }

  // timeFormat — top-level (governs reset countdown AND stale suffix).
  if ("timeFormat" in raw) {
    const tf = raw.timeFormat;
    if (tf && typeof tf === "object" && !Array.isArray(tf)) {
      const t = tf as Record<string, unknown>;
      if ("minUnit" in t) {
        if (t.minUnit === "m" || t.minUnit === "s" || t.minUnit === "h")
          out.timeFormat.minUnit = t.minUnit;
        else warn('timeFormat.minUnit must be "m", "s", or "h"; using default');
      }
      if ("maxUnitCount" in t) {
        if (isFiniteNumber(t.maxUnitCount))
          out.timeFormat.maxUnitCount = Math.max(
            1,
            Math.min(4, Math.floor(t.maxUnitCount)),
          );
        else warn("timeFormat.maxUnitCount must be a number; using default");
      }
    } else {
      warn("timeFormat must be an object; using default");
    }
  }

  // v0.4.0+ — tokenFormat (compact number formatting for m_token* modules).
  // All sub-keys are optional; missing → keep default.
  if ("tokenFormat" in raw) {
    const tf = raw.tokenFormat;
    if (tf && typeof tf === "object" && !Array.isArray(tf)) {
      const t = tf as Record<string, unknown>;
      if ("thresholds" in t) {
        if (
          Array.isArray(t.thresholds) &&
          t.thresholds.length === 2 &&
          t.thresholds.every(isFinitePositiveNumber)
        ) {
          const pair = t.thresholds as [number, number];
          if (pair[0] < pair[1]) out.tokenFormat.thresholds = pair;
          else
            warn(
              "tokenFormat.thresholds must be 2 ascending positive numbers; using default",
            );
        } else {
          warn(
            "tokenFormat.thresholds must be [lo, hi] of positive numbers; using default",
          );
        }
      }
      for (const k of [
        "precision",
        "speedPrecision",
        "cachePctPrecision",
      ] as const) {
        if (k in t) {
          if (isFiniteNumber(t[k]) && (t[k] as number) >= 0 && (t[k] as number) <= 4)
            out.tokenFormat[k] = Math.floor(t[k] as number);
          else
            warn(`tokenFormat.${k} must be an integer in [0, 4]; using default`);
        }
      }
      if ("cacheHitThresholds" in t) {
        if (
          Array.isArray(t.cacheHitThresholds) &&
          t.cacheHitThresholds.length === 2 &&
          t.cacheHitThresholds.every(isFiniteNumber)
        ) {
          const pair = t.cacheHitThresholds as [number, number];
          if (pair[0] < pair[1]) out.tokenFormat.cacheHitThresholds = pair;
          else
            warn(
              "tokenFormat.cacheHitThresholds must be 2 ascending numbers; using default",
            );
        } else {
          warn(
            "tokenFormat.cacheHitThresholds must be [lo, hi] numbers; using default",
          );
        }
      }
    } else {
      warn("tokenFormat must be an object; using default");
    }
  }

  // bar
  if ("bar" in raw) {
    const b = raw.bar;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const bm = b as Record<string, unknown>;
      if ("width" in bm) {
        // Accept any finite number in [3, 64] — narrower than the [3,32]
        // range first sketched, because wider bars look bad in any
        // statusline context the user might compose this with.
        if (
          isFiniteNumber(bm.width) &&
          (bm.width as number) >= 3 &&
          (bm.width as number) <= 64
        ) {
          out.bar.width = bm.width;
        } else {
          warn("bar.width must be an integer in [3, 64]; using default");
        }
      }
      if ("filled" in bm) {
        if (typeof bm.filled === "string" && !/\n/.test(bm.filled))
          out.bar.filled = bm.filled;
        else warn("bar.filled must be a single-line string; using default");
      }
      if ("empty" in bm) {
        if (typeof bm.empty === "string" && !/\n/.test(bm.empty))
          out.bar.empty = bm.empty;
        else warn("bar.empty must be a single-line string; using default");
      }
    } else {
      warn("bar must be an object; using default");
    }
  }

  // separators — array of strings referenced from lineTemplate as
  // s_0, s_1, …. Validation only checks shape; the renderer looks
  // them up at expansion time, so an s_N that points past the end
  // of the array expands to "" (with a one-line warn) — we
  // deliberately don't fail config load on missing separators.
  //
  // v0.4.0+ — separators may now contain "\n" (real line break, the
  // renderer splits on it and closes SGR per line) or "\t" (TAB, the
  // terminal renders it against its tab stops). Both are intentional
  // user-facing values, not JSON mistakes. We still reject separators
  // with \r, NUL, \b, \f, \v, or other ASCII control bytes — those
  // would almost certainly be a JSON mistake (a stray backtick escape,
  // a copy-paste from a document with non-standard line endings, etc.)
  // and shouldn't silently pollute the statusline.
  if ("separators" in raw) {
    const s = raw.separators;
    if (Array.isArray(s)) {
      const cleaned: string[] = [];
      let rejected = 0;
      for (let i = 0; i < s.length; i++) {
        const v = s[i];
        // Allow string separators, including those that contain "\n"
        // (multi-line layouts) or "\t" (terminal-rendered tab stops).
        // Reject anything with other control characters — those are
        // almost certainly a JSON mistake that shouldn't reach the
        // renderer.
        if (typeof v === "string" && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v)) {
          cleaned.push(v);
        } else {
          rejected++;
        }
      }
      if (cleaned.length === 0) {
        warn("separators must contain at least one valid string; using default");
      } else {
        if (rejected > 0)
          warn(`separators: dropped ${rejected} non-string or invalid entries`);
        out.separators = cleaned;
      }
    } else {
      warn("separators must be an array of strings; using default");
    }
  }

  // lineTemplate — { plan: string[], balance: string[] }. Token values
  // are NOT validated against the module-name enum here; that happens
  // at render time so a typo produces a "unknown module 'm_foo'"
  // warning in the rendered line (not a silent reject at config load).
  if ("lineTemplate" in raw) {
    const lt = raw.lineTemplate;
    if (lt && typeof lt === "object" && !Array.isArray(lt)) {
      const ltm = lt as Record<string, unknown>;
      const validate = (key: "plan" | "balance"): string[] | null => {
        if (!(key in ltm)) return null;
        const arr = ltm[key];
        if (!Array.isArray(arr)) {
          warn(`lineTemplate.${key} must be an array of strings; using default`);
          return null;
        }
        const cleaned: string[] = [];
        for (const v of arr) {
          if (typeof v === "string") cleaned.push(v);
        }
        if (cleaned.length === 0) {
          warn(`lineTemplate.${key} must contain at least one string; using default`);
          return null;
        }
        return cleaned;
      };
      const plan = validate("plan");
      if (plan) out.lineTemplate.plan = plan;
      const balance = validate("balance");
      if (balance) out.lineTemplate.balance = balance;
    } else {
      warn("lineTemplate must be an object; using default");
    }
  }

  // Note: the `providers` block is handled separately by mergeConfig
  // (the only caller that processes user-provided provider entries).
  // applyProviderOverrides rejects `providers` at the top of the
  // function, so this helper intentionally doesn't touch it.

  return out;
}

// v0.4.0+ — top-level config.json loader. Wraps applyOverrides with
// the `providers` block handling that lives only at the top layer.
function mergeConfig(raw: Record<string, unknown>): Config {
  const out = applyOverrides(
    JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config,
    raw,
  );

  // providers — Record<string, ProviderEntry>. User config is
  // deep-merged on top of DEFAULT_PROVIDERS: existing keys have
  // their fields overridden; new keys are appended. Per-entry
  // validation drops malformed entries with a stderr warn rather
  // than auto-filling (so a typo can't silently produce a half-
  // configured provider that fetches from the wrong endpoint).
  //
  // The "missing `providers` key in user config" case falls back
  // to DEFAULT_PROVIDERS via the deep-clone at the top of
  // mergeConfig — so existing users without a `providers` block
  // keep working unchanged.
  if ("providers" in raw) {
    const p = raw.providers;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      warn("providers must be an object; using default");
    } else {
      const pm = p as Record<string, unknown>;
      const merged: Record<string, ProviderEntry> = {};
      for (const [name, defaultEntry] of Object.entries(DEFAULT_PROVIDERS)) {
        // Start with the default for known keys; user overrides
        // fields on top below. A partial user entry (e.g. only
        // `ENDPOINT`) inherits the other three fields from the
        // default — so the user can change just one knob without
        // restating the whole entry. A non-object user value (string,
        // array, null) is a user error — drop the entry and warn.
        let seed: Record<string, unknown> | null = null;
        if (name in pm) {
          if (pm[name] && typeof pm[name] === "object" && !Array.isArray(pm[name])) {
            seed = { ...defaultEntry };
            for (const [k, v] of Object.entries(pm[name] as Record<string, unknown>)) {
              if (v !== undefined) seed[k] = v;
            }
          } else {
            warn(`providers.${name} must be an object; dropping`);
          }
        } else {
          // User did not mention this default key → keep it as-is.
          seed = { ...defaultEntry };
        }
        if (seed) {
          const validated = validateProviderEntry(seed);
          if (validated) merged[name] = validated;
        }
      }
      // Append any user-defined provider keys NOT in DEFAULT_PROVIDERS.
      for (const [name, value] of Object.entries(pm)) {
        if (name in merged) continue;
        const entry = validateProviderEntry(value);
        if (entry) merged[name] = entry;
      }
      out.providers = merged;
    }
  }

  return out;
}

// Validate one ProviderEntry. Returns the validated entry or null if
// the entry is fatally malformed. The caller (`mergeConfig`) is
// responsible for filling missing fields from the default entry
// before calling this — we validate the merged result, not the raw
// user input. A partial user entry (e.g. only `ENDPOINT`) thus
// preserves the other three fields from the default; an invalid
// `TYPE` on an otherwise-OK entry drops the whole thing.
function validateProviderEntry(v: unknown): ProviderEntry | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    warn("provider entry must be an object; dropping");
    return null;
  }
  const e = v as Record<string, unknown>;
  // TYPE
  const t = e.TYPE;
  if (typeof t !== "string" || !VALID_PROVIDER_TYPES.has(t as ProviderType)) {
    warn(`provider TYPE must be "TOKEN_PLAN" or "BALANCE" (got ${JSON.stringify(t)}); dropping`);
    return null;
  }
  // BASE_URL_COMPARED_TO
  const base = e.BASE_URL_COMPARED_TO;
  if (typeof base !== "string" || base.length === 0) {
    warn("provider BASE_URL_COMPARED_TO must be a non-empty string; dropping");
    return null;
  }
  // COMPARE_METHOD
  const cm = e.COMPARE_METHOD;
  if (typeof cm !== "string" || !VALID_COMPARE_METHODS.has(cm as CompareMethod)) {
    warn(`provider COMPARE_METHOD must be one of "EXACT", "INCLUDE", "STARTWITH" (got ${JSON.stringify(cm)}); dropping`);
    return null;
  }
  // ENDPOINT — must be a string starting with http:// or https://.
  const ep = e.ENDPOINT;
  if (typeof ep !== "string" || !/^https?:\/\//.test(ep)) {
    warn("provider ENDPOINT must be an http(s) URL; dropping");
    return null;
  }
  // v0.4.0+ — optional provider-specific Config overrides. Validated
  // here only for shape (must be a plain object, no nested `providers`
  // key to avoid recursion). The fields inside `config` are merged
  // into the active Config snapshot at startup via
  // configStore.applyProviderOverrides(provider); per-field validators
  // are applied at THAT time so a typo still produces a stderr warn.
  if ("config" in e && e.config !== undefined) {
    const c = e.config;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      warn(`provider.config must be an object (got ${typeof c}); dropping the entry`);
      return null;
    }
    const cm = c as Record<string, unknown>;
    if ("providers" in cm) {
      warn(
        "provider.config must not contain a nested 'providers' key (would recurse); dropping the entry",
      );
      return null;
    }
  }
  // Forward the validated `config` block (or omit it entirely if
  // the user didn't supply one) so downstream readers see a
  // consistent shape.
  const validatedConfig =
    "config" in e &&
    e.config &&
    typeof e.config === "object" &&
    !Array.isArray(e.config)
      ? (e.config as Record<string, unknown>)
      : undefined;
  return {
    TYPE: t as ProviderType,
    BASE_URL_COMPARED_TO: base,
    COMPARE_METHOD: cm as CompareMethod,
    ENDPOINT: ep,
    ...(validatedConfig ? { config: validatedConfig } : {}),
  };
}

// ----- Test-only -----

export function __resetForTest(overrides?: Partial<Config>): void {
  if (overrides === undefined) {
    // v0.2.17: deep-clone DEFAULT_CONFIG before assigning. setVersion()
    // mutates _current.version in place; if _current WERE DEFAULT_CONFIG
    // itself, that mutation would leak across reset calls. Cloning
    // makes the reset path symmetric with the overrides branch.
    _current = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
    return;
  }
  // Deep-merge so tests can override `stale: { separator: " · " }`
  // without erasing colors / bar / etc. Plain `...DEFAULT_CONFIG,
  // ...overrides` would replace the whole `stale` object with a partial
  // one missing separator / ageEmoji.
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  const merged = deepMerge(
    base,
    overrides as Record<string, unknown>,
  ) as Config;
  _current = merged;
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (over === null || typeof over !== "object" || Array.isArray(over))
    return over;
  if (base === null || typeof base !== "object" || Array.isArray(base))
    return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = v === undefined ? out[k] : deepMerge(out[k], v);
  }
  return out;
}

export const __testing = {
  DEFAULT_CONFIG,
  configPath: defaultConfigPath,
  setPathResolver(fn: () => string): void {
    _pathResolver = fn;
  },
  resetPathResolver(): void {
    _pathResolver = defaultConfigPath;
  },
};
