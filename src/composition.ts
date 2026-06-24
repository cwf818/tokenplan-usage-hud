// Compose our token-plan line with the upstream claude-hud output.
// Upstream is passed by the bash wrapper via the TOKENPLAN_UPSTREAM env var.

export function compose(upstream: string | undefined, planLine: string | null): string {
  const upstreamText = upstream ?? "";
  if (planLine == null || planLine === "") {
    return upstreamText;
  }
  if (upstreamText === "") {
    return `${planLine}\n`;
  }
  // Strip any trailing newline from upstream so we don't accumulate blank lines.
  const trimmedUp = upstreamText.replace(/\n+$/, "");
  return `${trimmedUp}\n${planLine}\n`;
}