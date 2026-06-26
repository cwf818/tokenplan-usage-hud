// Entry point. Runs as the Claude Code statusline child process:
//   - Reads the session JSON from stdin (we don't use it; we drain it so the
//     child doesn't block on the parent).
//   - Gates on ANTHROPIC_BASE_URL: only when pointing at a supported
//     provider (MiniMax or DeepSeek) does it fetch and render a line.
//     Otherwise the line is hidden and upstream output passes through.
//   - Composes with upstream claude-hud output (passed via TOKENPLAN_UPSTREAM
//     by the bash wrapper in scripts/wrapper.sh).
//   - Loads ~/.claude/plugins/tokenplan-usage-hud/config.json once at
//     startup; every tunable (cache TTL, fetch timeout, colors, display
//     mode, …) reads from there via the configStore singleton.

import * as cache from "./cache.ts";
import { fetchRemains, isMiniMaxBaseUrl, type Remains } from "./api.ts";
import { fetchBalance, isDeepSeekBaseUrl, type Balance } from "./api.deepseek.ts";
import type { Provider } from "./types.ts";
import { compose } from "./composition.ts";
import { type FetchResult, buildProviderLine } from "./dispatch.ts";
import { configStore, loadConfig } from "./config.ts";

const CACHE_KEY_REMAINS = "remains";
const CACHE_KEY_BALANCE = "balance";

// Read the upstream statusline output once at startup so the main flow and the
// crash handler can't drift apart on env-var reads.
const UPSTREAM = process.env.TOKENPLAN_UPSTREAM;

function resolveProvider(baseUrl: string | undefined | null): Provider {
  if (isMiniMaxBaseUrl(baseUrl)) return "minimax";
  if (isDeepSeekBaseUrl(baseUrl)) return "deepseek";
  return null;
}

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
//   fresh — we just successfully fetched the data
//   stale — fetch failed but a cached value exists; `ageMs` is how old it is
//   fail  — fetch failed AND no cached value; caller renders "not available!"
//
// The renderer uses the distinction to decide whether to append the dim
// " · Xm ago" annotation (stale only) or to render a hard-fail placeholder
// (fail only). Fresh renders are unchanged.
//
// FetchResult and buildProviderLine live in src/dispatch.ts so tests can
// import them without dragging in index.ts's stdin side effects.

async function getRemainsData(token: string): Promise<FetchResult<Remains>> {
  const ttlMs = configStore.get().cacheTtlMs;
  const fresh = cache.get<Remains>(CACHE_KEY_REMAINS, ttlMs);
  if (fresh) return { kind: "fresh", data: fresh };

  try {
    const data = await fetchRemains(token, AbortSignal.timeout(configStore.get().fetchTimeoutMs));
    if (data) {
      cache.set(CACHE_KEY_REMAINS, data);
      return { kind: "fresh", data };
    }
    // Fetcher returned null (e.g. base_resp.status_code != 0). Treat as a
    // hard fail, but still try the stale cache.
    const cached = cache.peekWithAge<Remains>(CACHE_KEY_REMAINS);
    if (cached) return { kind: "stale", data: cached.value, ageMs: cached.ageMs };
    return { kind: "fail" };
  } catch {
    // Network / HTTP error. Stale-on-error: keep showing the last good value.
    const cached = cache.peekWithAge<Remains>(CACHE_KEY_REMAINS);
    if (cached) return { kind: "stale", data: cached.value, ageMs: cached.ageMs };
    return { kind: "fail" };
  }
}

async function getBalanceData(token: string): Promise<FetchResult<Balance>> {
  const ttlMs = configStore.get().cacheTtlMs;
  const fresh = cache.get<Balance>(CACHE_KEY_BALANCE, ttlMs);
  if (fresh) return { kind: "fresh", data: fresh };

  try {
    const data = await fetchBalance(token, AbortSignal.timeout(configStore.get().fetchTimeoutMs));
    if (data) {
      cache.set(CACHE_KEY_BALANCE, data);
      return { kind: "fresh", data };
    }
    const cached = cache.peekWithAge<Balance>(CACHE_KEY_BALANCE);
    if (cached) return { kind: "stale", data: cached.value, ageMs: cached.ageMs };
    return { kind: "fail" };
  } catch {
    const cached = cache.peekWithAge<Balance>(CACHE_KEY_BALANCE);
    if (cached) return { kind: "stale", data: cached.value, ageMs: cached.ageMs };
    return { kind: "fail" };
  }
}

async function main(): Promise<void> {
  // Drain stdin — Claude Code pipes the session JSON. We don't need it for
  // token-plan rendering, but we must consume it to avoid blocking.
  await readStdin().catch(() => "");

  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const upstream = UPSTREAM;
  const provider = resolveProvider(baseUrl);

  if (provider === null) {
    process.stdout.write(compose(upstream, null));
    return;
  }

  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!token) {
    process.stdout.write(compose(upstream, null));
    return;
  }

  let line: string | null = null;
  if (provider === "minimax") {
    const result = await getRemainsData(token);
    line = buildProviderLine("minimax", result);
  } else if (provider === "deepseek") {
    const result = await getBalanceData(token);
    line = buildProviderLine("deepseek", result);
  }

  process.stdout.write(compose(upstream, line));
}

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
await main();