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
    const upstream = upstreamCmdFile && upstreamCmdFile.length > 0 ? upstreamCmdFile : "";
    const upstreamPart = upstream
      ? `export TOKENPLAN_UPSTREAM_CMD="${upstream}"; `
      : "";
    data.statusLine = {
      type: "command",
      command: `bash -c '${upstreamPart}exec bash "${wrapper}"'`,
      _tokenplan_managed: true,
    };
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
      // Replace the entire statusLine with the pre-managed shape
      // (type + command). This drops any fields that Claude Code added
      // after install (e.g. refreshInterval) — they are not part of the
      // user-authored state we are restoring.
      data.statusLine = { type: "command", command: original };
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
