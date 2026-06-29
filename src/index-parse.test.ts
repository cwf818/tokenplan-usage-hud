// Tests for parseTokenSnapshot — the stdin → TokenSnapshot parser
// at the heart of the token-usage module. Validates against the
// real schema captured 2026-06-29 (see __fixtures__/stdin.real.json).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTokenSnapshot } from "./session-parse.ts";

// Real-shape fixture (captured 2026-06-29). Loaded once at module top
// so individual tests can assert against it without re-reading the file.
const STDIN_REAL = readFileSync(
  fileURLToPath(new URL("./__fixtures__/stdin.real.json", import.meta.url)),
  "utf8",
);

describe("parseTokenSnapshot — happy path", () => {
  it("extracts all fields from the captured stdin payload", () => {
    const snap = parseTokenSnapshot(STDIN_REAL);
    assert.ok(snap);
    // Existing fields (unchanged from v0.4.0 dev work)
    assert.equal(snap!.sessionId, "b2bee628-bc4f-4c79-a198-cb39b098b547");
    assert.equal(snap!.cwd, "D:\\WorkSpace\\tokenplan-usage-hud");
    assert.equal(snap!.totals.input, 126860);
    assert.equal(snap!.totals.output, 265);
    assert.equal(snap!.current.input, 140);
    assert.equal(snap!.current.output, 265);
    assert.equal(snap!.current.cacheCreation, 0);
    assert.equal(snap!.current.cacheRead, 126720);
    assert.equal(snap!.cost.totalDurationMs, 74514744);
    // v0.4.0+ — session identity / metadata
    assert.equal(snap!.sessionName, "strip-diagnostics-display");
    assert.equal(snap!.modelDisplayName, "MiniMax-M3");
    assert.equal(snap!.effort, "high");
    assert.deepEqual(snap!.repo, {
      host: "github.com",
      owner: "cwf818",
      name: "tokenplan-usage-hud",
    });
    assert.equal(snap!.ccversion, "2.1.191");
    // v0.4.0+ — context window
    assert.equal(snap!.contextWindow!.size, 200000);
    assert.equal(snap!.contextWindow!.usedPct, 63);
    assert.equal(snap!.contextWindow!.remainingPct, 37);
    // v0.4.0+ — extended cost
    assert.equal(snap!.cost.totalApiDurationMs, 8301407);
    assert.equal(snap!.cost.totalLinesAdded, 3965);
    assert.equal(snap!.cost.totalLinesRemoved, 967);
  });

  it("tolerates missing context_window", () => {
    const raw = JSON.stringify({ session_id: "x", cwd: "/y" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.sessionId, "x");
    assert.equal(snap!.cwd, "/y");
    assert.equal(snap!.totals.input, null);
    assert.equal(snap!.totals.output, null);
    assert.equal(snap!.current.input, null);
    assert.equal(snap!.current.cacheRead, null);
    assert.equal(snap!.cost.totalDurationMs, null);
    assert.equal(snap!.contextWindow!.size, null);
    assert.equal(snap!.contextWindow!.usedPct, null);
  });

  it("tolerates current_usage being a number instead of object", () => {
    // ccstatusline schema allows `current_usage: number | object`.
    // Our parser only handles the object shape; a bare number
    // yields null current.* fields, not an error.
    const raw = JSON.stringify({
      context_window: { current_usage: 12345 },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.current.input, null);
    assert.equal(snap!.current.cacheRead, null);
  });

  it("tolerates cost being missing", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.cost.totalDurationMs, null);
    assert.equal(snap!.cost.totalApiDurationMs, null);
    assert.equal(snap!.cost.totalLinesAdded, null);
    assert.equal(snap!.cost.totalLinesRemoved, null);
  });
});

describe("parseTokenSnapshot — v0.4.0+ field edge cases", () => {
  it("tolerates missing model", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.modelDisplayName, null);
  });

  it("tolerates model without display_name", () => {
    const raw = JSON.stringify({ model: { id: "foo" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.modelDisplayName, null);
  });

  it("tolerates missing workspace", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.repo, null);
  });

  it("tolerates workspace without repo", () => {
    const raw = JSON.stringify({ workspace: { current_dir: "/y" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.repo, null);
  });

  it("tolerates missing version", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.ccversion, null);
  });

  it("tolerates missing effort", () => {
    const raw = JSON.stringify({ session_id: "x" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, null);
  });

  it("tolerates effort as a string", () => {
    // Some clients may send effort as a bare string. Coerce to itself.
    const raw = JSON.stringify({ effort: "high" });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, "high");
  });

  it("tolerates effort as an object with .level", () => {
    const raw = JSON.stringify({ effort: { level: "high" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, "high");
  });

  it("tolerates effort as an object without .level", () => {
    const raw = JSON.stringify({ effort: { other: "x" } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.effort, null);
  });

  it("tolerates repo with all-null sub-fields", () => {
    const raw = JSON.stringify({
      workspace: { repo: { host: null, owner: null, name: null } },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    // The parser still constructs a sub-object; the renderer filters
    // it down to an empty join and returns null. This is intentional —
    // keeping the sub-object lets the renderer distinguish "repo was
    // present but empty" from "repo was missing".
    assert.deepEqual(snap!.repo, { host: null, owner: null, name: null });
  });

  it("tolerates repo with partial sub-fields", () => {
    const raw = JSON.stringify({
      workspace: { repo: { host: "github.com", owner: null, name: "x" } },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.deepEqual(snap!.repo, { host: "github.com", owner: null, name: "x" });
  });

  it("tolerates missing context_window_size / used% / remaining%", () => {
    const raw = JSON.stringify({ context_window: { total_input_tokens: 100 } });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.contextWindow!.size, null);
    assert.equal(snap!.contextWindow!.usedPct, null);
    assert.equal(snap!.contextWindow!.remainingPct, null);
  });
});

describe("parseTokenSnapshot — null cases", () => {
  it("empty raw → null", () => {
    assert.equal(parseTokenSnapshot(""), null);
  });

  it("invalid JSON → null", () => {
    assert.equal(parseTokenSnapshot("not json"), null);
  });

  it("non-object root → null", () => {
    assert.equal(parseTokenSnapshot("123"), null);
    assert.equal(parseTokenSnapshot("null"), null);
    assert.equal(parseTokenSnapshot('"hello"'), null);
  });

  it("array root → null", () => {
    assert.equal(parseTokenSnapshot("[1, 2, 3]"), null);
  });
});
