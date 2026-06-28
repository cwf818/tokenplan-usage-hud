import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  __resetForTest,
  __testing,
  applyProviderOverrides,
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

describe("loadConfig — countdown.resetArrows", () => {
  it("default is the 12-emoji clock face array", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.equal(cfg.countdown.resetArrows[0], "🕛");
    assert.equal(cfg.countdown.resetArrows[11], "🕐");
  });

  it("accepts a custom array of single-line strings", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: ["⏳", "⌛"] }
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.countdown.resetArrows, ["⏳", "⌛"]);
  });

  it("rejects a non-array resetArrows (e.g. a string) and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: "↻" }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.equal(cfg.countdown.resetArrows[0], "🕛");
    assert.match(capturedStderr, /resetArrows/);
  });

  it("rejects an empty array and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: [] }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.match(capturedStderr, /resetArrows/);
  });

  it("rejects an array containing non-strings or multi-line strings and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      countdown: { resetArrows: ["OK", 42, "fine\n", null] }
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.match(capturedStderr, /resetArrows/);
  });

  it("silently ignores the v0.2.1 resetArrowMore / resetArrowLess keys (now unused)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      stale: { resetArrowMore: "X", resetArrowLess: "Y" }
    }));
    const cfg = await loadConfig();
    // The 12-emoji default is still in place; old keys are silently ignored.
    assert.equal(cfg.countdown.resetArrows.length, 12);
    assert.equal(cfg.countdown.resetArrows[0], "🕛");
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

describe("loadConfig — timeFormat (top-level)", () => {
  it("defaults: minUnit='m', maxUnitCount=2", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.timeFormat.minUnit, "m");
    assert.equal(cfg.timeFormat.maxUnitCount, 2);
  });

  it("accepts minUnit='s' override", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { minUnit: "s" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.minUnit, "s");
    // maxUnitCount keeps its default when only minUnit is overridden.
    assert.equal(cfg.timeFormat.maxUnitCount, 2);
  });

  it("accepts maxUnitCount override", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: 4 },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 4);
  });

  it("clamps maxUnitCount to [1, 4]", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: 99 },
    }));
    let cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 4);
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: 0 },
    }));
    cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 1);
  });

  it("accepts minUnit='h' (hour granularity)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { minUnit: "h" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.minUnit, "h");
  });

  it("rejects out-of-enum minUnit and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { minUnit: "d" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.minUnit, "m");
    assert.match(capturedStderr, /timeFormat\.minUnit/);
  });

  it("rejects non-numeric maxUnitCount and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      timeFormat: { maxUnitCount: "two" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.timeFormat.maxUnitCount, 2);
    assert.match(capturedStderr, /timeFormat\.maxUnitCount/);
  });
});

describe("loadConfig — separators (top-level)", () => {
  it("defaults: s_0=' ', s_1='·'", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.separators.length, 2);
    assert.equal(cfg.separators[0], " ");
    assert.equal(cfg.separators[1], "·");
  });

  it("accepts a custom array of single-line strings", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      separators: [" | ", " / "],
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.separators, [" | ", " / "]);
  });

  it("rejects non-string entries (warns and drops them)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      separators: ["OK", 42, "fine"],
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.separators, ["OK", "fine"]);
    assert.match(capturedStderr, /separators/);
  });

  it("accepts '\\n' as a separator (v0.4.0+ multi-line layouts)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      separators: [" ", "·", "\n"],
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.separators, [" ", "·", "\n"]);
  });

  it("accepts a separator that IS just '\\n' (single-element multi-line)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      separators: ["\n"],
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.separators, ["\n"]);
  });

  it("accepts '\\t' as a separator (terminal renders tab stops)", async () => {
    // '\t' is intentionally allowed so the terminal can align to its
    // configured tab stops. The byte passes through to stdout verbatim;
    // we don't try to interpret or translate it.
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      separators: ["\t"],
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.separators, ["\t"]);
  });

  it("rejects separators with non-\\n/\\t control chars (JSON mistake guard)", async () => {
    // v0.4.0+: '\n' (line break) and '\t' (tab) are allowed as real
    // values. Any other control char ('\\r', NUL, '\\b', '\\f',
    // '\\v', etc.) is almost certainly a JSON mistake and gets
    // dropped. Build the strings via String.fromCharCode so the
    // TypeScript source itself doesn't contain literal control
    // bytes that would be silently consumed by tooling.
    const CR = String.fromCharCode(13);
    const NUL = String.fromCharCode(0);
    const BS = String.fromCharCode(8);
    const FF = String.fromCharCode(12);
    const VT = String.fromCharCode(11);
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      separators: [" ", `Z${CR}CR`, `W${NUL}NUL`, `B${BS}BS`, `F${FF}FF`, `V${VT}VT`],
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.separators, [" "]);
    assert.match(capturedStderr, /separators.*dropped.*invalid entries/);
  });

  it("falls back to defaults when array is empty", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ separators: [] }));
    const cfg = await loadConfig();
    assert.equal(cfg.separators.length, 2);
    assert.match(capturedStderr, /separators/);
  });

  it("rejects non-array separators and falls back to defaults", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ separators: " · " }));
    const cfg = await loadConfig();
    assert.equal(cfg.separators.length, 2);
    assert.match(capturedStderr, /separators/);
  });
});

