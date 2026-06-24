// Compose our token-plan line with an arbitrary upstream statusline output.
// Upstream is passed by the bash wrapper via the TOKENPLAN_UPSTREAM env var.
//
// Rules:
//   - Preserve interior newlines in upstream (multi-line statuslines are valid).
//   - Strip only trailing whitespace from upstream.
//   - Ensure exactly one newline separator between upstream and our plan line.
//   - If upstream contains an ANSI SGR sequence (\x1b[) whose last escape does
//     not terminate with \x1b[0m (or the equivalent \x1b[m), inject \x1b[0m so
//     our plan line is not colored by upstream's last open style.

const RESET = "\x1b[0m";

function hasUnclosedSgr(text: string): boolean {
  // Scan for any CSI introducer; if the LAST one is not a reset (or is followed
  // by another CSI after it), the text ends with an unclosed style. We treat
  // anything that matches \x1b[ as a potential SGR — even non-SGR CSI is
  // safe to reset (it just clears attributes).
  const lastIdx = text.lastIndexOf("\x1b[");
  if (lastIdx === -1) return false;
  const tail = text.slice(lastIdx);
  // If the tail is "\x1b[0m" or "\x1b[m" (a reset), it's closed.
  if (/^\x1b\[(0m?|m)$/.test(tail)) return false;
  // Otherwise it's an open style (or any non-reset CSI) that bleeds into
  // anything we append.
  return true;
}

export function compose(upstream: string | undefined, planLine: string | null): string {
  const upstreamText = upstream ?? "";
  if (planLine == null || planLine === "") {
    return upstreamText;
  }
  if (upstreamText === "") {
    return `${planLine}\n`;
  }

  // Strip ONLY trailing whitespace (spaces, tabs, newlines) so multi-line
  // upstream keeps its interior structure intact.
  const trimmedUp = upstreamText.replace(/[\s]+$/, "");

  // Decide whether to insert a reset between upstream and our plan line.
  const reset = hasUnclosedSgr(trimmedUp) ? RESET : "";

  return `${trimmedUp}\n${reset}${planLine}\n`;
}