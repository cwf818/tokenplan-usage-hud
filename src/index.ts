// Entry point. Runs as the Claude Code statusline child process:
//   - Reads the session JSON from stdin (we don't use it; we drain it so the
//     child doesn't block on the parent).
//   - Gates on ANTHROPIC_BASE_URL: only when pointing at a supported
//     provider (MiniMax or DeepSeek) does it fetch and render a line.
//     Otherwise the line is hidden and upstream output passes through.
//   - Composes with upstream claude-hud output (passed via TOKENPLAN_UPSTREAM
//     by the bash wrapper in scripts/wrapper.sh).

import * as cache from "./cache.ts";
import { fetchRemains, isMiniMaxBaseUrl, type Remains } from "./api.ts";
import { fetchBalance, isDeepSeekBaseUrl, type Balance } from "./api.deepseek.ts";
import type { Provider } from "./types.ts";
import { formatLine, formatBalanceLine, resolveDisplayMode } from "./render.ts";
import { compose } from "./composition.ts";

const CACHE_KEY_REMAINS = "remains";
const CACHE_KEY_BALANCE = "balance";
const TTL_MS = 60_000;

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

async function getRemainsData(token: string): Promise<Remains | null> {
  const fresh = cache.get<Remains>(CACHE_KEY_REMAINS, TTL_MS);
  if (fresh) return fresh;

  try {
    const data = await fetchRemains(token);
    if (data) {
      cache.set(CACHE_KEY_REMAINS, data);
      return data;
    }
    return null;
  } catch {
    // Stale-on-error: keep showing the last good value.
    return cache.peek<Remains>(CACHE_KEY_REMAINS);
  }
}

async function getBalanceData(token: string): Promise<Balance | null> {
  const fresh = cache.get<Balance>(CACHE_KEY_BALANCE, TTL_MS);
  if (fresh) return fresh;

  try {
    const data = await fetchBalance(token);
    if (data) {
      cache.set(CACHE_KEY_BALANCE, data);
      return data;
    }
    return null;
  } catch {
    // Stale-on-error: keep showing the last good value.
    return cache.peek<Balance>(CACHE_KEY_BALANCE);
  }
}

function renderPlanLine(data: Remains): string | null {
  const mode = resolveDisplayMode(process.env.TOKENPLAN_DISPLAY);
  if (data.fiveHour && data.weekly) {
    return formatLine(data.fiveHour, data.weekly, mode);
  }
  // If only one window is present, render what's available rather than nothing.
  const zero = { pct: 0 } as const;
  if (data.fiveHour) return formatLine(data.fiveHour, zero, mode);
  if (data.weekly) return formatLine(zero, data.weekly, mode);
  return null;
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
    const data = await getRemainsData(token);
    line = data ? renderPlanLine(data) : null;
  } else if (provider === "deepseek") {
    const data = await getBalanceData(token);
    line = data ? formatBalanceLine(data) : null;
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

await main();