describe("loadConfig — lineTemplate (top-level)", () => {
  it("defaults reproduce the v0.2.16 layout (plan/balance)", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.deepEqual(cfg.lineTemplate.plan, [
      "m_label", "s_0",
      "m_window5h", "s_0", "m_countdown5h",
      "s_0", "s_1", "s_0",
      "m_window7d", "s_0", "m_countdown7d",
    ]);
    assert.deepEqual(cfg.lineTemplate.balance, ["m_label", "s_0", "m_balance"]);
  });

  it("accepts a custom plan/balance pair of string arrays", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplate: {
        plan: ["m_label", "s_0", "m_window5h"],
        balance: ["m_label", "s_0", "m_balance"],
      },
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.lineTemplate.plan, ["m_label", "s_0", "m_window5h"]);
    assert.deepEqual(cfg.lineTemplate.balance, ["m_label", "s_0", "m_balance"]);
  });

  it("drops non-string entries silently (renderer validates at use time)", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplate: {
        plan: ["m_label", 42, "m_window5h"],
        balance: ["m_label", "s_0", "m_balance"],
      },
    }));
    const cfg = await loadConfig();
    assert.deepEqual(cfg.lineTemplate.plan, ["m_label", "m_window5h"]);
  });

  it("falls back to default when an array is empty", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplate: { plan: [], balance: ["m_label", "s_0", "m_balance"] },
    }));
    const cfg = await loadConfig();
    // plan rejected, default restored.
    assert.equal(cfg.lineTemplate.plan.length, 11);
    assert.match(capturedStderr, /lineTemplate\.plan/);
  });

  it("falls back to defaults when lineTemplate is not an object", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({ lineTemplate: "nope" }));
    const cfg = await loadConfig();
    assert.equal(cfg.lineTemplate.plan.length, 11);
    assert.match(capturedStderr, /lineTemplate/);
  });

  it("preserves untouched sections when one sub-array is bad", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      lineTemplate: {
        plan: "broken", // not an array
        balance: ["m_label", "s_0", "m_balance"],
      },
    }));
    const cfg = await loadConfig();
    // plan fell back to default, balance was applied.
    assert.equal(cfg.lineTemplate.plan.length, 11);
    assert.deepEqual(cfg.lineTemplate.balance, ["m_label", "s_0", "m_balance"]);
    assert.match(capturedStderr, /lineTemplate\.plan/);
  });
});

describe("loadConfig — modeLabels.balance (v0.2.17)", () => {
  it("defaults to 'Balance:'", () => {
    assert.equal(__testing.DEFAULT_CONFIG.modeLabels.balance, "Balance:");
  });

  it("accepts a custom balance label", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      modeLabels: { balance: "Wallet:" },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.modeLabels.balance, "Wallet:");
    // used/remaining keep their defaults.
    assert.equal(cfg.modeLabels.used, "Usage:");
    assert.equal(cfg.modeLabels.remaining, "Remain:");
  });

  it("rejects a non-string balance label and warns", async () => {
    writeFileSync(join(tmpDir, "config.json"), JSON.stringify({
      modeLabels: { balance: 42 },
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.modeLabels.balance, "Balance:");
    assert.match(capturedStderr, /modeLabels\.balance/);
  });
});

