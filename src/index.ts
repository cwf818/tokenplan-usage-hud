// Entry point. Runs as the Claude Code statusline child process:
//   - Reads the session JSON from stdin (we don't use it; we drain it so the
//     child doesn't block on the parent).
//   - Gates on ANTHROPIC_BASE_URL via the providers config block
//     (src/providers.ts): only when pointing at a configured provider
//     does it fetch and render a line. Otherwise the line is hidden and
//     upstream output passes through.
//   - Composes with upstream claude-hud output (passed via TOKENPLAN_UPSTREAM
//     by the bash wrapper in scripts/wrapper.sh).
//   - Loads ~/.claude/plugins/tokenplan-usage-hud/config.json once at
//     startup; every tunable (cache TTL, fetch timeout, colors, display
//     mode, …) reads from there via the configStore singleton.
//
// v0.2.21: provider dispatch is data-driven via the providers config
// block. The hardcoded `getRemainsData` / `getBalanceData` split is
// replaced by a single `fetchProviderData(provider, …)` that picks
// the right fetcher based on the matched provider's `TYPE`.

import * as cache from "./cache.ts";
import { type Remains } from "./api.ts";
import { type Balance } from "./api.deepseek.ts";
import type { Provider, TokenSample } from "./types.ts";
import { compose } from "./composition.ts";
import { type FetchResult, buildProviderLine } from "./dispatch.ts";
import { configStore, loadConfig } from "./config.ts";
import {
  fetchForProvider,
  getProviderEntry,
  matchProvider,
} from "./providers.ts";
import { appendSample } from "./token-store.ts";
import { parseTokenSnapshot } from "./session-parse.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read the upstream statusline output once at startup so the main flow and the
// crash handler can't drift apart on env-var reads.
const UPSTREAM = process.env.TOKENPLAN_UPSTREAM;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

// Three outcomes the provider data layer can report:
//   fresh — we successfully obtained the data (from network or from a
//           within-TTL cache hit); `ageMs` is the time since the entry
//           was cached. The renderer's m_age module and forced-visibility
//           append both gate on `stale === true`, so fresh ticks render
//           no age suffix regardless of ageMs.
//   stale — fetch failed but a cached value exists; `ageMs` is how long
//           it's been since the last successful fetch (from cache.Entry.at).
//           `stale=true` triggers the broken-chain suffix (e.g. "⛓️‍💥 5m ago")
//           via either the m_age module or the forced-visibility append.
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// FetchResult and buildProviderLine live in src/dispatch.ts so tests can
// import them without dragging in index.ts's stdin side effects.

// The plugin is a per-tick child process — every invocation is a fresh
// process, so the in-memory cache is reset on every tick. Within a
// single tick we still go through `cache.get` for the (defensive) hot
// path, but its only real consumer is the `cache.peek` fallback in the
// fetch-failed branch. There is no persistent cross-tick cache by
// design: the age suffix is computed from the API response itself
// (`Window.resetStartAt` → "time since this window started"), so the
// user sees a meaningful value on every successful tick without any
// disk state.

// v0.2.21: the cache key is now the provider NAME (was a constant
// string per TYPE in v0.2.20). Two TOKEN_PLAN providers would share
// a key today — that's fine since they have identical data shapes,
// but if a future provider of the same TYPE returns a different
// shape, this becomes a real distinction to make.
//
// The data generic is `unknown` because the dispatcher narrows
// based on entry.TYPE. We do a runtime check below to pick the right
// `getWithAge<T>` overload.
async function fetchProviderData(
  provider: Provider,
  token: string,
): Promise<FetchResult<unknown>> {
  const entry = getProviderEntry(provider);
  if (!entry) return { kind: "fail" };
  // We've verified the provider has a registered entry above, so the
  // `null` case in `Provider = string | null` is impossible. The
  // non-null assertion is localized to this function — callers can
  // still pass null safely because we early-return.
  const cacheKey = provider!;
  const ttlMs = configStore.get().cacheTtlMs;
  const timeoutMs = configStore.get().fetchTimeoutMs;

  // cache.getWithAge is generic on the data shape. We dispatch on
  // TYPE for the concrete type; unknown is the cross-type union.
  // (noinspection is needed because TS can't narrow `unknown` to
  // Remains/Balance purely from entry.TYPE.)
  const readCache = <T>(): { value: T; ageMs: number } | null => {
    const hit = cache.getWithAge<T>(cacheKey, ttlMs);
    return hit ? { value: hit.value, ageMs: hit.ageMs } : null;
  };

  const peekCache = <T>(): { value: T; ageMs: number } | null => {
    const hit = cache.peekWithAge<T>(cacheKey);
    return hit ? { value: hit.value, ageMs: hit.ageMs } : null;
  };

  if (entry.TYPE === "TOKEN_PLAN") {
    const cached = readCache<Remains>();
    if (cached)
      return { kind: "fresh", data: cached.value, ageMs: cached.ageMs };
  } else if (entry.TYPE === "BALANCE") {
    const cached = readCache<Balance>();
    if (cached)
      return { kind: "fresh", data: cached.value, ageMs: cached.ageMs };
  }

  try {
    const data = await fetchForProvider(
      provider,
      token,
      AbortSignal.timeout(timeoutMs),
    );
    if (data) {
      cache.set(cacheKey, data);
      // ageMs=0 on a brand-new fetch — the renderer suppresses the
      // suffix on fresh ticks (stale=false gate).
      return { kind: "fresh", data, ageMs: 0 };
    }
    // Fetcher returned null (e.g. base_resp.status_code != 0). Treat
    // as a hard fail, but still try the stale cache.
    const stale =
      entry.TYPE === "TOKEN_PLAN" ? peekCache<Remains>() : peekCache<Balance>();
    if (stale) return { kind: "stale", data: stale.value, ageMs: stale.ageMs };
    return { kind: "fail" };
  } catch {
    // Network / HTTP error. Stale-on-error: keep showing the last good value.
    const stale =
      entry.TYPE === "TOKEN_PLAN" ? peekCache<Remains>() : peekCache<Balance>();
    if (stale) return { kind: "stale", data: stale.value, ageMs: stale.ageMs };
    return { kind: "fail" };
  }
}

