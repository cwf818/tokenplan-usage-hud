// Tests for src/diagnostics.ts — JSONL append logger + opt-in gate.
//
// We exercise the module against a sandboxed path under tmpdir so the
// tests don't touch the user's real ~/.claude/plugins/.../state dir.
// The path is overridden via process.env.CLAUDE_CONFIG_DIR; each test
// resets that env to a fresh dir, runs the assertions, and cleans up.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

describe("diagnostics — isEnabled", () => {
  it("returns false when env var is unset", () => {
    assert.equal(
      isEnabledWith({}),
      false,
      "default must be off (opt-in)",
    );
  });

  it("returns false when env var is empty string", () => {
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "" }), false);
  });

  it("accepts '1' (truthy)", () => {
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "1" }), true);
  });

  it("accepts 'true' (truthy, mixed case)", () => {
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "TRUE" }), true);
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "True" }), true);
  });

  it("accepts 'yes' (truthy, with surrounding whitespace)", () => {
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: " yes " }), true);
  });

  it("rejects other values (0, no, false, arbitrary)", () => {
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "0" }), false);
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "no" }), false);
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "false" }), false);
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "off" }), false);
    assert.equal(isEnabledWith({ TOKENPLAN_DIAGNOSTICS_ENABLE: "enabled" }), false);
  });
});

describe("diagnostics — append + readLatest", () => {
  let sandbox: string;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "tokenplan-diag-"));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = sandbox;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function enable() {
    process.env.TOKENPLAN_DIAGNOSTICS_ENABLE = "1";
  }

  function disable() {
    delete process.env.TOKENPLAN_DIAGNOSTICS_ENABLE;
  }

  it("does NOT write to disk when gate is off (default)", () => {
    disable();
    append("error", "config", "should not be persisted", 1_000);
    // The diagnostics file path lives under CLAUDE_CONFIG_DIR; assert
    // it (and its parent dirs) do not exist.
    const p = diagnosticsPath();
    assert.equal(existsSyncSafe(p), false, "no file should be created");
  });

  it("writes one JSONL row per call when gate is on", () => {
    enable();
    append("warning", "config", "first", 1_000);
    append("error", "fetch", "second", 2_000);

    const raw = readFileSync(diagnosticsPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);

    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    assert.equal(a.level, "warning");
    assert.equal(a.source, "config");
    assert.equal(a.msg, "first");
    assert.equal(a.at, 1_000);
    assert.equal(b.level, "error");
    assert.equal(b.source, "fetch");
    assert.equal(b.msg, "second");
    assert.equal(b.at, 2_000);
  });

  it("readLatest returns the most recent matching entry by level", () => {
    enable();
    append("warning", "a", "old warn", 1_000);
    append("error", "a", "err 1", 2_000);
    append("warning", "a", "new warn", 3_000);
    append("error", "a", "err 2", 4_000);

    assert.deepEqual(
      readLatest("warning"),
      { at: 3_000, level: "warning", source: "a", msg: "new warn" },
    );
    assert.deepEqual(
      readLatest("error"),
      { at: 4_000, level: "error", source: "a", msg: "err 2" },
    );
  });

  it("readLatest returns null when no entry of that level exists", () => {
    enable();
    append("warning", "a", "only a warning", 1_000);
    assert.equal(readLatest("error"), null);
  });

  it("readLatest returns null when the file doesn't exist (gate off path)", () => {
    disable();
    // No prior append — file doesn't exist. readLatest is intentionally
    // NOT gated (reads whatever is on disk), so this just confirms the
    // missing-file branch returns null cleanly.
    assert.equal(readLatest("error"), null);
    assert.equal(readLatest("warning"), null);
  });

  it("caps the file at 200 lines, keeping the most recent", () => {
    enable();
    for (let i = 0; i < 250; i++) {
      append("error", "flood", `e${i}`, i);
    }
    const raw = readFileSync(diagnosticsPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 200, "must keep only the last 200");

    const firstKept = JSON.parse(lines[0]);
    const lastKept = JSON.parse(lines[lines.length - 1]);
    // First 50 were dropped, so the first kept is e50.
    assert.equal(firstKept.msg, "e50");
    assert.equal(lastKept.msg, "e249");
  });

  it("formatEntry caps message at 80 chars with ellipsis", () => {
    const e: Entry = { at: 0, level: "error", source: "x", msg: "x".repeat(200) };
    const out = formatEntry(e);
    // Glyph + space + 79 chars + ellipsis (1 char) = 1+1+79+1 = 82 chars
    // (the slice trims to MAX_DISPLAY_LEN-1 = 79 before appending the
    // ellipsis, so the body is exactly 79 + '…' = 80 chars).
    assert.ok(out.startsWith("✖ "));
    // Body portion length = 80 (capped). Plus glyph + space = 82.
    assert.equal(out.length, 82);
    assert.ok(out.endsWith("…"));
  });

  it("formatEntry uses ⚠ for warning level", () => {
    const e: Entry = { at: 0, level: "warning", source: "x", msg: "hi" };
    assert.equal(formatEntry(e), "⚠ hi");
  });
});

// Pull only the symbols we need — `import * as diagnostics` would
// collide with the JSONL output under tests that also need
// `diagnostics` to mean "the whole module". Using a namespace import
// here keeps the call sites uniform with how index.ts / render.ts
// consume it.
import * as diag from "./diagnostics.ts";

const {
  append,
  diagnosticsPath,
  formatEntry,
  isEnabled,
  readLatest,
} = diag;
type Entry = import("./diagnostics.ts").Entry;

// Helper: route isEnabled through a synthetic env object so the
// "isEnabled" tests don't have to touch process.env (which other
// tests in this file use). isEnabled's signature accepts a default
// of process.env, but accepting an explicit env object here lets us
// write pure-function-style assertions.
function isEnabledWith(env: Record<string, string | undefined>): boolean {
  const e: NodeJS.ProcessEnv = { ...env };
  return isEnabled(e);
}

// existsSync is sync and would cost an extra fs call per test —
// import lazily so the cost is paid only when this helper runs.
function existsSyncSafe(p: string): boolean {
  try {
    // Use a dynamic read so we don't need to import "existsSync"
    // up top just for this single use.
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}