describe("configStore.setVersion (v0.2.17)", () => {
  it("mutates cfg().version", () => {
    __resetForTest();
    assert.equal(configStore.get().version, "");
    configStore.setVersion("0.2.17");
    assert.equal(configStore.get().version, "0.2.17");
    __resetForTest();
    // Re-read the singleton — __resetForTest installs a fresh object.
    assert.equal(configStore.get().version, "");
  });
});

// ----- providers (v0.2.21) -----
//
// The providers block is a Record<string, ProviderEntry>. The defaults
// reproduce v0.2.20's hardcoded behavior; user config deep-merges on
// top. A partial user entry inherits the missing fields from the
// default; an invalid field on an otherwise-OK entry drops the whole
// entry (no partial-apply — a half-configured provider could fetch
// from the wrong endpoint).
describe("loadConfig — providers (defaults)", () => {
  it("reproduces the v0.2.20 hardcoded values", () => {
    const cfg = __testing.DEFAULT_CONFIG;
    assert.equal(cfg.providers.minimax.TYPE, "TOKEN_PLAN");
    assert.equal(cfg.providers.minimax.BASE_URL_COMPARED_TO,
      "https://api.minimaxi.com/anthropic");
    assert.equal(cfg.providers.minimax.COMPARE_METHOD, "EXACT");
    assert.equal(cfg.providers.minimax.ENDPOINT,
      "https://www.minimaxi.com/v1/token_plan/remains");
    assert.equal(cfg.providers.deepseek.TYPE, "BALANCE");
    assert.equal(cfg.providers.deepseek.BASE_URL_COMPARED_TO,
      "https://api.deepseek.com/anthropic");
    assert.equal(cfg.providers.deepseek.COMPARE_METHOD, "EXACT");
    assert.equal(cfg.providers.deepseek.ENDPOINT,
      "https://api.deepseek.com/user/balance");
  });

  it("is included in the merged config when the user has no providers key", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ cacheTtlMs: 30_000 }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.providers, __testing.DEFAULT_CONFIG.providers);
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — providers (full override)", () => {
  it("replaces a provider's fields when the user provides the full entry", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "https://staging.minimaxi.com/anthropic",
            COMPARE_METHOD: "INCLUDE",
            ENDPOINT: "https://staging.minimaxi.com/v1/token_plan/remains",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax.BASE_URL_COMPARED_TO,
      "https://staging.minimaxi.com/anthropic");
    assert.equal(cfg.providers.minimax.COMPARE_METHOD, "INCLUDE");
    // deepseek entry stays at its default (deep-merge, not replace).
    assert.equal(cfg.providers.deepseek.BASE_URL_COMPARED_TO,
      "https://api.deepseek.com/anthropic");
  });
});

describe("loadConfig — providers (partial override)", () => {
  it("fills missing fields from the default when the user provides only one", async () => {
    // The user just wants to swap the ENDPOINT — they shouldn't have
    // to restate TYPE / BASE_URL_COMPARED_TO / COMPARE_METHOD.
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            ENDPOINT: "https://internal.proxy.example/token_plan/remains",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax.TYPE, "TOKEN_PLAN");
    assert.equal(cfg.providers.minimax.BASE_URL_COMPARED_TO,
      "https://api.minimaxi.com/anthropic");
    assert.equal(cfg.providers.minimax.COMPARE_METHOD, "EXACT");
    assert.equal(cfg.providers.minimax.ENDPOINT,
      "https://internal.proxy.example/token_plan/remains");
    // No stderr noise — partial override is the documented happy path.
    assert.equal(capturedStderr, "");
  });

  it("merges each provided field independently (e.g. just COMPARE_METHOD)", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          deepseek: { COMPARE_METHOD: "STARTWITH" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.deepseek.COMPARE_METHOD, "STARTWITH");
    assert.equal(cfg.providers.deepseek.TYPE, "BALANCE");
    assert.equal(cfg.providers.deepseek.ENDPOINT,
      "https://api.deepseek.com/user/balance");
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — providers (new key)", () => {
  it("appends a user-defined provider not in DEFAULT_PROVIDERS", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          moonshot: {
            TYPE: "BALANCE",
            BASE_URL_COMPARED_TO: "https://api.moonshot.cn/anthropic",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://api.moonshot.cn/v1/users/me/balance",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.moonshot);
    assert.equal(cfg.providers.moonshot.ENDPOINT,
      "https://api.moonshot.cn/v1/users/me/balance");
    // Existing defaults still present.
    assert.ok(cfg.providers.minimax);
    assert.ok(cfg.providers.deepseek);
    assert.equal(capturedStderr, "");
  });
});

