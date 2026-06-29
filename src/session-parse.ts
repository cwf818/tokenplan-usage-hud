// Parse the Claude Code session JSON piped to stdin into a
// TokenSnapshot suitable for the m_token* / m_session* renderer
// modules.
//
// Extracted from src/index.ts so unit tests can import it without
// pulling in index.ts's top-level `await main()` and `loadConfig()`
// side effects (which would hang in node:test). The behavior is
// identical — same field paths, same null-coercion rules.
//
// Tolerates partial input: any field can be missing. The renderer
// modules each independently null-check their piece. v0.4.0+ adds
// session-identity / metadata fields (sessionName, modelDisplayName,
// effort, repo, ccversion), context-window stats (size, usedPct,
// remainingPct), and extended cost fields (totalApiDurationMs,
// totalLinesAdded, totalLinesRemoved).
import type { TokenSnapshot } from "./types.ts";

export function parseTokenSnapshot(raw: string): TokenSnapshot | null {
  if (!raw || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const r = parsed as Record<string, unknown>;

  const cw = r.context_window;
  const cwObj =
    cw && typeof cw === "object" ? (cw as Record<string, unknown>) : null;
  const cu = cwObj?.current_usage;
  const cuObj =
    cu && typeof cu === "object" ? (cu as Record<string, unknown>) : null;

  const cost = r.cost;
  const costObj =
    cost && typeof cost === "object"
      ? (cost as Record<string, unknown>)
      : null;

  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  // v0.4.0+ — extract session identity / metadata.
  // `model` is a nested object: { id, display_name }.
  const modelObj =
    r.model && typeof r.model === "object" && !Array.isArray(r.model)
      ? (r.model as Record<string, unknown>)
      : null;
  // `effort` is polymorphic: either a bare string ("high") or an
  // object ({ level: "high", ... }). We coerce both shapes to a
  // string|null at parse time so the renderer doesn't need a branch.
  const effortRaw = r.effort;
  let effort: string | null = null;
  if (typeof effortRaw === "string" && effortRaw.length > 0) {
    effort = effortRaw;
  } else if (
    effortRaw && typeof effortRaw === "object" && !Array.isArray(effortRaw)
  ) {
    effort = strOrNull((effortRaw as Record<string, unknown>).level);
  }
  // `workspace.repo` is { host, owner, name }. We extract per-field
  // and let the renderer decide whether to render (it filters null
  // components and joins with `/`).
  const workspaceObj =
    r.workspace && typeof r.workspace === "object" && !Array.isArray(r.workspace)
      ? (r.workspace as Record<string, unknown>)
      : null;
  const repoRaw = workspaceObj?.repo;
  let repo:
    | { host: string | null; owner: string | null; name: string | null }
    | null = null;
  if (repoRaw && typeof repoRaw === "object" && !Array.isArray(repoRaw)) {
    const ro = repoRaw as Record<string, unknown>;
    repo = {
      host: strOrNull(ro.host),
      owner: strOrNull(ro.owner),
      name: strOrNull(ro.name),
    };
  }

  return {
    sessionId: strOrNull(r.session_id),
    cwd: strOrNull(r.cwd),
    totals: {
      input: numOrNull(cwObj?.total_input_tokens),
      output: numOrNull(cwObj?.total_output_tokens),
    },
    current: {
      input: numOrNull(cuObj?.input_tokens),
      output: numOrNull(cuObj?.output_tokens),
      cacheCreation: numOrNull(cuObj?.cache_creation_input_tokens),
      cacheRead: numOrNull(cuObj?.cache_read_input_tokens),
    },
    cost: {
      totalDurationMs: numOrNull(costObj?.total_duration_ms),
      totalApiDurationMs: numOrNull(costObj?.total_api_duration_ms),
      totalLinesAdded: numOrNull(costObj?.total_lines_added),
      totalLinesRemoved: numOrNull(costObj?.total_lines_removed),
    },
    sessionName: strOrNull(r.session_name),
    modelDisplayName: strOrNull(modelObj?.display_name),
    effort,
    repo,
    ccversion: strOrNull(r.version),
    contextWindow: {
      size: numOrNull(cwObj?.context_window_size),
      usedPct: numOrNull(cwObj?.used_percentage),
      remainingPct: numOrNull(cwObj?.remaining_percentage),
    },
  };
}