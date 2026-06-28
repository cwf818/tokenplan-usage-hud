// v0.2.17: tests for the lineTemplate / module renderer. These cover
// the new custom-config surface (separators, lineTemplate) and the
// forced-visibility rule for m_age. Existing render.test.ts and
// dispatch.test.ts already verify the default templates reproduce
// the v0.2.16 byte-for-byte output; this file focuses on the new
// behavior that the old tests don't reach.
//
// v0.3.3: added the "inline-args tokens" describe block covering the
// `m_label:<string>[:color:<c>]`, `m_modeLabel[:color:<c>]`, and
// `s_<n>[:color:<c>]` token forms.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderProviderLine,
  __resetUnknownModuleWarnForTest,
} from "./render.ts";
import { __resetForTest } from "./config.ts";
import { compose } from "./composition.ts";

const STALE_COLOR = "\x1b[90m";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("lineTemplate — custom template (drop the 7d window)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_modeLabel", "s_0", "m_window5h", "s_0", "m_countdown5h"],
        balance: ["m_modeLabel", "s_0", "m_balance"],
      },
    });
  });
  afterEach(() => __resetForTest());

  it("renders only the modules listed in the template", () => {
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: { pct: 60, resetAt: null },
      ageMs: null,
      stale: false,
      version: "",
    });
    // 5h data present, 7d dropped → only one "5h" label, no "7d".
    assert.ok(strip(line).includes("5h"), `got: ${line}`);
    assert.ok(!strip(line).includes("7d"), `got: ${line}`);
  });
});

describe("lineTemplate — custom separators", () => {
  it("swaps the inter-window separator to ' / '", () => {
    __resetForTest({
      separators: [" ", " / "],
      lineTemplate: {
        plan: [
          "m_modeLabel", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "s_1", "s_0",
          "m_window7d", "s_0", "m_countdown7d",
        ],
        balance: ["m_modeLabel", "s_0", "m_balance"],
      },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: { pct: 60, resetAt: null },
        ageMs: null,
        stale: false,
        version: "",
      });
      assert.ok(strip(line).includes(" / "), `got: ${line}`);
      assert.ok(!strip(line).includes(" · "), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });
});

describe("lineTemplate — unknown module token", () => {
  it("expands unknown m_ tokens to '' and warns once on stderr", () => {
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      lineTemplate: {
        plan: ["m_modeLabel", "s_0", "m_window5h", "s_0", "m_foo"],
        balance: ["m_modeLabel", "s_0", "m_balance"],
      },
    });
    // Capture stderr.
    const err = process.stderr as unknown as { write: (c: string) => boolean };
    const original = err.write;
    const captured: string[] = [];
    err.write = (c: string) => {
      captured.push(c);
      return true;
    };
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: null,
        ageMs: null,
        stale: false,
        version: "",
      });
      // m_foo expanded to "" — no junk in the line.
      assert.ok(!line.includes("m_foo"));
      // Warn fired exactly once for this run.
      const warns = captured.filter((c) => c.includes("unknown lineTemplate module"));
      assert.equal(warns.length, 1, `expected 1 warn, got ${warns.length}: ${JSON.stringify(captured)}`);
      assert.ok(warns[0].includes("m_foo"));
    } finally {
      err.write = original;
      __resetForTest();
    }
  });
});