describe("loadConfig — providers (validation)", () => {
  it("drops an entry with an invalid TYPE and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "WHATEVER", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT", ENDPOINT: "https://x.example/foo" },
        },
      }),
    );
    const cfg = await loadConfig();
    // The malformed minimax entry is dropped; deepseek is preserved.
    assert.equal(cfg.providers.minimax, undefined);
    assert.ok(cfg.providers.deepseek);
    assert.match(capturedStderr, /provider TYPE/);
  });

  it("drops an entry with an empty BASE_URL_COMPARED_TO and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "TOKEN_PLAN", BASE_URL_COMPARED_TO: "",
            COMPARE_METHOD: "EXACT", ENDPOINT: "https://x.example/foo" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /BASE_URL_COMPARED_TO/);
  });

  it("drops an entry with an out-of-enum COMPARE_METHOD and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "TOKEN_PLAN", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "REGEX", ENDPOINT: "https://x.example/foo" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /COMPARE_METHOD/);
  });

  it("drops an entry with a non-http(s) ENDPOINT and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "TOKEN_PLAN", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT", ENDPOINT: "file:///etc/passwd" },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /ENDPOINT/);
  });

  it("drops a non-object provider entry and warns", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ providers: { minimax: "not-an-object" } }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /provider entry must be an object/);
  });

  it("falls back to all defaults when the providers block is not an object", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({ providers: "nope" }),
    );
    const cfg = await loadConfig();
    assert.deepEqual(cfg.providers, __testing.DEFAULT_CONFIG.providers);
    assert.match(capturedStderr, /providers must be an object/);
  });

  it("isolates a bad entry: deepseek stays valid even if minimax is malformed", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: { TYPE: "BOGUS", BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT", ENDPOINT: "https://x.example/foo" },
          // deepseek: untouched → defaults apply.
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.deepEqual(cfg.providers.deepseek,
      __testing.DEFAULT_CONFIG.providers.deepseek);
  });
});

