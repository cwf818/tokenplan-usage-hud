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

// ----- Defaults — must match today's hardcoded values exactly -----

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
  // Separator between the data line and the " · Xm ago" suffix.
  separator: " · ",
  // Sub-minute ages round UP to this many minutes ("0m ago" looks broken).
  minMinutes: 1,
  // Suffix for the reset countdown on the percentage line.
  resetArrow: "↻",
};

const DEFAULT_BAR = {
  width: 8,
  filled: "▓",
  empty: "░",
};

type DisplayMode = "used" | "remaining";

const DEFAULT_CONFIG: {
  cacheTtlMs: number;
  fetchTimeoutMs: number;
  display: DisplayMode;
  modeLabels: { used: string; remaining: string };
  colors: typeof DEFAULT_COLORS;
  thresholds: typeof DEFAULT_THRESHOLDS;
  currency: typeof DEFAULT_CURRENCY;
  stale: typeof DEFAULT_STALE;
  bar: typeof DEFAULT_BAR;
} = {
  cacheTtlMs: 60_000,
  fetchTimeoutMs: 5_000,
  display: "used",
  modeLabels: { used: "Usage:", remaining: "Remain:" },
  colors: DEFAULT_COLORS,
  thresholds: DEFAULT_THRESHOLDS,
  currency: DEFAULT_CURRENCY,
  stale: DEFAULT_STALE,
  bar: DEFAULT_BAR,
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
};

// ----- Loader -----

function defaultConfigPath(): string {
  return join(homedir(), ".claude", "plugins", "tokenplan-usage-hud", "config.json");
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

function warn(msg: string): void {
  process.stderr.write(`tokenplan-usage-hud: config ${msg}\n`);
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

function mergeConfig(raw: Record<string, unknown>): Config {
  // Deep-clone defaults into a fresh mutable object. JSON round-trip is
  // fine here — Config is plain data, no functions / Dates / Maps.
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;

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
      else if ("used" in m) warn("modeLabels.used must be a string; using default");
      if (typeof m.remaining === "string") out.modeLabels.remaining = m.remaining;
      else if ("remaining" in m) warn("modeLabels.remaining must be a string; using default");
    } else {
      warn("modeLabels must be an object; using default");
    }
  }

  // colors — per-field validation, partial acceptance
  if ("colors" in raw) {
    const c = raw.colors;
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const cm = c as Record<string, unknown>;
      for (const key of ["brightGreen", "darkGreen", "yellow", "orange", "red", "stale"] as const) {
        if (key in cm) {
          const norm = normalizeColor(cm[key]);
          if (norm) {
            out.colors[key] = norm;
          } else {
            warn(`colors.${key} must be an ANSI SGR string or a known shortcut; using default`);
          }
        }
      }
    } else {
      warn("colors must be an object; using default");
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
          warn("thresholds.minimaxPercent must be 4 ascending numbers; using default");
        }
      }
      if ("deepseekBalance" in tm) {
        if (isAscending4Tuple(tm.deepseekBalance)) {
          out.thresholds.deepseekBalance = tm.deepseekBalance;
        } else {
          warn("thresholds.deepseekBalance must be 4 ascending numbers; using default");
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
        if (cm.prefixes && typeof cm.prefixes === "object" && !Array.isArray(cm.prefixes)) {
          const merged: Record<string, string> = { ...DEFAULT_CURRENCY.prefixes };
          for (const [k, v] of Object.entries(cm.prefixes as Record<string, unknown>)) {
            if (typeof v === "string") merged[k.toUpperCase()] = v;
          }
          out.currency.prefixes = merged;
        } else {
          warn("currency.prefixes must be an object; using default");
        }
      }
      if ("fallback" in cm) {
        if (typeof cm.fallback === "string") out.currency.fallback = cm.fallback;
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

  // stale
  if ("stale" in raw) {
    const s = raw.stale;
    if (s && typeof s === "object" && !Array.isArray(s)) {
      const sm = s as Record<string, unknown>;
      if ("separator" in sm) {
        if (typeof sm.separator === "string") out.stale.separator = sm.separator;
        else warn("stale.separator must be a string; using default");
      }
      if ("minMinutes" in sm) {
        if (isFinitePositiveNumber(sm.minMinutes)) out.stale.minMinutes = sm.minMinutes;
        else warn("stale.minMinutes must be a positive number; using default");
      }
      if ("resetArrow" in sm) {
        if (typeof sm.resetArrow === "string") out.stale.resetArrow = sm.resetArrow;
        else warn("stale.resetArrow must be a string; using default");
      }
    } else {
      warn("stale must be an object; using default");
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
        if (isFiniteNumber(bm.width) && (bm.width as number) >= 3 && (bm.width as number) <= 64) {
          out.bar.width = bm.width;
        } else {
          warn("bar.width must be an integer in [3, 64]; using default");
        }
      }
      if ("filled" in bm) {
        if (typeof bm.filled === "string" && !/\n/.test(bm.filled)) out.bar.filled = bm.filled;
        else warn("bar.filled must be a single-line string; using default");
      }
      if ("empty" in bm) {
        if (typeof bm.empty === "string" && !/\n/.test(bm.empty)) out.bar.empty = bm.empty;
        else warn("bar.empty must be a single-line string; using default");
      }
    } else {
      warn("bar must be an object; using default");
    }
  }

  return out;
}

// ----- Test-only -----

export function __resetForTest(overrides?: Partial<Config>): void {
  if (overrides === undefined) {
    _current = DEFAULT_CONFIG;
    return;
  }
  _current = { ...DEFAULT_CONFIG, ...overrides };
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
