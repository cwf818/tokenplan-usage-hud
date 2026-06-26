import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetForTest,
  __testing,
  configStore,
  loadConfig,
} from "./config.ts";

const { DEFAULT_CONFIG, setPathResolver, resetPathResolver } = __testing;

let tmpDir: string;
let capturedStderr: string;
let originalWrite: (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "config-test-"));
  setPathResolver(() => join(tmpDir, "config.json"));
  __resetForTest();
  capturedStderr = "";
  // process.stderr.write has many overloads (string / Buffer / Uint8Array /
  // encoding+callback). Cast through `any` to capture the existing
  // reference and to assign a single-signature replacement. config.ts
  // only ever calls write(string), so the replacement only needs to
  // handle that case.
  const err = process.stderr as any;
  originalWrite = (err.write as unknown as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean).bind(process.stderr);
  err.write = ((chunk: unknown): boolean => {
    capturedStderr += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return true;
  }) as unknown as typeof err.write;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  resetPathResolver();
  (process.stderr as any).write = originalWrite;
});

describe("loadConfig — missing file", () => {
  it("returns DEFAULT_CONFIG silently (no stderr) when the file does not exist", async () => {
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — valid override", () => {
  it("applies valid top-level overrides", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        cacheTtlMs: 30_000,
        display: "remaining",
        fetchTimeoutMs: 7_500,
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.cacheTtlMs, 30_000);
    assert.equal(cfg.display, "remaining");
    assert.equal(cfg.fetchTimeoutMs, 7_500);
    // Other fields keep their defaults.
    assert.equal(cfg.bar.width, DEFAULT_CONFIG.bar.width);
    assert.equal(cfg.colors.red, DEFAULT_CONFIG.colors.red);
  });

  it("applies nested overrides (colors, thresholds, bar)", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        colors: { red: "brightBlack", yellow: "\x1b[38;5;226m" },
        thresholds: { minimaxPercent: [10, 30, 50, 70] },
        bar: { width: 12 },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.colors.red, "\x1b[90m"); // brightBlack shortcut
    assert.equal(cfg.colors.yellow, "\x1b[38;5;226m");
    assert.equal(cfg.colors.brightGreen, DEFAULT_CONFIG.colors.brightGreen); // untouched
    assert.deepEqual(cfg.thresholds.minimaxPercent, [10, 30, 50, 70]);
    assert.deepEqual(cfg.thresholds.deepseekBalance, [5, 10, 20, 50]); // untouched
    assert.equal(cfg.bar.width, 12);
  });

  it("accepts symbolic color shortcuts", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ colors: { brightGreen: "brightGreen", stale: "brightBlack" } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.colors.brightGreen, "\x1b[38;5;41m");
    assert.equal(cfg.colors.stale, "\x1b[90m");
  });

  it("normalizes currency.prefixes keys to upper-case", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ currency: { prefixes: { usd: "U$", eur: "€" } } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.currency.prefixes.USD, "U$");
    assert.equal(cfg.currency.prefixes.EUR, "€");
    // Original keys preserved alongside.
    assert.equal(cfg.currency.prefixes.CNY, "￥");
  });
});

describe("loadConfig — malformed input", () => {
  it("falls back to defaults when JSON is invalid", async () => {
    writeFileSync(join(tmpDir, "config.json"), "{ not valid json");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.match(capturedStderr, /config invalid JSON/);
  });

  it("falls back to defaults when root is not an object", async () => {
    writeFileSync(join(tmpDir, "config.json"), "42");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.match(capturedStderr, /root must be a JSON object/);
  });

  it("falls back to defaults when root is an array", async () => {
    writeFileSync(join(tmpDir, "config.json"), "[1,2,3]");
    const cfg = await loadConfig();
    assert.deepEqual(cfg, DEFAULT_CONFIG);
    assert.match(capturedStderr, /root must be a JSON object/);
  });
});

