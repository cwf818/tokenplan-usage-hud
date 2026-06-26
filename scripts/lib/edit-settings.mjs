#!/usr/bin/env node
// edit-settings.mjs — small helper for scripts/install.sh to read & write
// Claude Code settings.json without shell-quoting headaches.
//
// Usage:
//   node scripts/lib/edit-settings.mjs <target> <op> [...args]
//
// Operations:
//   status <target>
//       Prints one of: "managed" | "foreign:<command>" | "none"
//   write-managed <target> <wrapper> <upstream-cmd-file>
//       Rewrites statusLine to our managed wrapper. If upstream-cmd-file is
//       empty, leaves TOKENPLAN_UPSTREAM_CMD unset.
//   restore-from-file <target> <upstream-cmd-file>
//       Replaces our managed statusLine with the contents of upstream-cmd-file
//       (the originally-preserved command).
//
// Targets must be absolute, native-OS paths (use `cygpath -w` on Git Bash).
// JSON output is 2-space indented; original line ending is preserved.

import {
  readFileSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";

const [, , target, op, ...rest] = process.argv;

if (!target || !op) {
  console.error("edit-settings.mjs: missing target or op");
  process.exit(2);
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  // Preserve the original line ending: detect CRLF vs LF from a sample byte.
  let eol = "\n";
  try {
    const size = statSync(p).size;
    const head = Buffer.alloc(Math.min(64, size));
    const fd = openSync(p, "r");
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.includes(0x0d)) eol = "\r\n";
  } catch {
    /* target may be new; default to LF */
  }
  const body = text.replace(/\n/g, eol);
  writeFileSync(p, body);
}

// Build the bash -c command that install.sh writes into statusLine.command.
//
// Hardcoding the version-specific cache path (e.g. 0.2.5/scripts/wrapper.sh)
// in settings.json breaks the moment the cache rolls forward to a new
// version — settings still points at the old version's directory and the
// wrapper is missing. This helper produces a command that, at invocation
// time, resolves the highest-version directory under the plugin cache
// and execs scripts/wrapper.sh from there. Same pattern claude-hud uses
// for its own statusline.
//
// On bare systems where the cache hasn't been populated yet (e.g. the
// user ran :install before /plugin install ever finished copying files),
// the `ls … 2>/dev/null` returns empty, the chain yields plugin_dir="",
// the `[ -d "" ]` check fails, and we exit 1 with a stderr line —
// fail-fast rather than silently rendering nothing.
function buildLatestCacheCommand(_upstreamCmdFileUnused) {
  // Single-quoted bash -c body. We need literal single quotes inside
  // (for awk's '{ … }'), so we splice the standard '"'"' escape:
  //   close the outer '...',
  //   emit a literal ' via the 4-char sequence  '"'"'  ,
  //   reopen '...' for the rest.
  // The resulting command, when written into settings.json, will be one
  // line — bash sees it as a single argument to bash -c.
  //
  // Pattern, broken across lines for readability (NOT what's written):
  //   bash -c '
  //     plugin_dir=$(ls -d …/tokenplan-usage-hud/*/ | awk -F/ '\''{…}'\'' | sort … | tail -1 | cut -f2-)
  //     [ -d "$plugin_dir" ] || { echo … >&2; exit 1; }
  //     export TOKENPLAN_UPSTREAM_CMD="${plugin_dir}state/upstream-cmd.sh"
  //     exec bash "${plugin_dir}scripts/wrapper.sh"
  //   '
  //
  // We don't pre-resolve upstream-cmd.sh: it lives in ${plugin_dir}state/
  // and gets (re)written by install.sh every install, so following the
  // latest-cache pointer keeps both wrapper and upstream in lockstep.
  // The upstreamCmdFile arg is kept for API stability with the caller
  // (install.sh forwards both wrapper + upstream); it's intentionally
  // unused here.
  void _upstreamCmdFileUnused;
  return [
    "bash -c '",
    "plugin_dir=$(ls -d \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}\"/plugins/cache/tokenplan-usage-hud/tokenplan-usage-hud/*/ 2>/dev/null | awk -F/ '\"'\"'{ print $(NF-1) \"\\t\" $(0) }'\"'\"' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); ",
    "[ -d \"$plugin_dir\" ] || { echo \"tokenplan-usage-hud: no installed version found under cache\" >&2; exit 1; }; ",
    "export TOKENPLAN_UPSTREAM_CMD=\"${plugin_dir}state/upstream-cmd.sh\"; ",
    "exec bash \"${plugin_dir}scripts/wrapper.sh\"",
    "'",
  ].join("");
}

