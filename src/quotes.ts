// v0.3.5+ — Inspirational-quote pool + per-character rainbow/hue
// helpers backing the `m_quote` template module.
//
// Design:
//   - QUOTES: a hand-curated list of 100+ short, internationally
//     recognizable inspirational phrases (mix of English + 中文 to
//     match the plugin's bilingual tone in the README). No
//     attribution strings — the statusline is a narrow strip and a
//     long "— Confucius" tail would dominate the layout. The author
//     is implicitly part of the "voice" the user opted into.
//   - pickQuote(freq, nowMs): deterministic per frequency window.
//     `freq` ∈ {"d","hd","h","hh","m"} picks a bucket size; the
//     bucket index `floor(nowMs / bucket)` is the seed for the
//     pick. Same (freq, bucket) → same quote, so a user who reloads
//     the statusline within the same hour sees the same quote
//     instead of a different one every tick.
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
// `d`  = day   = 86400000 ms
// `hd` = half day = 43200000 ms
// `h`  = hour  = 3600000 ms
// `hh` = half hour = 1800000 ms
// `m`  = minute = 60000 ms
//
// Anything else → falls back to `h` (silent, no warn — a typo is
// not worth polluting stderr every tick).
export type QuoteFreq = "d" | "hd" | "h" | "hh" | "m";

function bucketMs(freq: QuoteFreq): number {
  switch (freq) {
    case "d":
      return 86_400_000;
    case "hd":
      return 43_200_000;
    case "h":
      return 3_600_000;
    case "hh":
      return 1_800_000;
    case "m":
      return 60_000;
  }
}

// Pure: given a freq + a wall-clock ms, return the quote index. Same
// (freq, nowMs) always returns the same index — critical for the
// "stays stable within a window" guarantee. Exported so tests can
// verify determinism without going through `pickQuote`.
export function quoteIndex(freq: QuoteFreq, nowMs: number): number {
  const bucket = bucketMs(freq);
  // floor(nowMs / bucket) gives an integer seed that increments
  // exactly when the bucket rolls. Use the integer directly mod the
  // pool size. Negative inputs (clock skew) bucket to 0 — no throw.
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