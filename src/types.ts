// Provider discriminated union. A single `ANTHROPIC_BASE_URL` selects exactly
// one provider at runtime; `null` means "no provider — render nothing".
//
// v0.2.21: Provider widened to `string | null` — providers are now
// data-driven via the `providers` config block (see src/config.ts and
// src/providers.ts). Adding a new provider no longer requires editing
// this type union; just add a new entry to config.json's `providers`
// map. The TYPE discriminator below drives which fetcher / template /
// fail-label path the dispatcher takes.

export type Provider = string | null;

// Closed enum for now. If a new TYPE is added, the fetcher / renderer /
// template selection logic grows a new branch — data shape changes
// cannot be made data-driven (they need code to interpret them).
export type ProviderType = "TOKEN_PLAN" | "BALANCE";

export type CompareMethod = "EXACT" | "INCLUDE" | "STARTWITH";

// One provider's declarative config block. All fields are required;
// the mergeConfig validator drops malformed entries (with a stderr
// warn) rather than auto-filling them, so a typo can't silently
// produce a half-configured provider.
export type ProviderEntry = {
  TYPE: ProviderType;
  BASE_URL_COMPARED_TO: string;
  COMPARE_METHOD: CompareMethod;
  ENDPOINT: string;
};