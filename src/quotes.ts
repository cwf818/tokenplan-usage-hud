// v0.3.6+ — Inspirational-quote pool + per-character rainbow/hue
// helpers backing the `m_quote` template module.
//
// Design:
//   - QUOTES: a hand-curated list of 100+ short, internationally
//     recognizable inspirational phrases (mix of English + 中文 to
//     match the plugin's bilingual tone in the README). No
//     attribution strings — the statusline is a narrow strip and a
//     long "— Confucius" tail would dominate the layout. The author
//     is implicitly part of the "voice" the user opted into.
//   - parseFreq(raw) → QuoteFreq: parses the `:freq:<…>` token.
//     Grammar is the single-unit time format `<digits><unit>` where
//     unit ∈ {"d","h","m","s"} and bare unit letters are shorthand
//     for "1<unit>" (so `h` ≡ `1h`). Multi-unit forms like "2h10m"
//     are rejected; users express 130 minutes as "130m".
//   - pickQuote(freq, nowMs): deterministic per frequency window.
//     The bucket index is derived from the parsed `freq.ms`. When
//     `freq.ms` divides one day (24h, 12h, 6h, 3h, 4h, 8h, 30m, …)
//     the boundary is anchored to UTC midnight so predictable
//     rollover times are preserved; otherwise it rolls at Unix-
//     epoch multiples (e.g. "13h" rolls every 13 hours from epoch).
//   - buildRainbow(text, seed): per-character 256-color SGR wrap.
//     Same text + same seed → identical output. Used for the
//     `rainbow` and `rand-rainbow` color shortcuts.
//   - buildHue(text, seed): single-color wrap, hue picked from the
//     hash. Used for the `hue` shortcut.
//
// All functions are PURE (no Date.now / no Math.random / no I/O) so
// they're testable with fixed inputs and produce the same bytes
// across the whole statusline process — critical because the
// renderer is called on every Claude Code tick.

