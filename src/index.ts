// Entry point. Runs as the Claude Code statusline child process:
//   - Reads the session JSON from stdin (we don't use it; we drain it so the
//     child doesn't block on the parent).
//   - Gates on ANTHROPIC_BASE_URL: only when pointing at MiniMax does it
//     fetch and render the token-plan line.
//   - Composes with upstream claude-hud output (passed via TOKENPLAN_UPSTREAM
//     by the bash wrapper in scripts/wrapper.sh).

import * as cache from "./cache.ts";
import { fetchRemains, isMiniMaxBaseUrl, type Remains } from "./api.ts";
import { formatLine, resolveDisplayMode } from "./render.ts";
import { compose } from "./composition.ts";

const CACHE_KEY = "remains";
const TTL_MS = 60_000;

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

async function getPlanData(token: string): Promise<Remains | null> {
  const fresh = cache.get<Remains>(CACHE_KEY, TTL_MS);
  if (fresh) return fresh;

  try {
    const data = await fetchRemains(token);
    if (data) {
      cache.set(CACHE_KEY, data);
      return data;
    }
    return null;
  } catch {
    // Stale-on-error: keep showing the last good value.
    return cache.peek<Remains>(CACHE_KEY);
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
  const upstream = process.env.TOKENPLAN_UPSTREAM;

  if (!isMiniMaxBaseUrl(baseUrl)) {
    process.stdout.write(compose(upstream, null));
    return;
  }

  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  if (!token) {
    process.stdout.write(compose(upstream, null));
    return;
  }

  const data = await getPlanData(token);
  const line = data ? renderPlanLine(data) : null;
  process.stdout.write(compose(upstream, line));
}

// Handle unexpected throws by emitting upstream output (so claude-hud is
// never blanked by our crash). Token is never logged.
process.on("uncaughtException", (err) => {
  process.stderr.write(`tokenplan-usage-hud: ${(err as Error).message}\n`);
  process.stdout.write(process.env.TOKENPLAN_UPSTREAM ?? "");
  process.exit(0);
});

await main();