// v0.4.0+ tests for src/git-info.ts — pure behavior, no git binary
// required for the null / missing-cwd branches (which use the early
// `cwd == null` short-circuit before any git call). The git-binary
// branches are exercised only on environments where git is on PATH
// and we can construct a temp repo; otherwise those tests are
// skipped via `if (gitAvailable())`.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  readGitInfo,
  readGitInfoFresh,
  __resetGitInfoCacheForTest,
} from "./git-info.ts";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokenplan-git-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  // One commit so the branch actually exists.
  writeFileSync(join(dir, "README"), "hi");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

describe("git-info — early-return branches", () => {
  beforeEach(() => __resetGitInfoCacheForTest());

  it("readGitInfoFresh returns null when cwd is null", () => {
    assert.equal(readGitInfoFresh(null), null);
  });

  it("readGitInfoFresh returns null when cwd is undefined", () => {
    assert.equal(readGitInfoFresh(undefined), null);
  });

  it("readGitInfoFresh returns null when cwd is empty string", () => {
    assert.equal(readGitInfoFresh(""), null);
  });

  it("readGitInfo returns null when cwd is null", () => {
    assert.equal(readGitInfo(null), null);
  });

  it("readGitInfo returns null when cwd is not a git repo", () => {
    // tmpdir root has no .git — execGit will fail on rev-parse,
    // readGitInfoFresh returns null.
    const notARepo = mkdtempSync(join(tmpdir(), "tokenplan-notrepo-"));
    try {
      assert.equal(readGitInfo(notARepo), null);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});

describe("git-info — live git integration", { skip: !gitAvailable() }, () => {
  let repoDir: string;

  before(() => {
    repoDir = initTempRepo();
  });

  after(() => {
    if (repoDir) rmSync(repoDir, { recursive: true, force: true });
  });

  beforeEach(() => __resetGitInfoCacheForTest());

  it("readGitInfoFresh on a fresh repo returns { branch: 'main', dirty: false }", () => {
    const info = readGitInfoFresh(repoDir);
    assert.deepEqual(info, { branch: "main", dirty: false });
  });

  it("readGitInfo caches the result within TTL", () => {
    const a = readGitInfo(repoDir, 60_000);
    // Dirty the working tree, then read again with a warm cache.
    // The cached value (clean) should come back because TTL is 60s.
    writeFileSync(join(repoDir, "new.txt"), "dirty content");
    const b = readGitInfo(repoDir, 60_000);
    assert.deepEqual(a, { branch: "main", dirty: false });
    assert.deepEqual(b, { branch: "main", dirty: false });
  });

  it("readGitInfo with ttlMs=0 forces a fresh read", () => {
    readGitInfo(repoDir, 60_000); // warm cache
    writeFileSync(join(repoDir, "new.txt"), "dirty");
    const fresh = readGitInfo(repoDir, 0);
    assert.deepEqual(fresh, { branch: "main", dirty: true });
  });

  it("readGitInfo detects a dirty working tree after a fresh write", () => {
    writeFileSync(join(repoDir, "another.txt"), "x");
    const info = readGitInfo(repoDir, 0); // skip cache
    assert.deepEqual(info, { branch: "main", dirty: true });
  });

  it("readGitInfo detects a dirty working tree via a tracked-file edit", () => {
    writeFileSync(join(repoDir, "README"), "modified");
    const info = readGitInfo(repoDir, 0);
    assert.deepEqual(info, { branch: "main", dirty: true });
  });

  it("readGitInfo returns null for a detached HEAD (rev-parse prints 'HEAD')", () => {
    // Detach HEAD onto the current commit; rev-parse --abbrev-ref
    // returns the literal string "HEAD" which we treat as "no
    // useful branch info for the statusline".
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "-q", sha], { cwd: repoDir });
    try {
      const info = readGitInfoFresh(repoDir);
      assert.equal(info, null);
    } finally {
      // Reattach so the after() cleanup can rm the temp dir cleanly.
      execFileSync("git", ["checkout", "-q", "main"], { cwd: repoDir });
    }
  });

  it("readGitInfo returns null for an empty git directory (no commits yet)", () => {
    // `git init` alone (no commit) leaves HEAD unborn; rev-parse
    // fails because there's no current branch. Should return null.
    const emptyDir = mkdtempSync(join(tmpdir(), "tokenplan-empty-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: emptyDir });
      mkdirSync(join(emptyDir, ".gitkeep"));
      const info = readGitInfo(emptyDir);
      assert.equal(info, null);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});