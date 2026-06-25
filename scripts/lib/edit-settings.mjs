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

switch (op) {
  case "status": {
    const data = readJson(target);
    const sl = data.statusLine;
    if (sl && sl._tokenplan_managed === true) {
      process.stdout.write("managed");
    } else if (sl && typeof sl.command === "string") {
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
    if (data.statusLine && data.statusLine._tokenplan_managed === true) {
      delete data.statusLine._tokenplan_managed;
      data.statusLine.command = original;
    } else if (!data.statusLine) {
      data.statusLine = { type: "command", command: original };
    }
    writeJson(target, data);
    break;
  }

  default:
    console.error(`edit-settings.mjs: unknown op '${op}'`);
    process.exit(2);
}