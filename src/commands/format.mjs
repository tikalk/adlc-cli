// Format commands: check and fix for collapsed Markdown (format-guard).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectCollapsed } from "../format/detect.mjs";
import { reflowMarkdown } from "../format/reflow.mjs";
import { out, err } from "../ui/index.mjs";
import { printFormatHelp } from "../help.mjs";

function detectOptions(flags) {
  const opts = {};
  if (Number.isFinite(flags?.minLength)) opts.minLength = flags.minLength;
  return opts;
}

function readInput(path) {
  if (!path || path === "-") {
    if (process.stdin.isTTY) {
      err("Error: no input (pass a file path or pipe stdin with '-').");
      return { error: 2 };
    }
    try {
      const text = readFileSync(0, "utf8");
      return { text, label: "<stdin>" };
    } catch (cause) {
      err(`Error: cannot read stdin: ${cause.message}`);
      return { error: 2 };
    }
  }
  try {
    return { text: readFileSync(path, "utf8"), label: path };
  } catch (cause) {
    err(`Error: cannot read "${path}": ${cause.message}`);
    return { error: 2 };
  }
}

function collectFiles(positionals, recursive) {
  const files = [];
  for (const p of positionals) {
    if (p === "-") {
      files.push(p);
      continue;
    }
    let st;
    try {
      st = statSync(p);
    } catch {
      return { error: `Error: cannot read "${p}": no such file or directory`, files: [] };
    }
    if (st.isDirectory()) {
      if (!recursive) {
        return { error: `Error: "${p}" is a directory (pass --recursive to scan it)`, files: [] };
      }
      files.push(...walkMarkdown(p));
    } else {
      files.push(p);
    }
  }
  return { files };
}

function walkMarkdown(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
  }
  return found;
}

function checkOne(text) {
  const r = detectCollapsed(text);
  return r;
}

export async function cmdFormat(args, flags = {}) {
  const [sub, ...rest] = args;
  if (!sub || sub === "help") {
    printFormatHelp();
    return 0;
  }
  if (sub !== "check" && sub !== "fix" && sub !== "audit") {
    err(`Error: unknown format command: "${sub}" (expected check|fix|help).`);
    return 2;
  }
  if (sub === "audit") {
    err('Error: audit is implemented in Task 6 (use "format check" for now).');
    return 2;
  }

  const positionals = rest.length === 0 ? ["-"] : rest;
  const collected = collectFiles(positionals, flags.recursive);
  if (collected.error) {
    err(collected.error);
    return 2;
  }
  const { files } = collected;
  if (files.length === 0) {
    err("Error: no Markdown files found.");
    return 2;
  }

  const stdinSingle = files.length === 1 && files[0] === "-";
  if (sub === "check") {
    const results = [];
    let anyCollapsed = false;
    for (const f of files) {
      const input = stdinSingle ? readInput("-") : readInput(f);
      if (input.error) return input.error;
      const r = checkOne(input.text, detectOptions(flags));
      const payload = {
        path: input.label,
        collapsed: r.collapsed,
        family: r.family,
        reasons: r.reasons,
        chars: input.text.length,
        newlines: (input.text.match(/\n/g) ?? []).length,
      };
      results.push(payload);
      if (r.collapsed) anyCollapsed = true;
      if (!flags.json) {
        out(r.collapsed ? `collapsed: ${input.label} (${r.family})` : `clean: ${input.label}`);
      }
    }
    if (flags.json) {
      out(JSON.stringify(stdinSingle || files.length === 1 ? {
        collapsed: results[0].collapsed,
        family: results[0].family,
        reasons: results[0].reasons,
        chars: results[0].chars,
        newlines: results[0].newlines,
      } : { files: results, collapsed: anyCollapsed }, null, 2));
    }
    return anyCollapsed ? 1 : 0;
  }

  // fix
  if (stdinSingle) {
    const input = readInput("-");
    if (input.error) return input.error;
    const r = reflowMarkdown(input.text);
    if (r.ambiguous) {
      err(`Error: ambiguous table (${r.reason}); refusing to guess.`);
      return 3;
    }
    if (flags.json) {
      out(JSON.stringify({ changed: r.text !== input.text, ambiguous: false, applied: r.applied, chars: r.text.length }, null, 2));
    } else {
      out(r.text);
    }
    return 0;
  }

  let anyAmbiguous = false;
  for (const f of files) {
    const input = readInput(f);
    if (input.error) return input.error;
    const r = reflowMarkdown(input.text);
    if (r.ambiguous) {
      err(`Error: ambiguous table in "${f}" (${r.reason}); leaving untouched.`);
      anyAmbiguous = true;
      continue;
    }
    if (flags.write) {
      try {
        writeFileSync(f, r.text, "utf8");
      } catch (cause) {
        err(`Error: cannot write "${f}": ${cause.message}`);
        return 2;
      }
      if (flags.stdout || flags.json) {
        if (flags.json) {
          out(JSON.stringify({ path: f, changed: r.text !== input.text, ambiguous: false, applied: r.applied, chars: r.text.length }));
        } else {
          out(r.text);
        }
      } else if (!flags.json) {
        out(`fixed: ${f}`);
      } else {
        out(JSON.stringify({ path: f, changed: r.text !== input.text, ambiguous: false, applied: r.applied, chars: r.text.length }));
      }
    } else if (flags.json) {
      out(JSON.stringify({ path: f, changed: r.text !== input.text, ambiguous: false, applied: r.applied, chars: r.text.length, text: r.text }));
    } else {
      out(r.text);
    }
  }
  return anyAmbiguous ? 3 : 0;
}
