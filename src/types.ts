// Provider discriminated union. A single `ANTHROPIC_BASE_URL` selects exactly
// one provider at runtime; `null` means "no provider — render nothing".
//
// Add new providers by extending this union and the gate functions in
// `api.ts` (isMiniMaxBaseUrl) and `api.deepseek.ts` (isDeepSeekBaseUrl).
export type Provider = "minimax" | "deepseek" | null;
