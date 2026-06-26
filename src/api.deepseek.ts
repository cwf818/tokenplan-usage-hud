// Fetcher + parser for the DeepSeek /user/balance endpoint, and the URL
// gate that decides whether this plugin should render a DeepSeek line at all.
//
// Real shape (verified against the user-supplied schema 2026-06-26):
//   { is_available: true,
//     balance_infos: [
//       { currency: "CNY",
//         total_balance: "110.00",
//         granted_balance: "10.00",
//         topped_up_balance: "100.00" },
//       ... possibly more entries, one per currency ...
//     ] }
//
// We render EVERY entry in balance_infos (joined by " · ") — DeepSeek may
// return multiple currencies and the user wants them all visible. The line's
// color band is driven by the LOWEST total_balance across the entries, so
// the most-urgent currency is the one that pops visually.

const ENDPOINT = "https://api.deepseek.com/user/balance";
import { configStore } from "./config.ts";

export type BalanceEntry = {
  currency: string;
  totalBalance: number;
};

export type Balance = {
  isAvailable: boolean;
  entries: BalanceEntry[];
  // Precomputed lowest total_balance across entries (null when there are
  // no parseable entries). Drives the renderer's color band.
  minValue: number | null;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function normalizeEntry(raw: unknown): BalanceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const totalBalance = asNumber(r.total_balance);
  if (totalBalance == null) return null;
  const currency = typeof r.currency === "string" && r.currency !== ""
    ? r.currency
    : configStore.get().currency.default;
  return { currency, totalBalance };
}

export function parseBalance(raw: unknown): Balance | null {
  if (!raw || typeof raw !== "object") return null;
  const root = raw as Record<string, unknown>;

  // DeepSeek uses `is_available: true | false`. Tolerate other truthy/falsy
  // forms (e.g. 1 / "true") so a schema drift doesn't blank the line.
  const availRaw = root.is_available;
  const isAvailable =
    availRaw === true ||
    availRaw === 1 ||
    (typeof availRaw === "string" && availRaw.toLowerCase() === "true");

  const arr = root.balance_infos;
  let entries: BalanceEntry[] = [];
  if (Array.isArray(arr)) {
    entries = arr.map(normalizeEntry).filter((e): e is BalanceEntry => e !== null);
  }

  if (!isAvailable) {
    return { isAvailable: false, entries, minValue: entries.length === 0 ? null : Math.min(...entries.map((e) => e.totalBalance)) };
  }

  let minValue: number | null = null;
  if (entries.length > 0) {
    minValue = entries[0].totalBalance;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].totalBalance < minValue) minValue = entries[i].totalBalance;
    }
  }

  return { isAvailable: true, entries, minValue };
}

export async function fetchBalance(
  token: string,
  signal?: AbortSignal
): Promise<Balance | null> {
  if (!token) return null;
  const res = await fetch(ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`deepseek /user/balance HTTP ${res.status}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parseBalance(parsed);
}

// URL gate: must start with `https://api.deepseek.com` (case-insensitive),
// followed by `/`, end-of-string, `?`, or `#`. This rejects suffix attacks
// like `https://api.deepseek.com.evil.example`.
export function isDeepSeekBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const prefix = "https://api.deepseek.com";
  const lower = baseUrl.toLowerCase();
  if (!lower.startsWith(prefix)) return false;
  const tail = baseUrl[prefix.length];
  // Acceptable tail: nothing (exact match), "/", "?", or "#".
  return tail === undefined || tail === "/" || tail === "?" || tail === "#";
}
