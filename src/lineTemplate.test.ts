// v0.2.17: tests for the lineTemplate / module renderer. These cover
// the new custom-config surface (separators, lineTemplate) and the
// forced-visibility rule for m_age. Existing render.test.ts and
// dispatch.test.ts already verify the default templates reproduce
// the v0.2.16 byte-for-byte output; this file focuses on the new
// behavior that the old tests don't reach.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderProviderLine,
  __resetUnknownModuleWarnForTest,
} from "./render.ts";
import { __resetForTest } from "./config.ts";

const STALE_COLOR = "\x1b[90m";
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("lineTemplate — custom template (drop the 7d window)", () => {
  beforeEach(() => {
    __resetForTest({
      lineTemplate: {
        plan: ["m_label", "s_0", "m_window5h", "s_0", "m_countdown5h"],
        balance: ["m_label", "s_0", "m_balance"],
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
          "m_label", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "s_1", "s_0",
          "m_window7d", "s_0", "m_countdown7d",
        ],
        balance: ["m_label", "s_0", "m_balance"],
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
        plan: ["m_label", "s_0", "m_window5h", "s_0", "m_foo"],
        balance: ["m_label", "s_0", "m_balance"],
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
          "m_label", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "s_1", "s_0",
          "m_window7d", "s_0", "m_countdown7d",
        ],
        balance: ["m_label", "s_0", "m_balance"],
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
          "m_label", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "s_1", "s_0",
          "m_window7d", "s_0", "m_countdown7d",
          "s_0", "m_age",
        ],
        balance: ["m_label", "s_0", "m_balance", "s_0", "m_age"],
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
          "m_label", "s_0",
          "m_window5h", "s_0", "m_countdown5h",
          "s_0", "m_age",
        ],
        balance: ["m_label", "s_0", "m_balance", "s_0", "m_age"],
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
        plan: ["m_label", "s_0", "m_window5h", "s_0", "m_version"],
        balance: ["m_label", "s_0", "m_balance", "s_0", "m_version"],
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
        plan: ["m_label", "s_0", "m_window5h", "s_0", "m_version"],
        balance: ["m_label", "s_0", "m_balance", "s_0", "m_version"],
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

describe("lineTemplate — m_label picks modeLabels.balance for the deepseek path", () => {
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
