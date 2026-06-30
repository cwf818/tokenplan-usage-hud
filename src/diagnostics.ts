// v0.4.0+ — diagnostics log.
//
// Persistent JSONL append log for warnings and errors emitted during
// the plugin's lifetime.
//
// Per-Project Layout (v0.4.x+): when a `cwd` is provided to `append` /
// `readLatest` / `diagnosticsPath`, the log lives at
// `${CLAUDE_CONFIG_DIR}/plugins/tokenplan-usage-hud/state/<projectHash>/diagnostics.jsonl`.
// When `cwd` is omitted (or null/empty), the log falls back to the
// legacy top-level
// `${CLAUDE_CONFIG_DIR}/plugins/tokenplan-usage-hud/state/diagnostics.jsonl`.
// The fallback is used for plugin-level errors that have no project
// affiliation (e.g. config-parse warnings from `src/config.ts`).
//
// Each line is a structured record:
//
//   {"at":1782576199672,"level":"warn","source":"config","msg":"…"}
//
// Two consumers:
//   1. m_error / m_warning display modules (src/render.ts) — read the
//      most recent line of each level to render an inline indicator.
//   2. Postmortem — a user who wants to know "why did the plugin break
//      yesterday" can tail the file directly. JSONL is greppable and
//      structured (timestamp + level + source + message).
//
// Size policy: cap at 200 lines, oldest dropped on every append.
//   ~200B per line × 200 = ~40KB. Negligible. Anything older than
//   200 events is uninteresting by definition (we just want a tail).
//   The :clean slash command can wipe the file outright.
//
// Why NOT a separate "head" file (e.g. diagnostics.json with just the
// latest error/warning): every statusline tick is a fresh child
// process, so the in-memory cache of "last error" must be re-read
// from disk. Reading a 40KB JSONL and tailing the last matching line
// is fast (<1ms); a separate head file would shave ~0.5ms at the
// cost of double-write logic. Not worth it.
//
// Opt-in gate: writing the log file is OFF by default. Set
// `TOKENPLAN_DIAGNOSTICS_ENABLE=1` (or `true` / `yes`, case-insensitive)
// to enable. Rationale: the file lives in the user's plugins dir and
// may contain sensitive fragments (paths, error text from upstream
// libraries), so we don't write unless the user explicitly asks.
// The stderr "append failed" line is independent of this gate —
// silent when the file write succeeds, present when it doesn't,
// regardless of opt-in state.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectHash } from "./token-store.ts";

// ----- Path -----

function stateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "tokenplan-usage-hud", "state");
}

// Resolve the diagnostics.jsonl path for a given project cwd. When
// `cwd` is a non-empty string, the file lives at
// `state/<projectHash(cwd)>/diagnostics.jsonl` (Per-Project Layout).
// When `cwd` is null/empty/undefined, we fall back to the legacy
// top-level `state/diagnostics.jsonl` so plugin-level errors that
// have no project affiliation (config-parse warnings, etc.) can still
// be logged.
function diagnosticsFilePath(cwd: string | null | undefined): string {
  if (cwd && cwd.length > 0) {
    return join(stateRoot(), projectHash(cwd), "diagnostics.jsonl");
  }
  return join(stateRoot(), "diagnostics.jsonl");
}

export function diagnosticsPath(cwd?: string | null): string {
  return diagnosticsFilePath(cwd);
}

// ----- Types -----

export type Level = "error" | "warning" | "info";

// One JSONL row. Structured so a postmortem reader can grep by level
// or by source without parsing the message.
export type Entry = {
  at: number;
  level: Level;
  source: string;
  msg: string;
};

// Cap on file length. Append drops the oldest line(s) when the file
// would exceed this — keeps the file bounded regardless of error
// rate. Tests can lower this via the optional 3rd arg to append.
const DEFAULT_MAX_ENTRIES = 200;

// ----- Gate -----

// True iff TOKENPLAN_DIAGNOSTICS_ENABLE is set to a truthy value
// (1 / true / yes, case-insensitive). Anything else — including the
// variable being unset — is treated as OFF. The user's log file
// should not silently fill up; the gate is opt-in.
export function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.TOKENPLAN_DIAGNOSTICS_ENABLE;
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

