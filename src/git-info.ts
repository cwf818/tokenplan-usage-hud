// v0.4.0+ — lightweight git info reader for statusline modules
// (m_branch, m_gitStatus). Reads only the bits needed for "what's the
// current branch / is the tree dirty" — no ahead/behind, no
// untracked file lists, no diff stats. The point is to keep the
// statusline responsive: each render spawns at most ONE git
// subprocess per cwd, with a TTL cache that spans ticks.
//
// Data flow:
//   readGitInfo(cwd) → { branch, dirty } | null
//   null when cwd is missing, not a git repo, or git is unavailable.
//
// Subprocess model:
//   We use synchronous child_process.execFileSync with a small fixed
//   set of git subcommands. execFileSync is fine here because (a)
//   the statusline is a single short-lived child process spawned
//   per Claude Code turn, (b) the git operations are O(milliseconds)
//   on warm caches, and (c) we want to keep the implementation
//   dependency-free (no libgit2 / no isomorphic-git). The cache
//   front-ends the cost so a burst of N statusline ticks in the
//   same cwd only pays for ONE git round-trip.
//
// Cache:
//   Map<cwd, { at: ms; value: GitInfo | null }>, default TTL 60s.
//   Matches the api.ts cache TTL — git status freshness isn't
//   user-critical at sub-minute resolution. Stale-on-error: if a
//   refresh throws, return the previous value (even if expired) so
//   the statusline doesn't blank. The resetTtlForTest export lets
//   tests reset the cache between cases.
//
// Why no ahead/behind:
//   "git rev-list --count @{u}..HEAD" requires an upstream tracking
//   ref, which not every repo has (fresh clones, detached HEADs,
//   repos without a configured push target). Handling that gracefully
//   adds branches that pull the simple "is this a normal repo"
//   question into "is this a normal repo WITH a sensible upstream
//   config" — too much surface for the statusline. Keep it simple.

import { execFileSync } from "node:child_process";

export type GitInfo = {
  branch: string;
  dirty: boolean;
};

let _cache: Map<string, { at: number; value: GitInfo | null }> = new Map();
const DEFAULT_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 2_000; // hard cap so a hung git can't stall the statusline

function execGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // suppress the "fatal: not a git repository" stderr noise —
      // a non-git cwd is the most common case and we don't want it
      // polluting the user's statusline stderr.
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

// Read fresh git info for one cwd. Runs three git invocations:
//   1. rev-parse --abbrev-ref HEAD  (branch name; "HEAD" when detached)
//   2. status --porcelain --branch  (dirty bit; one line per change)
// We deliberately avoid `git status` (the porcelain v1 default) since
// it pulls in ahead/behind info we don't use. --porcelain --branch
// gives us the porcelain machine-readable form: line 1 is the branch
// state ("## main...origin/main [ahead 3]"), subsequent lines are
// changes. We treat any non-empty change list as dirty.
//
// Returns null when:
//   - cwd is missing
//   - cwd is not inside a git work tree
//   - any required git command fails (binary missing, permission, etc.)
export function readGitInfoFresh(cwd: string | null | undefined): GitInfo | null {
  if (!cwd) return null;
  const branch = execGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch == null) return null;
  // "HEAD" (detached) is a valid branch value but we treat it as
  // "no useful git info for the statusline" — the user wants
  // "what branch am I on", not "I'm detached". Returning null here
  // lets the m_branch module drop instead of rendering "branch:HEAD".
  if (branch === "HEAD") return null;
  const status = execGit(cwd, ["status", "--porcelain"]);
  if (status == null) return null;
  // Any porcelain output beyond the first line (branch header) means
  // dirty. With --porcelain alone (no --branch), the first line is
  // gone, so a non-empty result == changes.
  return { branch, dirty: status.length > 0 };
}

// Cached read. The cache is process-local (Map) — we don't
// disk-shadow git info because (a) cwd changes invalidate it
// anyway, (b) disk reads would defeat the perf point, and (c) the
// 60s TTL is short enough that a stale read just means the user
// sees "branch:main" for one more minute after switching repos.
// Pass ttlMs=0 to force a fresh read (tests use this).
export function readGitInfo(
  cwd: string | null | undefined,
  ttlMs: number = DEFAULT_TTL_MS,
): GitInfo | null {
  if (!cwd) return null;
  const now = Date.now();
  const cached = _cache.get(cwd);
  if (cached && ttlMs > 0 && now - cached.at < ttlMs) {
    return cached.value;
  }
  const fresh = readGitInfoFresh(cwd);
  _cache.set(cwd, { at: now, value: fresh });
  return fresh;
}

// Test-only: drop the entire cache. Tests that exercise both
// "with cache" and "without cache" branches call this between cases
// to avoid cross-test pollution.
export function __resetGitInfoCacheForTest(): void {
  _cache = new Map();
}