describe("lineTemplate — forced visibility of m_age on stale", () => {
  it("appends the broken-chain suffix even when m_age is NOT in the template", () => {
    // Default plan template does NOT include m_age.
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: { pct: 60, resetAt: null },
      ageMs: 5 * 60_000,
      stale: true,
      version: "",
    });
    assert.ok(strip(line).endsWith("⛓️‍💥 5m ago"), `got: ${line}`);
  });

  it("appends the broken-chain suffix when a separator happens to contain ' ago'", () => {
    // v0.4.0 dedup is template-level (template.includes('m_age')),
    // NOT output-scanning. A separator string containing ' ago'
    // must NOT cause the forced fallback to skip — the dedup check
    // would have misfired under the old 'joined.includes(" ago")'
    // heuristic. Confirms the refactor.
    __resetForTest({
      separators: [" ago"],
      lineTemplate: {
        plan: [
          "m_modeLabel", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "s_1", "s_0",
          "m_window7d", "s_0", "m_countdown7d",
        ],
        balance: ["m_modeLabel", "s_0", "m_balance"],
      },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: { pct: 60, resetAt: null },
        ageMs: 5 * 60_000,
        stale: true,
        version: "",
      });
      // Forced fallback must still fire — exactly one ⛓️‍💥 5m ago
      // suffix appended to the rendered output.
      const stripped = strip(line);
      const occurrences = (stripped.match(/⛓️‍💥 5m ago/g) ?? []).length;
      assert.equal(occurrences, 1, `expected 1, got ${occurrences}: ${stripped}`);
    } finally {
      __resetForTest();
    }
  });

  it("does NOT double-append when m_age IS in the template", () => {
    __resetForTest({
      lineTemplate: {
        plan: [
          "m_modeLabel", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "s_1", "s_0",
          "m_window7d", "s_0", "m_countdown7d",
          "s_0", "m_age",
        ],
        balance: ["m_modeLabel", "s_0", "m_balance", "s_0", "m_age"],
      },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: { pct: 60, resetAt: null },
        ageMs: 5 * 60_000,
        stale: true,
        version: "",
      });
      const stripped = strip(line);
      const occurrences = (stripped.match(/⛓️‍💥 5m ago/g) ?? []).length;
      assert.equal(occurrences, 1, `expected 1 occurrence, got ${occurrences}: ${stripped}`);
    } finally {
      __resetForTest();
    }
  });

  it("does NOT render the stale suffix on a fresh tick (ageMs=0)", () => {
    const line = renderProviderLine("minimax", {
      mode: "used",
      nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: { pct: 60, resetAt: null },
      ageMs: 0,
      stale: false,
      version: "",
    });
    assert.ok(!line.includes(STALE_COLOR));
    assert.ok(!line.includes("ago"));
  });

  it("uses healthy emoji when stale=false and ageMs > 0 (m_age is in template)", () => {
    // v0.4.0 priority: template presence wins. When m_age is listed
    // in the lineTemplate, the module emits unconditionally. Fresh +
    // ageMs > 0 → 🔗 X ago.
    __resetForTest({
      lineTemplate: {
        plan: [
          "m_modeLabel", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "m_age",
        ],
        balance: ["m_modeLabel", "s_0", "m_balance", "s_0", "m_age"],
      },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: { pct: 60, resetAt: null },
        ageMs: 30_000,
        stale: false,
        version: "",
      });
      assert.ok(strip(line).includes("🔗 <1m ago"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });
});

describe("lineTemplate — m_version module", () => {
  it("renders 'v' + ctx.version when m_version is in the template", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_modeLabel", "s_0", "m_window5h", "s_0", "m_version"],
        balance: ["m_modeLabel", "s_0", "m_balance", "s_0", "m_version"],
      },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: { pct: 60, resetAt: null },
        ageMs: null,
        stale: false,
        version: "0.2.17",
      });
      assert.ok(line.includes("v0.2.17"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });

  it("renders nothing when version is empty (m_version module returns null)", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_modeLabel", "s_0", "m_window5h", "s_0", "m_version"],
        balance: ["m_modeLabel", "s_0", "m_balance", "s_0", "m_version"],
      },
    });
    try {
      const line = renderProviderLine("minimax", {
        mode: "used",
        nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: { pct: 60, resetAt: null },
        ageMs: null,
        stale: false,
        version: "",
      });
      // No stray "v" prefix.
      assert.ok(!line.includes("v0"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });
});

describe("lineTemplate — m_modeLabel picks modeLabels.balance for the deepseek path", () => {
  it("uses 'Balance:' by default (preserves v0.2.16 label)", () => {
    const line = renderProviderLine("deepseek", {
      mode: "used",
      nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null,
      stale: false,
      version: "",
    });
    assert.ok(strip(line).startsWith("Balance: $25"), `got: ${line}`);
  });

  it("uses the configured modeLabels.balance override", () => {
    __resetForTest({ modeLabels: { used: "Usage:", remaining: "Remain:", balance: "Wallet:" } });
    try {
      const line = renderProviderLine("deepseek", {
        mode: "used",
        nowMs: Date.now(),
        balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
        ageMs: null,
        stale: false,
        version: "",
      });
      assert.ok(strip(line).startsWith("Wallet: $25"), `got: ${line}`);
    } finally {
      __resetForTest();
    }
  });
});