// ----- Quote pool -----
//
// Keep this as a const array (not a Set) so test code can index
// directly into it. ≥100 entries; keep entries ≤ 50 chars so a
// quote + the rest of the statusline still fits on a single
// terminal row at 80 cols (e.g. with the default 5h/7d windows + a
// 60-char quote = 88 chars, within typical wrap tolerance).
export const QUOTES: readonly string[] = [
  // English (1-60)
  "Stay hungry, stay foolish.",
  "The only way out is through.",
  "Done is better than perfect.",
  "Move fast and fix things.",
  "Make it work, make it right, make it fast.",
  "Premature optimization is the root of all evil.",
  "Talk is cheap. Show me the code.",
  "Simplicity is the ultimate sophistication.",
  "Programs must be written for people to read.",
  "First, solve the problem. Then, write the code.",
  "It's not a bug, it's an undocumented feature.",
  "Two hard things: cache invalidation, naming things.",
  "Weeks of coding can save you hours of planning.",
  "The best error message is the one that never shows up.",
  "If you can dream it, you can do it.",
  "Believe you can and you're halfway there.",
  "The harder you work, the luckier you get.",
  "Quality is not an act, it is a habit.",
  "Action is the foundational key to all success.",
  "What we think, we become.",
  "Well done is better than well said.",
  "The future depends on what you do today.",
  "Discipline is the bridge between goals and accomplishment.",
  "Do the hard jobs first. The easy jobs will take care of themselves.",
  "Don't watch the clock; do what it does. Keep going.",
  "Success is the sum of small efforts repeated day in and day out.",
  "Start where you are. Use what you have. Do what you can.",
  "It always seems impossible until it's done.",
  "Focus on being productive instead of busy.",
  "The secret of getting ahead is getting started.",
  "Don't let yesterday take up too much of today.",
  "You learn more from failure than from success.",
  "It's not whether you get knocked down, it's whether you get up.",
  "If you are working on something exciting, it will keep you motivated.",
  "Success is not in what you have, but who you are.",
  "The way to get started is to quit talking and begin doing.",
  "Innovation distinguishes between a leader and a follower.",
  "Life is what happens when you're busy making other plans.",
  "The mind is everything. What you think you become.",
  "Strive not to be a success, but rather to be of value.",
  "Two roads diverged in a wood, and I took the one less traveled.",
  "That which does not kill us makes us stronger.",
  "Be the change that you wish to see in the world.",
  "The best time to plant a tree: 20 years ago. Second best: now.",
  "An unexamined life is not worth living.",
  "I think, therefore I am.",
  "The unexamined life is not worth living.",
  "Knowledge is power.",
  "To be or not to be, that is the question.",
  "I have a dream.",
  "The only thing we have to fear is fear itself.",
  "Float like a butterfly, sting like a bee.",
  "I'll be back.",
  "Houston, we have a problem.",
  "May the Force be with you.",
  "Elementary, my dear Watson.",
  "Eureka!",
  "Veni, vidi, vici.",
  "Carpe diem.",
  "Memento mori.",
  "Cogito ergo sum.",
  // 中文 (61-110)
  "千里之行，始于足下。",
  "行胜于言。",
  "学而时习之，不亦说乎。",
  "天行健，君子以自强不息。",
  "地势坤，君子以厚德载物。",
  "路漫漫其修远兮，吾将上下而求索。",
  "不积跬步，无以至千里；不积小流，无以成江海。",
  "工欲善其事，必先利其器。",
  "业精于勤，荒于嬉；行成于思，毁于随。",
  "宝剑锋从磨砺出，梅花香自苦寒来。",
  "少壮不努力，老大徒伤悲。",
  "一寸光阴一寸金，寸金难买寸光阴。",
  "三人行，必有我师焉。",
  "知之为知之，不知为不知，是知也。",
  "温故而知新，可以为师矣。",
  "学而不思则罔，思而不学则殆。",
  "己所不欲，勿施于人。",
  "得道多助，失道寡助。",
  "生于忧患，死于安乐。",
  "富贵不能淫，贫贱不能移，威武不能屈。",
  "苟利国家生死以，岂因祸福避趋之。",
  "天下兴亡，匹夫有责。",
  "人生自古谁无死，留取丹心照汗青。",
  "海纳百川，有容乃大；壁立千仞，无欲则刚。",
  "一万年太久，只争朝夕。",
  "数风流人物，还看今朝。",
  "星星之火，可以燎原。",
  "没有调查就没有发言权。",
  "实事求是。",
  "实践是检验真理的唯一标准。",
  "世上无难事，只要肯登攀。",
  "为中华之崛起而读书。",
  "我自横刀向天笑，去留肝胆两昆仑。",
  "与天地兮比寿，与日月兮齐光。",
  "莫愁前路无知己，天下谁人不识君。",
  "长风破浪会有时，直挂云帆济沧海。",
  "会当凌绝顶，一览众山小。",
  "天生我材必有用，千金散尽还复来。",
  "仰天大笑出门去，我辈岂是蓬蒿人。",
  "人生如逆旅，我亦是行人。",
  "此心安处是吾乡。",
  "纸上得来终觉浅，绝知此事要躬行。",
  "问渠那得清如许，为有源头活水来。",
  "少年辛苦终身事，莫向光阴惰寸功。",
  "博观而约取，厚积而薄发。",
  "沉舟侧畔千帆过，病树前头万木春。",
  "山重水复疑无路，柳暗花明又一村。",
  "不畏浮云遮望眼，自缘身在最高层。",
  "咬定青山不放松，立根原在破岩中。",
  "Stay weird, stay hungry.",
  "Make today count.",
  "Less talk, more code.",
  "Ship it.",
  "Fail fast, learn faster.",
  "Code is read more than written.",
  "Refactor early, refactor often.",
  "Tests are a love letter to future you.",
  "Every expert was once a beginner.",
  "Move fast, fix things.",
  "The best time to start was yesterday.",
  "今天最好的表现，是明天最低的要求。",
  "越努力，越幸运。",
  "不怕慢，就怕站。",
  "一万小时定律。",
];