async function main(): Promise<void> {
  // Drain stdin ONCE at the top. The raw string is fed to
  // parseTokenSnapshot, which produces a TokenSnapshot for the
  // m_token* renderer modules. A previous dev-only runProbe() helper
  // used to also consume the raw for schema discovery; it was removed
  // in v0.4.0 once the schema was confirmed.
  const stdinRaw = await readStdin().catch(() => "");
  const tokens = parseTokenSnapshot(stdinRaw);

  // Persist one sample row per tick so m_token5h/m_token7d can read
  // across-tick history. Only do this when the parsed snapshot has
  // sessionId + cwd + in/out — otherwise we'd be writing empty rows
  // that pollute the file. appendSample swallows disk errors.
  if (
    tokens &&
    tokens.sessionId &&
    tokens.cwd &&
    tokens.totals.input != null &&
    tokens.totals.output != null
  ) {
    const sample: TokenSample = {
      at: Date.now(),
      session: tokens.sessionId,
      cwd: tokens.cwd,
      in: tokens.totals.input,
      out: tokens.totals.output,
      ctx_in: tokens.current.input ?? 0,
      ctx_creation: tokens.current.cacheCreation ?? 0,
      ctx_read: tokens.current.cacheRead ?? 0,
    };
    appendSample(sample);
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const upstream = UPSTREAM;
  const provider = matchProvider(baseUrl);

  if (provider === null) {
    process.stdout.write(compose(upstream, null));
    return;
  }

  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!token) {
    process.stdout.write(compose(upstream, null));
    return;
  }

  const result = await fetchProviderData(provider, token);
  const line = buildProviderLine(provider, result, tokens);

  process.stdout.write(compose(upstream, line));
}

// parseTokenSnapshot lives in ./session-parse.ts so unit tests can
// import it without dragging in index.ts's top-level main() side
// effects (which would hang in node:test).

// Handle unexpected throws by emitting upstream output (so claude-hud is
// never blanked by our crash). Token is never logged.
process.on("uncaughtException", (err) => {
  process.stderr.write(`tokenplan-usage-hud: ${(err as Error).message}\n`);
  process.stdout.write(UPSTREAM ?? "");
  process.exit(0);
});

// Load user config once before main() runs. ENOENT and parse errors
// fall back to DEFAULT_CONFIG (with a stderr line) — never blocks
// startup on a missing file.
await loadConfig();
// v0.2.17: load the plugin version from .claude-plugin/plugin.json
// and inject it into the configStore so the m_version display module
// can render it. Failure to find/parse the manifest is non-fatal —
// m_version simply renders nothing when version is empty. We try
// both "<runtime>/../.claude-plugin/plugin.json" (production layout
// where the bundle lives at <plugin-cache>/dist/index.js) and
// "<runtime>/.claude-plugin/plugin.json" (dev layout where the
// runtime file lives next to the manifest in the repo root).
loadPluginVersion();
await main();

function loadPluginVersion(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", ".claude-plugin", "plugin.json"),
    join(here, ".claude-plugin", "plugin.json"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        configStore.setVersion(parsed.version);
        return;
      }
    } catch {
      // Malformed manifest: fall through to the next candidate.
      // The error is non-fatal — m_version degrades to rendering "".
    }
  }
  // No manifest found or all candidates malformed: leave version empty.
  // No stderr warn here either — dev runs from a checkout without a
  // built dist don't necessarily have plugin.json next to source.
}