// Fingerprint for the wrapper command install.sh writes. Two-part check:
//   1. The command path lives inside our plugin cache (the only place
//      install.sh points the wrapper at). Match either separator since
//      the actual paths in settings.json come from a Cygwin / native
//      boundary — on Windows install.sh converts via `cygpath -w` and
//      we see backslashes; on Linux/macOS we see forward slashes.
//   2. The command ends with `wrapper.sh"'` — the literal `bash -c '...'`
//      closing single-quote install.sh emits, preceded by the double-quote
//      that wraps the wrapper path inside the bash -c arg.
//
// Why this matters: _tokenplan_managed === true is a marker WE write, but
// a foreign command can be in place when (a) another plugin overwrites
// statusLine after ours, (b) the user hand-edits settings.json, or
// (c) Claude Code re-derives statusLine. The marker survives all of
// those. Trusting the marker alone causes uninstall to clobber the
// foreign command with our cached wrapper — losing the user's intent.
function isOurWrapperCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  // Path matches "plugins[/\]cache[/\]tokenplan-usage-hud[/\]tokenplan-usage-hud[/\]".
  // Using a runtime regex (not a string .includes) sidesteps the JS string
  // escape rules: in the regex source `\\` matches a single literal `\`.
  // Accepts either separator since the paths in settings.json come from
  // a Cygwin / native boundary (backslashes on Windows, forward slashes
  // on Linux/macOS).
  const pathRe = /plugins[\/\\]cache[\/\\]tokenplan-usage-hud[\/\\]tokenplan-usage-hud[\/\\]/;
  // Suffix: install.sh writes `bash -c '...exec bash "<path>"'`, so the
  // last three characters of the command are literally `sh"'`. The
  // trailing `'` distinguishes our wrapper from a different command
  // that happens to mention our cache path.
  return pathRe.test(command) && /wrapper\.sh"'\s*$/.test(command);
}

switch (op) {
  case "status": {
    const data = readJson(target);
    const sl = data.statusLine;
    if (sl && sl._tokenplan_managed === true && isOurWrapperCommand(sl.command)) {
      // Both the marker AND the wrapper command are ours → safe to treat as
      // managed (uninstall can restore from upstream-cmd.txt; re-install is
      // a no-op).
      process.stdout.write("managed");
    } else if (sl && typeof sl.command === "string") {
      // Either no marker, or marker is set but the command is foreign
      // (another plugin / human overwrote it). Treat as foreign so install.sh
      // preserves the current command and writes a new upstream-cmd.sh.
      process.stdout.write("foreign:" + sl.command);
    } else {
      process.stdout.write("none");
    }
    break;
  }

  case "write-managed": {
    const [wrapper, upstreamCmdFile] = rest;
    const data = readJson(target);
    // The wrapper path coming in is the version-specific path install.sh
    // resolved at install time (e.g. C:\…\0.2.5\scripts\wrapper.sh).
    // That's not what we want in settings.json — hardcoding the version
    // means a subsequent /plugin install that bumps 0.2.5 → 0.2.6 leaves
    // the statusline pointing at a now-orphan path. Mirror claude-hud's
    // "ls + sort + tail" pattern instead: at invocation time the
    // wrapper resolves the highest-version directory under the plugin
    // cache, then execs scripts/wrapper.sh from there. Install-time
    // changes (bump version, copy a new dir into cache) become
    // automatically picked up.
    const prev = (data.statusLine && typeof data.statusLine === "object")
      ? data.statusLine
      : {};
    const next = { ...prev };
    next.type = "command";
    next.command = buildLatestCacheCommand(upstreamCmdFile || "");
    next._tokenplan_managed = true;
    data.statusLine = next;
    writeJson(target, data);
    break;
  }

  case "restore-from-file": {
    const [upstreamCmdOnly] = rest;
    const original = readFileSync(upstreamCmdOnly, "utf8").trim();
    const data = readJson(target);
    // Same guard as `status`: only restore when the current command is
    // actually ours. Otherwise the user (or another plugin) replaced the
    // command after install; touching it would clobber their intent.
    if (data.statusLine && isOurWrapperCommand(data.statusLine.command)) {
      // Mirror write-managed's read-modify-write: shallow-copy the
      // CURRENT statusLine (which may carry user-set fields the user
      // added AFTER our install — most notably refreshInterval), then
      // overwrite only the keys we own. Previously this op nuked every
      // other field by replacing the whole object, silently dropping
      // refreshInterval on every uninstall. See commit 89e9e10
      // (v0.1.23) for the matching install-side fix.
      const next = { ...data.statusLine };
      next.type = "command";
      next.command = original;
      delete next._tokenplan_managed;
      data.statusLine = next;
    } else if (!data.statusLine) {
      data.statusLine = { type: "command", command: original };
    } else {
      // Foreign command under a stale _tokenplan_managed marker — leave
      // it alone. The marker is no longer meaningful; the user owns the
      // current command.
      process.stderr.write(
        "edit-settings.mjs: restore-from-file skipped — current statusLine.command is not the tokenplan wrapper\n"
      );
    }
    writeJson(target, data);
    break;
  }

  default:
    console.error(`edit-settings.mjs: unknown op '${op}'`);
    process.exit(2);
}
