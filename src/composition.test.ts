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
});