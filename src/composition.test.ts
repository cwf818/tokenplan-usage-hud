import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compose } from "./composition.ts";

describe("compose", () => {
  it("emits only the plan line when no upstream", () => {
    assert.equal(compose(undefined, "5h ▓ 50% · wk ▓ 50%"), "5h ▓ 50% · wk ▓ 50%\n");
  });

  it("emits only upstream when plan line is null", () => {
    assert.equal(compose("hud line", null), "hud line");
  });

  it("emits upstream on first line, plan line on second", () => {
    const out = compose("hud line", "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "hud line\n5h ▓ 50% · wk ▓ 50%\n");
  });

  it("strips trailing newlines from upstream to avoid blank lines", () => {
    const out = compose("hud line\n\n", "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "hud line\n5h ▓ 50% · wk ▓ 50%\n");
  });

  it("preserves interior newlines in multi-line upstream", () => {
    const upstream = "line 1\nline 2\nline 3";
    const out = compose(upstream, "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "line 1\nline 2\nline 3\n5h ▓ 50% · wk ▓ 50%\n");
  });

  it("adds a missing trailing newline to upstream", () => {
    // No trailing \n on upstream — our line must not glue onto the last char.
    const out = compose("hud line", "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "hud line\n5h ▓ 50% · wk ▓ 50%\n");
  });

  it("emits empty upstream as just the plan line", () => {
    const out = compose("", "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "5h ▓ 50% · wk ▓ 50%\n");
  });

  it("injects ANSI reset when upstream ends with an unclosed SGR", () => {
    // Upstream paints its last segment red but never resets.
    const upstream = "ctx \x1b[31m[bold red]\x1b[0m \x1b[31m";
    const out = compose(upstream, "5h ▓ 50% · wk ▓ 50%");
    // The \x1b[0m is inserted between upstream's last char and our plan line.
    assert.equal(out, "ctx \x1b[31m[bold red]\x1b[0m \x1b[31m\n\x1b[0m5h ▓ 50% · wk ▓ 50%\n");
  });

  it("does not inject reset when upstream already ends with one", () => {
    const upstream = "ctx \x1b[31m[red]\x1b[0m";
    const out = compose(upstream, "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "ctx \x1b[31m[red]\x1b[0m\n5h ▓ 50% · wk ▓ 50%\n");
  });

  it("does not inject reset when upstream has no ANSI at all", () => {
    const upstream = "plain line\nanother line";
    const out = compose(upstream, "5h ▓ 50% · wk ▓ 50%");
    assert.equal(out, "plain line\nanother line\n5h ▓ 50% · wk ▓ 50%\n");
  });
});