// ----- v0.3.3+ inline-args tokens -----
//
// Helper: capture stderr during a render so we can assert the
// one-shot warn fired (or didn't). Restored in finally.
function withCapturedStderr<T>(fn: () => T): { value: T; warns: string[] } {
  const err = process.stderr as unknown as { write: (c: string) => boolean };
  const original = err.write;
  const captured: string[] = [];
  err.write = (c: string) => {
    captured.push(c);
    return true;
  };
  try {
    return { value: fn(), warns: captured };
  } finally {
    err.write = original;
  }
}

describe("lineTemplate — m_label inline-args tokens", () => {
  beforeEach(() => {
    __resetUnknownModuleWarnForTest();
    __resetForTest({
      lineTemplate: {
        plan: ["m_label:hello"],
        balance: ["m_label:hello"],
      },
    });
  });
  afterEach(() => __resetForTest());

  it("m_label:hello renders plain 'hello'", () => {
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(strip(line), "hello", `got: ${line}`);
  });

  it("m_label:hello:color:red wraps the chunk in red SGR + RESET", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:hello:color:red"], balance: ["m_label:hello:color:red"] },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196mhello\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label:hello:color:brightBlack resolves to \\x1b[90m", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:hi:color:brightBlack"], balance: ["m_label:hi:color:brightBlack"] },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[90mhi\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label accepts a raw SGR string for color", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:x:color:\x1b[36m"], balance: ["m_label:x:color:\x1b[36m"] },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[36mx\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_label:hello:color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:hello:color:garbage"], balance: ["m_label:hello:color:garbage"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    // Per spec: any failed parse is a noop. Invalid color → drop + warn.
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label::color:red (empty string) drops and warns", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label::color:red"], balance: ["m_label::color:red"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label:hello:color (odd arg count) drops and warns", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:hello:color"], balance: ["m_label:hello:color"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label:hello:unknown:foo (unknown param) drops and warns", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:hello:unknown:foo"], balance: ["m_label:hello:unknown:foo"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_label:hello:color:red:extra:stuff (odd total) drops and warns", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_label:hello:color:red:extra:stuff"],
        balance: ["m_label:hello:color:red:extra:stuff"],
      },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

describe("lineTemplate — s_<n>:color inline-args tokens", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("s_0:color:red wraps the separator in red SGR + RESET", () => {
    __resetForTest({
      separators: [" "],
      lineTemplate: { plan: ["s_0:color:red"], balance: ["s_0:color:red"] },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196m \x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("s_0:color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      separators: [" "],
      lineTemplate: { plan: ["s_0:color:garbage"], balance: ["s_0:color:garbage"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    // Per spec: invalid color → drop + warn.
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("s_999:color:red (out-of-range index) drops and warns", () => {
    __resetForTest({
      separators: [" "],
      lineTemplate: { plan: ["s_999:color:red"], balance: ["s_999:color:red"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("s_abc:color:red (non-numeric index) drops and warns", () => {
    __resetForTest({
      separators: [" "],
      lineTemplate: { plan: ["s_abc:color:red"], balance: ["s_abc:color:red"] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("s_0:color:red:extra:stuff (odd total) drops and warns", () => {
    __resetForTest({
      separators: [" "],
      lineTemplate: {
        plan: ["s_0:color:red:extra:stuff"],
        balance: ["s_0:color:red:extra:stuff"],
      },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("s_ (just the prefix, no params) resolves to seps[0]", () => {
    __resetForTest({
      separators: ["X", "YY"],
      lineTemplate: { plan: ["s_"], balance: ["s_"] },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "X", `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — m_modeLabel:color inline-args tokens", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_modeLabel:color:red on a plan template wraps the Usage: prefix in red", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_modeLabel:color:red"], balance: [] },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196mUsage:\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel:color:red on a deepseek balance template wraps Balance: in red", () => {
    __resetForTest({
      lineTemplate: { plan: [], balance: ["m_modeLabel:color:red"] },
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    // Compare WITHOUT stripping ANSI — we want the SGR wrapper intact.
    assert.ok(line.startsWith("\x1b[38;5;196mBalance:\x1b[0m"), `got: ${JSON.stringify(line)}`);
  });

  it("m_modeLabel:color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_modeLabel:color:garbage"], balance: [] },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    // Per spec: invalid color → drop + warn.
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

// v0.3.3+ — every existing module accepts an optional `:color:<c>`
// override. These tests cover both:
//   - plain-text modules (m_version, m_tokenIn, …) — the override
//     wraps the bare body in `<c>body<RESET>`.
//   - already-colored modules (m_window5h/7d, m_balance, m_age,
//     m_cacheHitRate, m_cacheRead, m_tokenInSpeed, m_tokenOutSpeed) —
//     the override REPLACES the natural color (user always wins).
//   - invalid :color: → hard noop (drop + warn), same as m_label.
//   - bare `<module>` form is byte-for-byte identical to pre-v0.3.3.
describe("lineTemplate — m_window5h / m_window7d :color override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_window5h:color:red replaces the band-based color with red", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_window5h:color:red"],
        balance: ["m_window5h:color:red"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // The override color (\x1b[38;5;196m) must appear inside the chunk,
    // and the percentage must use the override color (NOT the band color).
    assert.ok(line.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_window7d:color:darkGreen replaces the band-based color with darkGreen", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_window7d:color:darkGreen"],
        balance: ["m_window7d:color:darkGreen"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null,
      weekly: { pct: 60, resetAt: null },
      balance: null,
      ageMs: null, stale: false, version: "",
    });
    // darkGreen = \x1b[38;5;29m (default palette); must wrap 60%.
    assert.ok(line.includes("\x1b[38;5;29m60%"), `got: ${JSON.stringify(line)}`);
  });

  it("bare m_window5h is byte-for-byte unchanged when no :color: is supplied", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_window5h"],
        balance: ["m_window5h"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // Default band color for 38% used is darkGreen (\x1b[38;5;29m).
    // If the override path were mis-wired, we'd see no SGR or red instead.
    assert.ok(line.includes("\x1b[38;5;29m38%"), `got: ${JSON.stringify(line)}`);
  });

  it("m_window5h:color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_window5h:color:garbage"],
        balance: ["m_window5h:color:garbage"],
      },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: { pct: 38, resetAt: null },
        weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

describe("lineTemplate — plain-text modules :color override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_version:color:yellow wraps v0.2.17 in yellow SGR + RESET", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_version:color:yellow"],
        balance: ["m_version:color:yellow"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "0.2.17",
    });
    // Yellow = \x1b[38;5;220m (default palette).
    assert.equal(line, "\x1b[38;5;220mv0.2.17\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_version without :color: stays plain text (byte-for-byte identical)", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_version"],
        balance: ["m_version"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "0.2.17",
    });
    // Bare path: no SGR wrapper.
    assert.equal(line, "v0.2.17", `got: ${JSON.stringify(line)}`);
  });

  it("m_version:color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_version:color:garbage"],
        balance: ["m_version:color:garbage"],
      },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "0.2.17",
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });

  it("m_countdown5h:color:darkGreen wraps the bare '5h' suffix in darkGreen", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_countdown5h:color:darkGreen"],
        balance: ["m_countdown5h:color:darkGreen"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    // No resetAt → formatOneResetSuffix emits just "5h", wrapped in darkGreen.
    assert.equal(line, "\x1b[38;5;29m5h\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_countdown7d:color:red wraps the bare '7d' suffix in red", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_countdown7d:color:red"],
        balance: ["m_countdown7d:color:red"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null,
      weekly: { pct: 60, resetAt: null },
      balance: null,
      ageMs: null, stale: false, version: "",
    });
    assert.equal(line, "\x1b[38;5;196m7d\x1b[0m", `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — colored modules :color override (user wins)", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_balance:color:red replaces the band-based color with red", () => {
    __resetForTest({
      lineTemplate: {
        plan: [],
        balance: ["m_balance:color:red"],
      },
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    // Band color for $25 was brightGreen; override forces red.
    assert.ok(line.includes("\x1b[38;5;196m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m$25"), `got: ${JSON.stringify(line)}`);
  });

  it("bare m_balance keeps the band-based color", () => {
    __resetForTest({
      lineTemplate: {
        plan: [],
        balance: ["m_balance"],
      },
    });
    const line = renderProviderLine("deepseek", {
      mode: "used", nowMs: Date.now(),
      balance: { isAvailable: true, entries: [{ currency: "USD", totalBalance: 25 }], minValue: 25 },
      ageMs: null, stale: false, version: "",
    });
    // Band color for $25 with default thresholds is darkGreen (\x1b[38;5;29m),
    // since 25 falls into the [20, 50) band.
    assert.ok(line.includes("\x1b[38;5;29m$25"), `got: ${JSON.stringify(line)}`);
  });

  it("m_age:color:red replaces STALE_COLOR with red", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_age:color:red"],
        balance: ["m_age:color:red"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: 5 * 60_000,
      stale: true,
      version: "",
    });
    // STALE_COLOR (\x1b[90m) must NOT appear; red (\x1b[38;5;196m) must.
    assert.ok(!line.includes("\x1b[90m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196m⛓️‍💥 5m ago"), `got: ${JSON.stringify(line)}`);
  });

  it("bare m_age keeps STALE_COLOR", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_age"],
        balance: ["m_age"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: 5 * 60_000,
      stale: true,
      version: "",
    });
    assert.ok(line.includes("\x1b[90m⛓️‍💥 5m ago"), `got: ${JSON.stringify(line)}`);
  });

  it("m_cacheRead:color:yellow replaces STALE_COLOR with yellow", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_cacheRead:color:yellow"],
        balance: ["m_cacheRead:color:yellow"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-cache-read",
        totals: { input: 1000, output: 500 },
        current: { input: 100, output: 50, cacheCreation: 100, cacheRead: 900 },
        cost: { totalDurationMs: 1000 },
      },
    });
    // Yellow wraps the cache: chunk; STALE_COLOR must not appear.
    assert.ok(line.includes("\x1b[38;5;220m"), `got: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\x1b[90m"), `got: ${JSON.stringify(line)}`);
  });

  it("m_tokenInSpeed:color:red replaces STALE_COLOR with red", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_tokenInSpeed:color:red"],
        balance: ["m_tokenInSpeed:color:red"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-speed",
        totals: { input: 5000, output: 0 },
        current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        cost: { totalDurationMs: 5000 },
      },
    });
    // STALE_COLOR must not appear; red must wrap the speed chunk.
    assert.ok(!line.includes("\x1b[90m"), `got: ${JSON.stringify(line)}`);
    assert.ok(line.includes("\x1b[38;5;196min:"), `got: ${JSON.stringify(line)}`);
  });

  it("m_cacheHitRate:color:brightGreen replaces the band-based cache color with brightGreen", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_cacheHitRate:color:brightGreen"],
        balance: ["m_cacheHitRate:color:brightGreen"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-hit",
        totals: { input: 0, output: 0 },
        current: { input: 0, output: 0, cacheCreation: 100, cacheRead: 900 },
        cost: { totalDurationMs: 1000 },
      },
    });
    // Hit rate = 90% (read 900 / (900+100)). Default band color is "good"
    // (\x1b[38;5;41m brightGreen). Override forces the same color (since
    // 90% is already in the "good" band) — the assertion verifies the
    // SGR wraps "cache:90%" with brightGreen.
    assert.ok(line.includes("\x1b[38;5;41mcache:90.0%"), `got: ${JSON.stringify(line)}`);
  });
});

describe("lineTemplate — plain token-usage modules :color override", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("m_tokenIn:color:brightGreen wraps the 'in:N' chunk in brightGreen", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_tokenIn:color:brightGreen"],
        balance: ["m_tokenIn:color:brightGreen"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-tok-in",
        totals: { input: 1500, output: 0 },
        current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        cost: { totalDurationMs: 0 },
      },
    });
    assert.equal(line, "\x1b[38;5;41min:1.5k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("bare m_tokenIn stays plain (byte-for-byte identical)", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_tokenIn"],
        balance: ["m_tokenIn"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-tok-in-bare",
        totals: { input: 1500, output: 0 },
        current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
        cost: { totalDurationMs: 0 },
      },
    });
    assert.equal(line, "in:1.5k", `got: ${JSON.stringify(line)}`);
  });

  it("m_ctx:color:orange wraps the 'ctx:N' chunk in orange", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_ctx:color:orange"],
        balance: ["m_ctx:color:orange"],
      },
    });
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
      tokens: {
        cwd: "C:\\fake",
        sessionId: "sess-ctx",
        totals: { input: 0, output: 0 },
        current: { input: 800, output: 0, cacheCreation: 0, cacheRead: 200 },
        cost: { totalDurationMs: 0 },
      },
    });
    // Total ctx length = 800 + 0 + 200 = 1000 → "ctx:1.0k". Orange = \x1b[38;5;208m.
    assert.equal(line, "\x1b[38;5;208mctx:1.0k\x1b[0m", `got: ${JSON.stringify(line)}`);
  });

  it("m_tokenIn:color:garbage is a hard noop (drops and warns)", () => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_tokenIn:color:garbage"],
        balance: ["m_tokenIn:color:garbage"],
      },
    });
    const { value: line, warns } = withCapturedStderr(() =>
      renderProviderLine("minimax", {
        mode: "used", nowMs: Date.now(),
        fiveHour: null, weekly: null, balance: null,
        ageMs: null, stale: false, version: "",
        tokens: {
          cwd: "C:\\fake",
          sessionId: "sess-tok-in-bad",
          totals: { input: 1500, output: 0 },
          current: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
          cost: { totalDurationMs: 0 },
        },
      }),
    );
    assert.equal(line, "", `got: ${JSON.stringify(line)}`);
    assert.equal(warns.filter((w) => w.includes("unknown lineTemplate module")).length, 1);
  });
});

describe("lineTemplate — inline-args regression / round-trip", () => {
  beforeEach(() => __resetUnknownModuleWarnForTest());
  afterEach(() => __resetForTest());

  it("default template (bare m_modeLabel) still renders byte-for-byte equal to pre-v0.3.3", () => {
    // No __resetForTest — uses the stock default template.
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: { pct: 38, resetAt: null },
      weekly: { pct: 60, resetAt: null },
      ageMs: null, stale: false, version: "",
    });
    // Default template renders "Usage: ▓▓▓░░░░░ 38% 5h · ▓▓▓▓▓▓░░░ 60% 7d".
    // Strip ANSI to make the assertion stable.
    assert.match(strip(line), /^Usage: ▓+░+ 38% 5h · ▓+░+ 60% 7d$/);
  });

  it("compose() round-trip preserves an inline-colored chunk without bleeding upstream", () => {
    __resetForTest({
      lineTemplate: { plan: ["m_label:foo:color:red"], balance: [] },
    });
    // Upstream with its own unclosed red SGR — common case when the
    // upstream statusline forgot to close its color.
    const upstream = "upstream-line \x1b[31m";
    const line = renderProviderLine("minimax", {
      mode: "used", nowMs: Date.now(),
      fiveHour: null, weekly: null, balance: null,
      ageMs: null, stale: false, version: "",
    });
    const composed = compose(upstream, line);
    // Strip ANSI to compare structurally. We expect:
    //   - upstream content preserved
    //   - upstream's unclosed SGR reset before the plan line
    //   - plan line contains "foo" wrapped in red
    assert.ok(composed.includes("upstream-line"));
    assert.ok(strip(composed).includes("foo"));
    // The plan line is closed by \x1b[0m (own RESET) so it should not
    // bleed into anything else.
    assert.ok(composed.includes("\x1b[38;5;196mfoo\x1b[0m"));
  });
});