// ----- Frequency → bucket size -----
//
// Bucket = the smallest time unit at which the displayed quote can
// change. Two ticks within the same bucket show the same quote.
//
// Grammar (single-unit time format, mirrors the reset countdown):
//   freq := <digits><unit>            e.g. "12h", "30m", "7d", "130m"
//         |  <unit>                   shorthand for 1<unit>
//
//   <unit> := "d" | "h" | "m" | "s"
//   <digits> := [0-9]+
//
// So:
//   "d"   == "1d"   → 24h
//   "h"   == "1h"   → 1h
//   "m"   == "1m"   → 1m
//   "s"   == "1s"   → 1s
//   "12h"           → 12h
//   "30m"           → 30m
//   "130m"          → 130m
//
// Anything else (multi-unit like "2h10m", unknown units, zero, overflow,
// empty, "h10") → null. The caller (render.ts) treats null as a parse
// failure: drop the token with a one-shot stderr warn.
//
// Anchoring rule — when does the bucket boundary sit on the wall clock?
//   - If `bucketMs` divides one day (86_400_000) exactly, the boundary
//     is UTC midnight: floor(nowMs / bucket) is the same regardless of
//     when in the day you check, so a user who picked "12h" sees the
//     quote roll at 00:00 and 12:00 UTC — the predictable behavior the
//     old `hd` form gave.
//   - Otherwise (bucketMs does not divide one day), the boundary is
//     Unix-epoch zero. "7d" happens to divide (so it gets UTC midnight
//     boundaries); "13h" does not (so it rolls relative to the epoch).
export type QuoteFreqUnit = "d" | "h" | "m" | "s";

// Parsed freq spec. Carrying the unit-ms separately (instead of a
// precomputed single number) lets the renderer pick the right anchor
// strategy at call time without re-parsing.
export interface QuoteFreq {
  readonly count: number;
  readonly unit: QuoteFreqUnit;
  readonly ms: number;
}

const UNIT_MS: Readonly<Record<QuoteFreqUnit, number>> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

// Hard upper bound on count: 1_000_000 of any unit. Largest legal value
// is "1000000s" ≈ 11.6 days, "1000000m" ≈ 694 days, "1000000h" ≈ 114
// years, "1000000d" ≈ 2738 years. Anything bigger is rejected so the
// seed index can't overflow Math.floor(nowMs / 1) ranges on real
// timestamps. (nowMs is ~1.7e12 today, so even 1e12 would be safely
// in range — 1e6 is generous without inviting pathological inputs.)
const MAX_COUNT = 1_000_000;

export function parseFreq(raw: string): QuoteFreq | null {
  if (raw === "") return null;
  // Shorthand: bare unit letter → count=1.
  if (raw === "d" || raw === "h" || raw === "m" || raw === "s") {
    const ms = UNIT_MS[raw];
    return { count: 1, unit: raw, ms };
  }
  // Numeric form: <digits><unit>. Must end in a single unit letter;
  // no multi-unit, no leading sign, no whitespace.
  const unit = raw[raw.length - 1];
  if (unit !== "d" && unit !== "h" && unit !== "m" && unit !== "s") {
    return null;
  }
  const digits = raw.slice(0, -1);
  if (digits === "") return null;
  // Reject "01" / "07" — explicit leading-zero policy. Keeps the
  // grammar tight; users who type "1h" should not be silently
  // redirected through "01h".
  if (digits.length > 1 && digits[0] === "0") return null;
  if (!/^[0-9]+$/.test(digits)) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n === 0 || n > MAX_COUNT) return null;
  const u = unit as QuoteFreqUnit;
  return { count: n, unit: u, ms: n * UNIT_MS[u] };
}

// True when the bucket boundary aligns with UTC midnight — i.e. when
// bucketMs divides one day exactly. 86_400_000 has divisors of the
// form (d × h × m × s) where d ∈ {1,2,3,4,6,8,12,24}, h ∈ {1,2,3,4,6,8,12,24},
// m ∈ {1..60 if h divides 24}, s ∈ {1..60 if m divides 60}. So e.g.
// 12h, 6h, 3h, 4h, 8h, 24h/24h, 30m, 15m, 20m, 60s, etc. all qualify.
// 7d divides by exactly 7 — yes. 13h doesn't divide 24h — no.
export function utcAnchored(bucketMs: number): boolean {
  if (bucketMs <= 0) return false;
  return 86_400_000 % bucketMs === 0;
}