describe("applyProviderOverrides — three-layer precedence", () => {
  // v0.4.0+ — `providerEntry.config` lets a user override ANY top-level
  // config key for one specific provider. Three-layer precedence:
  //   defaults  ⊕  config.json top-level  ⊕  providerEntry.config
  //             (lowest)                  (highest)
  // Tests below use __resetForTest to set a known baseline (the
  // "user-level config" layer), then call applyProviderOverrides to
  // simulate index.ts:main() merging the provider layer on top.

  it("provider.config overrides a top-level field (cacheTtlMs)", () => {
    __resetForTest({ cacheTtlMs: 30_000 });
    assert.equal(configStore.get().cacheTtlMs, 30_000);
    applyProviderOverrides({ cacheTtlMs: 5_000 });
    assert.equal(configStore.get().cacheTtlMs, 5_000, "provider override wins");
  });

  it("provider.config preserves fields it does NOT override", () => {
    __resetForTest({
      cacheTtlMs: 30_000,
      display: "remaining",
      timeFormat: { minUnit: "s", maxUnitCount: 4 },
    });
    applyProviderOverrides({ fetchTimeoutMs: 9_000 });
    const cfg = configStore.get();
    // Overridden → new value
    assert.equal(cfg.fetchTimeoutMs, 9_000);
    // Untouched → user-level value preserved
    assert.equal(cfg.cacheTtlMs, 30_000);
    assert.equal(cfg.display, "remaining");
    assert.equal(cfg.timeFormat.minUnit, "s");
    assert.equal(cfg.timeFormat.maxUnitCount, 4);
  });

  it("provider.config can override nested object fields (colors)", () => {
    __resetForTest();
    applyProviderOverrides({
      colors: { red: "\x1b[38;5;201m" },
    });
    const cfg = configStore.get();
    // Overridden → new value
    assert.equal(cfg.colors.red, "\x1b[38;5;201m");
    // Untouched → default preserved
    assert.equal(cfg.colors.brightGreen, DEFAULT_CONFIG.colors.brightGreen);
  });

  it("provider.config can override lineTemplate (full array)", () => {
    __resetForTest();
    applyProviderOverrides({
      lineTemplate: {
        plan: ["m_label", "s_0", "m_window5h"],
        balance: ["m_label", "s_0", "m_balance"],
      },
    });
    const cfg = configStore.get();
    assert.deepEqual(cfg.lineTemplate.plan, ["m_label", "s_0", "m_window5h"]);
    // Other fields untouched.
    assert.equal(cfg.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs);
  });

  it("rejects a nested 'providers' key and warns", () => {
    __resetForTest();
    // Capture baseline before the bad override.
    const before = JSON.stringify(configStore.get().colors);
    applyProviderOverrides({
      providers: { evil: {} }, // should be stripped with a warn
    });
    const after = JSON.stringify(configStore.get().colors);
    assert.equal(after, before, "providers key must not affect the snapshot");
    assert.match(capturedStderr, /must not contain a nested 'providers'/);
  });

  it("invalid field values fall back to the prior layer (not defaults)", () => {
    __resetForTest({ cacheTtlMs: 30_000 });
    applyProviderOverrides({ cacheTtlMs: -1 }); // invalid: not positive
    // After provider-config rejects -1, the active value should be the
    // user-level 30_000 (the layer beneath provider-config), NOT the
    // hardcoded default of 60_000. Three-layer semantics: each layer
    // falls back to the layer below it, not to the bottom.
    assert.equal(configStore.get().cacheTtlMs, 30_000);
    assert.match(capturedStderr, /cacheTtlMs must be a positive number/);
  });

  it("empty provider.config is a no-op", () => {
    __resetForTest({ cacheTtlMs: 42_000 });
    applyProviderOverrides({});
    assert.equal(configStore.get().cacheTtlMs, 42_000);
  });

  it("stale-on-error: bad provider.config field leaves other fields intact", () => {
    __resetForTest({
      cacheTtlMs: 30_000,
      fetchTimeoutMs: 9_000,
    });
    applyProviderOverrides({
      // Valid override on one field…
      timeFormat: { minUnit: "s" },
      // …alongside an invalid override on another field (bad value).
      cacheTtlMs: -1, // invalid: not positive
    });
    const cfg = configStore.get();
    // timeFormat.minUnit: provider override wins.
    assert.equal(cfg.timeFormat.minUnit, "s");
    // cacheTtlMs: bad value rejected → falls back to the user-level
    // value (30_000), not the hardcoded default.
    assert.equal(cfg.cacheTtlMs, 30_000);
    // fetchTimeoutMs: untouched → user-level value preserved.
    assert.equal(cfg.fetchTimeoutMs, 9_000);
    assert.match(capturedStderr, /cacheTtlMs must be a positive number/);
  });
});

describe("validateProviderEntry — config block (v0.4.0+)", () => {
  // The shape validator (called by mergeConfig during config.json load)
  // ensures the `config` key is a plain object and rejects a nested
  // `providers` key. Per-field validation happens later, when
  // applyProviderOverrides runs the merged view through the same
  // validators as the top-level config.

  it("drops a provider entry whose config is not an object", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: "not-an-object",
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /provider\.config must be an object/);
  });

  it("drops a provider entry whose config contains a nested 'providers' key", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: { providers: { evil: {} } },
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.equal(cfg.providers.minimax, undefined);
    assert.match(capturedStderr, /must not contain a nested 'providers'/);
  });

  it("accepts a provider entry with an empty config block", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: {},
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.minimax);
    assert.deepEqual(cfg.providers.minimax.config, {});
  });

  it("forwards a valid config block onto the validated entry", async () => {
    writeFileSync(
      join(tmpDir, "config.json"),
      JSON.stringify({
        providers: {
          minimax: {
            TYPE: "TOKEN_PLAN",
            BASE_URL_COMPARED_TO: "x",
            COMPARE_METHOD: "EXACT",
            ENDPOINT: "https://x.example/foo",
            config: { cacheTtlMs: 5_000, fetchTimeoutMs: 3_000 },
          },
        },
      }),
    );
    const cfg = await loadConfig();
    assert.ok(cfg.providers.minimax);
    assert.deepEqual(cfg.providers.minimax.config, {
      cacheTtlMs: 5_000,
      fetchTimeoutMs: 3_000,
    });
  });
});
