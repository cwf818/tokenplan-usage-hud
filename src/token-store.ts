// v0.4.0+ — token-sample state file.
//
// Each statusline tick appends one JSON line to
// `<claude-root>/plugins/tokenplan-usage-hud/state/token-samples/<projectHash>/<sessionId>.jsonl`.
// m_token5h / m_token7d read this file (filtered to the window) on every
// render. m_tokenIn / m_tokenOut / m_ctx / m_cacheRead / m_cacheHitRate /
// m_tokenInSpeed / m_tokenOutSpeed do NOT read this file — they read the
// live stdin snapshot directly, which is cheaper and always fresh.
//
// File format (one JSON object per line, append-only):
//   {"at":1782576199672,"session":"b2bee62...","in":163479,"out":155,
//    "ctx_in":38,"ctx_creation":0,"ctx_read":163441}
//
// Size: ~120B per row → 1h ≈ 4.3KB → 7d ≈ 700KB. Far below any IO budget
// concern. We never compact the file — older samples drop out of queries
// naturally when they're older than the largest window (7d).
//
// Why per-session file (D-name1): separate sessions shouldn't share or
// compete for the same append stream. Different projects may run
// concurrently; keeping each session in its own file avoids interleaving
// and lets future cleanup (e.g. `:clean`) target a specific session.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TokenSample } from "./types.ts";

// Root of all token-plan plugin state files. Sibling of `upstream-cmd.sh`
// and `config.json` — survives cache rolls and version bumps. (See
// scripts/install.sh for the layout reasoning.)
function stateRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return join(claudeRoot, "plugins", "tokenplan-usage-hud", "state");
}

// Project hash for the cwd — keeps one project's sessions isolated from
// another's. D-name1: separate subdir per projectDir. Lowercased + with
// path separators AND whitespace/control characters replaced by `-`.
// The whitespace+control pass matters because JSON.parse decodes \t, \n,
// \r as their literal control bytes — without scrubbing, those bytes end
// up in the directory name and Windows mkdir rejects them with ENOENT.
// Length cap so we don't construct arbitrarily deep paths on weird
// Windows-style `cwd`s.
export function projectHash(cwd: string): string {
  return cwd
    .replace(/[\\/:]/g, "-")
    .replace(/[\s\x00-\x1f\x7f]/g, "-")
    .toLowerCase()
    .slice(0, 80);
}

// Build the absolute path for a session's append-only JSONL.
export function sampleFilePath(cwd: string, sessionId: string): string {
  return join(stateRoot(), "token-samples", projectHash(cwd), `${sessionId}.jsonl`);
}

// Append one sample row. Atomic at the OS level for small writes
// (<= PIPE_BUF, which on Linux is 4096B — well above our ~120B row).
// Creates the directory tree on demand. Errors are swallowed (stderr
// only) so the statusline never blocks on disk failures — if the sample
// can't be written, the next tick still renders correctly off stdin.
export function appendSample(sample: TokenSample): void {
  const path = sampleFilePath(sample.cwd, sample.session);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(sample) + "\n", "utf8");
  } catch {
    process.stderr.write("tokenplan-usage-hud: token-sample append failed\n");
  }
}

// Read all samples for a session, in-memory filtered by `sinceMs`. Used
// by m_token5h/m_token7d to compute window-scoped totals. Returns [] on
// any error (file missing, malformed JSON, etc.) — the renderer falls
// back to "—" rather than throwing.
//
// The 7d upper bound caps the in-memory working set: a busy session
// produces ~700KB of JSONL over 7 days, which fits comfortably in
// memory and is bounded by the window itself. We do NOT rewrite the
// file to evict — when the file exceeds ~1MB, compaction can be a
// future `:clean` action; not in scope for v0.4.0.
export function readSamples(
  cwd: string,
  sessionId: string,
  sinceMs: number,
): TokenSample[] {
  const path = sampleFilePath(cwd, sessionId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: TokenSample[] = [];
  // split('\n') tolerates a trailing newline. We skip empty lines
  // (which can occur if a previous append was interrupted mid-line —
  // unlikely on POSIX but possible on Windows file locks).
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const r = parsed as Record<string, unknown>;
    if (
      typeof r.at !== "number" ||
      r.at < sinceMs ||
      typeof r.in !== "number" ||
      typeof r.out !== "number"
    ) {
      continue;
    }
    out.push({
      at: r.at,
      session: typeof r.session === "string" ? r.session : sessionId,
      cwd: typeof r.cwd === "string" ? r.cwd : cwd,
      in: r.in,
      out: r.out,
      ctx_in: typeof r.ctx_in === "number" ? r.ctx_in : 0,
      ctx_creation: typeof r.ctx_creation === "number" ? r.ctx_creation : 0,
      ctx_read: typeof r.ctx_read === "number" ? r.ctx_read : 0,
    });
  }
  return out;
}