// Pure: given a freq + a wall-clock ms, return the quote index. Same
// (freq, nowMs) always returns the same index — critical for the
// "stays stable within a window" guarantee. Exported so tests can
// verify determinism without going through `pickQuote`.
//
// Formula: seed = floor(nowMs / bucket). This works for BOTH anchor
// modes:
//   - Rolling: boundaries are at Unix-epoch multiples of `bucket`,
//     so floor(nowMs/bucket) is the bucket index.
//   - UTC-anchored: bucket divides one day (86_400_000), so bucket
//     boundaries are also at multiples of 86_400_000 from epoch.
//     floor(nowMs/bucket) gives the bucket index from epoch, which
//     for two times within the same calendar day will differ by
//     an integer multiple of (86_400_000/bucket) — same mod-pool
//     residue. The seed is the same, so the picked quote is the
//     same. Crossing a UTC-midnight boundary advances the bucket
//     index exactly when expected.
export function quoteIndex(freq: QuoteFreq, nowMs: number): number {
  const bucket = freq.ms;
  const seed = Math.floor(nowMs / bucket);
  // Handle negative seeds via modulo: JS's % preserves sign of the
  // dividend. Map to a non-negative residue.
  const len = QUOTES.length;
  return ((seed % len) + len) % len;
}

// Pick a quote for the given freq + now. Convenience wrapper that
// returns the string. Stable per window.
export function pickQuote(freq: QuoteFreq, nowMs: number): string {
  return QUOTES[quoteIndex(freq, nowMs)]!;
}

// ----- Color helpers -----
//
// These three helpers back the three new color shortcut values
// accepted by `m_quote:color:<c>`:
//   - "rainbow"        → buildRainbow(text, 0)
//   - "rand-rainbow"   → buildRainbow(text, seed + 1)
//   - "hue"            → buildHue(text, seed)
//
// `seed` is the freq-window bucket index from `quoteIndex`. Same
// bucket → same color output (consistent with the quote's stability
// window). The renderer wires these up — see src/render.ts.

export const RESET = "\x1b[0m";

// 256-color rainbow palette: 16 hues × N brightness steps. Sampling
// 6 evenly-spaced hue indices from the 6×6×6 color cube (xterm's
// `colors -1` table) gives a smooth spectrum without the eye-strain
// of `colors 16-231` random sampling.
//
// Palette indices chosen for visibility on dark AND light terminals:
//   39 (cyan-3),  45 (blue-2),   99 (purple-2),
//  201 (magenta-2),  208 (orange-3), 220 (yellow-3)
// Reused cyclically for short strings.
const RAINBOW_PALETTE: readonly number[] = [
  39, 45, 99, 201, 208, 220,
];

// Build a per-character rainbow-wrapped string. Each char gets
// `\x1b[38;5;{n}m` + char + RESET. The seed offsets the rotation so
// `rand-rainbow` doesn't have to start at hue 0 every window.
export function buildRainbow(text: string, seed: number): string {
  if (text === "") return "";
  const out: string[] = [];
  const len = RAINBOW_PALETTE.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    // Skip newlines and joiners (this would break the SGR wrapping
    // by introducing unclosed color runs). Preserve them as-is and
    // emit a RESET to close any open run.
    if (ch === "\n" || ch === "\r") {
      out.push(ch);
      continue;
    }
    const idx = ((i + seed) % len + len) % len;
    const color = RAINBOW_PALETTE[idx]!;
    out.push(`\x1b[38;5;${color}m${ch}${RESET}`);
  }
  return out.join("");
}

// Build a single-hue-wrapped string. Hue picked from the 256-color
// cube's first row (0..15 are the system + base colors, 16..231
// is the 6×6×6 cube, 232..255 is grayscale). We sample from the
// cube at a fixed gray step to keep every quote readable.
//
// Use a tiny DJB2 hash so the same text → same hue. (Seed ignored
// intentionally — `hue` always reflects the text.)
export function buildHue(text: string, _seed: number): string {
  if (text === "") return "";
  // DJB2 — small, deterministic, no need for crypto here.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  // Sample from the high half of the 6×6×6 cube (rows 2-5 of each
  // RGB channel) so colors are saturated but not eye-searing.
  // Map the hash (signed 32-bit) to a cube index.
  const idx = 16 + ((Math.abs(h) % 216) | 0); // 16..231
  return `\x1b[38;5;${idx}m${text}${RESET}`;
}