// ----- Append -----

// Append one entry. Atomic at the OS level for small writes
// (<= PIPE_BUF, 4096B on Linux — well above our ~200B row). Creates
// the parent dir on demand. Disk errors are swallowed (stderr only)
// so the statusline never blocks on log-write failures. No-ops
// when the opt-in gate is off — see isEnabled() above.
//
// `cwd` (optional): when provided, the entry is written to the
// project-scoped diagnostics file at `state/<projectHash>/diagnostics.jsonl`.
// When omitted/null, the entry falls back to the legacy top-level
// `state/diagnostics.jsonl` (used for plugin-level errors with no
// project affiliation, e.g. config-parse warnings).
export function append(
  level: Level,
  source: string,
  msg: string,
  now: number = Date.now(),
  cwd?: string | null,
): void {
  if (!isEnabled()) return;
  const path = diagnosticsFilePath(cwd);
  const entry: Entry = { at: now, level, source, msg };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
    // Truncate to the last MAX_ENTRIES lines. Best-effort: if any step
    // fails we just leave the file alone — the next append will retry.
    trimToMax(path, DEFAULT_MAX_ENTRIES);
  } catch {
    process.stderr.write("tokenplan-usage-hud: diagnostics append failed\n");
  }
}

// Trim a JSONL file to its last N lines. Reads the whole file (small),
// drops the head, writes back. Synchronous — keeps the API simple
// and is fast for our file size (40KB cap).
function trimToMax(path: string, max: number): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  // lines.length includes a trailing empty string if the file ended
  // with \n. Drop that before counting.
  const real = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
  if (real.length <= max) return;
  const kept = real.slice(-max);
  try {
    writeFileSync(path, kept.join("\n") + "\n", "utf8");
  } catch {
    // Best-effort — don't crash on a failed trim.
  }
}

// ----- Read -----

// Find the most recent entry of a given level. Used by m_error /
// m_warning to display the latest signal. Returns null when no entry
// of that level exists (clean state) or the file is malformed.
//
// Iterates the JSONL backward — the typical case (1-3 lines, fresh
// errors) hits the match immediately. For a fully-populated 200-line
// file this is O(200) which is still microseconds.
//
// `cwd` (optional): when provided, reads from the project-scoped
// file at `state/<projectHash>/diagnostics.jsonl`. When omitted/null,
// reads from the legacy top-level `state/diagnostics.jsonl`.
export function readLatest(level: Level, cwd?: string | null): Entry | null {
  const path = diagnosticsFilePath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  // Walk backward. Skip the trailing empty string that split('\n')
  // leaves when the file ends with \n.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (r.level === level && typeof r.msg === "string") {
      return {
        at: typeof r.at === "number" ? r.at : 0,
        level,
        source: typeof r.source === "string" ? r.source : "",
        msg: r.msg,
      };
    }
  }
  return null;
}

// ----- Format -----

// Compact display string for the m_error / m_warning modules. The
// message is rendered verbatim — diagnostics are for the user, so the
// message is the signal, not a hash or code. Cap at a reasonable
// length to avoid blowing up the statusline.
const MAX_DISPLAY_LEN = 80;
export function formatEntry(e: Entry): string {
  const truncated = e.msg.length > MAX_DISPLAY_LEN
    ? e.msg.slice(0, MAX_DISPLAY_LEN - 1) + "…"
    : e.msg;
  // Prefix with a one-glyph marker so the user can tell warn vs error
  // at a glance even after stripping SGR.
  return `${levelGlyph(e.level)} ${truncated}`;
}

function levelGlyph(level: Level): string {
  return level === "error" ? "✖" : "⚠";
}

// ----- Test hooks -----

// Clear the in-process diagnostics path. Tests use this between cases
// so append/readLatest don't leak across fixtures. Also a no-op
// safety for production — if the user manually deletes the file
// between ticks, the next read returns null cleanly.
export function __resetForTest(): void {
  // No module-level mutable state today; left as a hook for future
  // state (e.g. an in-memory cache that should be cleared on test
  // isolation). Kept here so test imports don't churn.
}