describe("loadConfig — partial / per-section validation", () => {
  it("drops a bad field but keeps the rest of that section", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        colors: { red: -1, yellow: "\x1b[38;5;226m" }, // bad red, good yellow
      }),
    );
    const cfg = await loadConfig();
    // bad field dropped to default, good field applied
    assert.equal(cfg.colors.red, DEFAULT_CONFIG.colors.red);
    assert.equal(cfg.colors.yellow, "\x1b[38;5;226m");
    assert.match(capturedStderr, /colors\.red/);
  });

  it("does NOT poison unrelated sections when one section is bad", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        colors: "not an object", // entire colors block invalid
        cacheTtlMs: 12_345, // perfectly fine
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.cacheTtlMs, 12_345);
    assert.equal(cfg.colors.red, DEFAULT_CONFIG.colors.red);
    assert.match(capturedStderr, /colors must be an object/);
  });

  it("rejects ascending thresholds that are not 4-tuple", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ thresholds: { minimaxPercent: [20, 40] } }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.thresholds.minimaxPercent, [20, 40, 60, 80]);
    assert.match(capturedStderr, /thresholds\.minimaxPercent/);
  });

  it("rejects non-ascending threshold tuples", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ thresholds: { minimaxPercent: [40, 20, 60, 80] } }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.thresholds.minimaxPercent, [20, 40, 60, 80]);
    assert.match(capturedStderr, /thresholds\.minimaxPercent/);
  });

  it("rejects display values outside the enum", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ display: "sideways" }));
    const cfg = await loadConfig();
    assert.equal(cfg.display, "used");
    assert.match(capturedStderr, /display/);
  });

  it("rejects bar.width outside [3, 64]", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ bar: { width: 100 } }));
    const cfg = await loadConfig();
    assert.equal(cfg.bar.width, 8);
    assert.match(capturedStderr, /bar\.width/);
  });

  it("rejects cacheTtlMs that is not a positive number", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ cacheTtlMs: -1 }));
    const cfg = await loadConfig();
    assert.equal(cfg.cacheTtlMs, 60_000);
    assert.match(capturedStderr, /cacheTtlMs/);
  });

  it("rejects bar.filled containing a newline (statusline injection guard)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ bar: { filled: "▓\n" } }));
    const cfg = await loadConfig();
    assert.equal(cfg.bar.filled, "▓");
    assert.match(capturedStderr, /bar\.filled/);
  });
});

describe("loadConfig — stale.resetArrows", () => {
  it("default is the 12-emoji clock face array", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.stale.resetArrows.length, 12);
    assert.equal(cfg.stale.resetArrows[0], "🕛");
    assert.equal(cfg.stale.resetArrows[11], "🕐");
  });

  it("accepts a custom array of single-line strings", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrows: ["⏳", "⌛"] }
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.stale.resetArrows, ["⏳", "⌛"]);
  });

  it("rejects a non-array resetArrows (e.g. a string) and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrows: "↻" }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.stale.resetArrows.length, 12);
    assert.equal(cfg.stale.resetArrows[0], "🕛");
    assert.match(capturedStderr, /resetArrows/);
  });

  it("rejects an empty array and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrows: [] }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.stale.resetArrows.length, 12);
    assert.match(capturedStderr, /resetArrows/);
  });

  it("rejects an array containing non-strings or multi-line strings and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrows: ["OK", 42, "fine\n", null] }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.stale.resetArrows.length, 12);
    assert.match(capturedStderr, /resetArrows/);
  });

  it("silently ignores the v0.2.1 resetArrowMore / resetArrowLess keys (now unused)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrowMore: "X", resetArrowLess: "Y" }
    }));
    const cfg = await loadConfig();
    // The 12-emoji default is still in place; old keys are silently ignored.
    assert.equal(cfg.stale.resetArrows.length, 12);
    assert.equal(cfg.stale.resetArrows[0], "🕛");
  });
});

describe("display precedence", () => {
  it("config.json wins over the hardcoded default", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ display: "remaining" }));
    const cfg = await loadConfig();
    assert.equal(cfg.display, "remaining");
  });
});

describe("configStore singleton", () => {
  it("get() reflects the most recently loaded config", async () => {
    assert.equal(configStore.get().display, "used");
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ display: "remaining" }));
    await loadConfig();
    assert.equal(configStore.get().display, "remaining");
  });

  it("__resetForTest() restores DEFAULT_CONFIG without touching disk", () => {
    __resetForTest({ cacheTtlMs: 999 });
    assert.equal(configStore.get().cacheTtlMs, 999);
    __resetForTest();
    assert.equal(configStore.get().cacheTtlMs, 60_000);
  });
});
