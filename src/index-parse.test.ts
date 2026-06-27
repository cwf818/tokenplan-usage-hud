// Tests for parseTokenSnapshot — the stdin → TokenSnapshot parser
// at the heart of the token-usage module. Validates against the
// real schema captured 2026-06-27.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTokenSnapshot } from "./session-parse.ts";

describe("parseTokenSnapshot — happy path", () => {
  it("extracts all fields from a real-shape stdin payload", () => {
    const raw = JSON.stringify({
      session_id: "b2bee628-bc4f-4c79-a198-cb39b098b547",
      cwd: "D:\\WorkSpace\\tokenplan-usage-hud",
      context_window: {
        total_input_tokens: 163479,
        total_output_tokens: 155,
        current_usage: {
          input_tokens: 38,
          output_tokens: 155,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 163441,
        },
      },
      cost: {
        total_duration_ms: 600_000,
      },
    });
    const snap = parseTokenSnapshot(raw);
    assert.ok(snap);
    assert.equal(snap!.sessionId, "b2bee628-bc4f-4c79-a198-cb39b098b547");
    assert.equal(snap!.cwd, "D:\\WorkSpace\\tokenplan-usage-hud");
    assert.equal(snap!.totals.input, 163479);
    assert.equal(snap!.totals.output, 155);
    assert.equal(snap!.current.input, 38);
    assert.equal(snap!.current.output, 155);
    assert.equal(snap!.current.cacheCreation, 0);
    assert.equal(snap!.current.cacheRead, 163441);
    assert.equal(snap!.cost.totalDurationMs, 600_000);
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