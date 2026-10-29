// The merge engine for `adlc-cli mcp install`: materialise the .mcp.json
// server map into each agent's own config file, keyed on the server NAME.
//
// ── Ownership is the name ─────────────────────────────────────────────
// A name present in the .mcp.json `servers` map is tool-owned and
// regenerated every run, even if hand-edited — including a bare
// {"enabled": <bool>} / `enabled = <bool>` override: overrides belong in
// .mcp.json (`disabled`), not in the agent's file (ADR-455). Keeping a
// bare off-switch here would silently trap a disabled→re-enabled server
// in the off state while .mcp.json says on. A name absent from it is
// never read, compared or written — everything else in the target is
// foreign and preserved (byte-for-byte where the format allows).
//
// ── Two failure channels (never mixed) ────────────────────────────────
//   errors[]  — target-level: unparseable / JSONC / wrong shape /
//               unreadable / unwritable / a write-guard refusal. The file
//               is left untouched and no per-server write is attempted.
//   written[] — per-server: added | updated | kept | refused |
//               disabled-skipped (each with a detail). The rest of the
//               servers still install.
//
// ── Never half-write ─────────────────────────────────────────────────
// translateEntry returning null means the entry cannot be fully expressed
// here: it is refused and explained (describeRefusal), never partially
// written. A disabled server either becomes an off switch where one exists
// (has_off_switch) or is omitted/reported where none does.
//
// ── .mcp.json is the source, never a target ──────────────────────────
// .mcp.json is the source of truth and is never rewritten by tooling.
// claude-code ("the standard is its file") is therefore a no-op: every
// server reports kept and nothing is written — those servers came FROM
// .mcp.json. disabled:true does not delete there either. A write-layer
// guard additionally refuses to write the resolved source path for any
// row: it judges every write by the target's REAL path (symlinks
// followed), refusing the source itself and anything that resolves
// outside the project tree. A malformed TOML marker pair is a
// target-level error: the file is left untouched rather than risk losing
// a user's content.

import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { getMcpAgent } from "../registry.mjs";
import { translateEntry, describeRefusal, offSwitchEntry, expressibleVars } from "./translate.mjs";

// The protected source of truth. Never written by tooling.
const MCP_SOURCE = ".mcp.json";

/**
 * Merge the .mcp.json `servers` map into one agent's config file.
 *
 * @param {{projectRoot: string, agent: string, servers: object}} args
 *   `agent` is a registry key ("claude"/"opencode"/"codex"/"cursor");
 *   `servers` is the parsed .mcp.json mcpServers map.
 * @returns {{target: string, written: Array<{name: string, action: string, detail?: string}>, errors: string[]}}
 */
export function installForAgent({ projectRoot, agent, servers }) {
  const report = { target: "", written: [], errors: [] };
  const row = getMcpAgent(agent);
  if (!row) {
    report.errors.push(`unknown agent "${agent}"`);
    return report;
  }

  const target = resolveTarget(projectRoot, row);
  report.target = target;
  const absPath = join(projectRoot, target);

  // claude-code ("the standard is its file"): a no-op. Its target IS the
  // source .mcp.json, which is never rewritten. Every server already lives
  // there (that is where `servers` came from), so report kept and write
  // nothing. disabled:true has no effect here and must not delete the
  // declaration — the user deletes it by hand to turn a server off.
  if (row.format === "claude" && isSourcePath(absPath, projectRoot)) {
    for (const [name, spec] of Object.entries(servers ?? {})) {
      report.written.push({
        name,
        action: "kept",
        detail: spec?.disabled
          ? "no effect in claude — delete the entry from .mcp.json by hand"
          : "already in .mcp.json (the standard is its file)",
      });
    }
    return report;
  }

  // The file's own format decides the writer: never JSON.parse a .toml.
  if (target.endsWith(".toml")) mergeToml(absPath, row, servers, report, projectRoot);
  else mergeJson(absPath, row, servers, report, projectRoot);

  return report;
}

// First existing candidate wins; else the first candidate (which we create).
function resolveTarget(projectRoot, row) {
  for (const candidate of row.target_files) {
    if (existsSync(join(projectRoot, candidate))) return candidate;
  }
  return row.target_files[0];
}

// ── Per-server classification ─────────────────────────────────────────
// Decide the desired state for one owned name before any I/O.
//   entry  — write this entry (a translated entry, or the off switch).
//   absent — disabled where the target has no off switch: absence is the
//            only real off switch (remove any stale entry).
//   refuse — cannot be fully expressed here: do not write; leave alone.
function classifySpec(spec, row) {
  const disabled = spec?.disabled;
  if (disabled && !row.has_off_switch) {
    return { kind: "absent", reason: describeRefusal(spec, row) };
  }
  if (disabled && row.has_off_switch) {
    return { kind: "entry", entry: offSwitchEntry(row), note: "disabled: off switch written" };
  }
  const entry = translateEntry(spec, row);
  if (entry === null) {
    return { kind: "refuse", reason: describeRefusal(spec, row) };
  }
  return { kind: "entry", entry, note: droppedDefaultsNote(spec, row) };
}

// Under the "env-vars" syntax a ${VAR:-default} loses its fallback and the
// variable becomes required — worth a note on the written entry.
function droppedDefaultsNote(spec, row) {
  if (row.var_syntax !== "env-vars") return undefined;
  const { droppedDefaults } = expressibleVars(spec);
  if (droppedDefaults.length === 0) return undefined;
  return `dropped defaults (set explicitly): ${droppedDefaults.join(", ")}`;
}

// ── JSON merge (claude-code, opencode, cursor) ────────────────────────
function mergeJson(absPath, row, servers, report, projectRoot) {
  // Write-layer guard: never rewrite the source of truth, whatever row is
  // driving us, and never write outside the project tree. Refuse and
  // report rather than write.
  if (!writeTargetGuard(absPath, projectRoot, report)) return;
  const exists = existsSync(absPath);
  let raw = "";
  if (exists) {
    try {
      raw = readFileSync(absPath, "utf-8");
    } catch {
      report.errors.push(`${report.target}: unreadable; refusing to edit`);
      return;
    }
  }

  // `.jsonc` or anything that is not plain JSON is never edited (ruling 4).
  if (report.target.endsWith(".jsonc")) {
    report.errors.push(`${report.target} is not plain JSON (JSONC); refusing to edit`);
    return;
  }
  let doc;
  if (raw.trim() === "") {
    doc = {};
  } else {
    try {
      doc = JSON.parse(raw);
    } catch {
      report.errors.push(`${report.target} is not plain JSON (JSONC); refusing to edit`);
      return;
    }
    if (!isPlainObject(doc)) {
      report.errors.push(`${report.target} has the wrong shape (root is not an object); refusing to edit`);
      return;
    }
  }

  const sectionKey = row.section;
  let section;
  if (hasOwn(doc, sectionKey)) {
    section = doc[sectionKey];
    if (!isPlainObject(section)) {
      report.errors.push(`${report.target}: "${sectionKey}" is not an object; refusing to edit`);
      return;
    }
  } else {
    section = {};
  }

  let changed = false;
  for (const [name, spec] of Object.entries(servers ?? {})) {
    const existing = hasOwn(section, name) ? section[name] : undefined;

    const c = classifySpec(spec, row);
    if (c.kind === "absent") {
      let detail = c.reason;
      if (existing !== undefined) {
        delete section[name];
        changed = true;
        detail += " (removed existing entry to disable)";
      }
      report.written.push({ name, action: "disabled-skipped", detail });
      continue;
    }
    if (c.kind === "refuse") {
      report.written.push({ name, action: "refused", detail: c.reason });
      continue;
    }

    const desired = c.entry;
    let action;
    if (existing === undefined) {
      setOwn(section, name, desired);
      changed = true;
      action = "added";
    } else if (deepEqual(existing, desired)) {
      action = "kept";
    } else {
      setOwn(section, name, desired);
      changed = true;
      action = "updated";
    }
    report.written.push({ name, action, detail: c.note });
  }

  if (changed) {
    setOwn(doc, sectionKey, section);
    writeTargetFile(absPath, JSON.stringify(doc, null, 2) + "\n", report);
  }
}

// ── TOML merge (codex) ────────────────────────────────────────────────
// Rebuild only our `[mcp_servers.<name>]` fragments (a marker pair each),
// leaving the rest of the file byte-for-byte. We never re-serialise the
// whole file and never JSON.parse a .toml.
function mergeToml(absPath, row, servers, report, projectRoot) {
  // Write-layer guard: never rewrite the source of truth, whatever row is
  // driving us, and never write outside the project tree. Refuse and
  // report rather than write.
  if (!writeTargetGuard(absPath, projectRoot, report)) return;
  const exists = existsSync(absPath);
  let raw;
  try {
    raw = exists ? readFileSync(absPath, "utf-8") : "";
  } catch {
    // Mirror the JSON path: an unreadable target is a target-level
    // failure, reported — never a thrown stack trace that would abort
    // every remaining named agent (PDR-139's report contract).
    report.errors.push(`${report.target}: unreadable; refusing to edit`);
    return;
  }
  const decisions = new Map();
  for (const [name, spec] of Object.entries(servers ?? {})) {
    // A name the marker machinery cannot key byte-exactly is refused here
    // (never written, never removed) — see markerSafeName below.
    decisions.set(name, markerSafeName(name) ? classifySpec(spec, row) : unsafeNameRefusal(name));
  }
  // Refused names keep whatever is there (never destroy user config we cannot
  // faithfully regenerate). Everything else is managed: written or removed.
  const managed = new Set();
  for (const [name, c] of decisions) if (c.kind !== "refuse") managed.add(name);

  const { foreign, blocks, malformed } = splitToml(raw.split("\n"), managed);

  // A malformed marker pair (unterminated begin / orphan end) means the file
  // is not safely ours to rewrite. Report and leave it untouched — data loss
  // in a user's config is never acceptable.
  if (malformed.length > 0) {
    for (const m of malformed) report.errors.push(`${report.target}: ${m}; refusing to edit`);
    return;
  }

  let changed = false;
  const fresh = [];
  for (const [name, c] of decisions) {
    const prior = blocks.get(name);
    if (c.kind === "refuse") {
      report.written.push({ name, action: "refused", detail: c.reason });
      continue;
    }
    if (c.kind === "absent") {
      let detail = c.reason;
      if (prior !== undefined) {
        changed = true;
        detail += " (removed existing entry to disable)";
      }
      report.written.push({ name, action: "disabled-skipped", detail });
      continue;
    }
    const block = buildTomlBlock(name, c.entry);
    let action;
    if (prior === undefined) {
      action = "added";
      changed = true;
    } else if (sameBlock(prior, block)) {
      action = "kept";
    } else {
      action = "updated";
      changed = true;
    }
    fresh.push(block);
    report.written.push({ name, action, detail: c.note });
  }

  if (!changed) return; // nothing to write — leave the file byte-for-byte

  const cleaned = normaliseToml(foreign);
  const body = fresh.join("\n\n");
  const newContent = cleaned
    ? (body ? `${cleaned}\n\n${body}\n` : `${cleaned}\n`)
    : (body ? `${body}\n` : "");
  writeTargetFile(absPath, newContent, report);
}

// Split TOML lines into foreign lines (kept verbatim) and the owned blocks to
// regenerate/remove, keyed by name. The marker scan is bounded — it stops at
// the next begin-mark or a table header — so an unterminated pair can never
// swallow a user's remaining config; that is reported as malformed instead.
function splitToml(lines, managed) {
  const foreign = [];
  const blocks = new Map();
  const malformed = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const bn = beginMarkName(line);
    if (bn !== null) {
      const block = [line];
      let j = i + 1;
      let terminated = false;
      while (j < lines.length) {
        const l = lines[j];
        if (endMarkName(l) === bn) { block.push(l); j++; terminated = true; break; }
        if (beginMarkName(l) !== null) break; // next begin-mark bounds it
        // A table header bounds it too — but not the block's own header.
        if (TABLE_HEAD_RE.test(l) && tableName(l) !== bn) break;
        block.push(l); j++;
      }
      if (!terminated) {
        malformed.push(`unterminated marker block for "${bn}"`);
        foreign.push(...block); // preserve what we scanned; nothing is lost
        i = j;
        continue;
      }
      // A bare `enabled = <bool>` block is still a tool-owned name (ADR-455):
      // it is regenerated like any other owned body, never kept as an
      // override — the off switch is `disabled` in .mcp.json.
      if (managed.has(bn)) {
        blocks.set(bn, block.join("\n")); // ours to regenerate or remove
      } else {
        foreign.push(...block); // not managed — leave alone
      }
      i = j;
      continue;
    }
    const tn = tableName(line);
    if (tn !== null && managed.has(tn)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length
             && !TABLE_HEAD_RE.test(lines[j])
             && beginMarkName(lines[j]) === null
             && endMarkName(lines[j]) === null) {
        block.push(lines[j++]);
      }
      blocks.set(tn, block.join("\n")); // ours to regenerate or remove
      i = j;
      continue;
    }
    // An end-mark outside any block is an orphan half-pair — malformed.
    if (endMarkName(line) !== null) malformed.push(`orphan end marker "${line.trim()}"`);
    foreign.push(line);
    i++;
  }
  return { foreign: foreign.join("\n"), blocks, malformed };
}

function buildTomlBlock(name, entry) {
  const lines = [beginMark(name), `[mcp_servers.${tomlKey(name)}]`];
  for (const [k, v] of Object.entries(entry)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  lines.push(endMark(name));
  return lines.join("\n");
}

function normaliseToml(text) {
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trimEnd();
}

const BEGIN_RE = /^#\s*adlc-mcp-begin\s+(.+?)\s*$/;
const END_RE = /^#\s*adlc-mcp-end\s+(.+?)\s*$/;
const TABLE_RE = /^\s*\[mcp_servers\.([^\]]+)\]\s*(?:#.*)?$/;
const TABLE_HEAD_RE = /^\s*\[/; // any TOML table header (bounds a marker block)

// ── Marker keys: one line, byte-exact ──────────────────────────────────
// The marker comment is the ownership key read back on the next run, so a
// name must round-trip byte-exactly through a single comment line:
//   - a control character (notably a raw newline) would END the comment
//     and turn the rest of the name into live TOML — an injection channel
//     from a hostile .mcp.json straight into codex's project config;
//   - leading/trailing whitespace is stripped by BEGIN_RE/END_RE when the
//     marker is read back, which mis-keys the block: the next run cannot
//     find its own entry and would emit a second table for the same name
//     (invalid TOML).
// Such a name cannot be owned in a TOML target: refused per-server,
// never written, never removed. JSON targets key on the exact string and
// have no marker surface — they keep such names (pinned by tests).
function markerSafeName(name) {
  if (name.length === 0 || name !== name.trim()) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return false; // C0 controls + DEL
  }
  return true;
}
function unsafeNameRefusal(name) {
  return {
    kind: "refuse",
    reason: `name ${JSON.stringify(name)} cannot be owned in a TOML target: marker keys must be one line (no control characters, no leading/trailing whitespace)`,
  };
}

// Names reaching these passed markerSafeName at classification time, so
// the interpolation is byte-exact and can never inject into the comment.
const beginMark = (name) => `# adlc-mcp-begin ${name}`;
const endMark = (name) => `# adlc-mcp-end ${name}`;
const beginMarkName = (line) => (BEGIN_RE.exec(line)?.[1] ?? null);
const endMarkName = (line) => (END_RE.exec(line)?.[1] ?? null);
function tableName(line) {
  const m = TABLE_RE.exec(line);
  return m ? unquoteKey(m[1].trim()) : null;
}

// Does the resolved target path land on the protected source .mcp.json?
// Lexical check — enough for the claude-code no-op dispatch above (its
// target IS the source by construction). The write layer needs the
// symlink-aware version below.
function isSourcePath(absPath, projectRoot) {
  return resolve(absPath) === resolve(projectRoot, MCP_SOURCE);
}

// ── Write-layer guard: judge the write by where it LANDS ──────────────
// Two invariants, checked on a realpath basis (symlinks followed) so a
// link cannot redirect a write past them:
//   - the real target is never the real .mcp.json — the source of truth
//     is never rewritten, whatever row drives us (ADR-455/PDR-139);
//   - the real target stays inside the project tree — a link out of the
//     tree would make the tool write files the project does not own.
// A dangling symlink is refused outright: its destination is unknowable,
// and writing through it would create a file nobody declared. Same
// refusal channel as every target-level failure: report, never throw.
function writeTargetGuard(absPath, projectRoot, report) {
  const refuse = (reason) => {
    report.errors.push(`${report.target}: ${reason}`);
    return false;
  };
  let real;
  try {
    real = realpathSync(absPath);
  } catch {
    // ENOENT covers both "not created yet" and "dangling symlink" —
    // lstat tells them apart.
    if (isDanglingSymlink(absPath)) {
      return refuse("is a dangling symlink; refusing to write through it");
    }
    real = realPathOfCreation(absPath);
  }
  const root = realPathOfCreation(projectRoot);
  const source = realSourcePath(projectRoot);
  if (source !== null && real === source) {
    return refuse(`is the source of truth (${MCP_SOURCE}); refusing to write`);
  }
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return refuse("resolves outside the project (symlink redirect); refusing to write");
  }
  return true;
}

function isDanglingSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false; // nothing there at all
  }
}

// realpath of the path, or of its nearest existing ancestor with the
// not-yet-created tail appended — a file about to be CREATED is judged
// by where mkdir/write would land (a symlinked parent directory still
// resolves; only an unresolvable gap falls back to the lexical path).
function realPathOfCreation(absPath) {
  const tail = [];
  let current = absPath;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absPath; // filesystem root: give up, lexical
      tail.push(basename(current));
      current = parent;
    }
  }
}

// The real .mcp.json, or null when it does not exist — an absent source
// cannot be equal to anything, so the guard skips that comparison.
function realSourcePath(projectRoot) {
  try {
    return realpathSync(join(projectRoot, MCP_SOURCE));
  } catch {
    return null;
  }
}

// Create the target's directory and write the content, converting I/O
// failures into a target-level error — never a crash that would abort
// every remaining named agent (PDR-139's report contract). On failure
// nothing was written, so no per-server outcome is claimed either: the
// report degrades to the documented errors[]-only refusal shape.
function writeTargetFile(absPath, content, report) {
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
  } catch (e) {
    report.errors.push(`${report.target}: write failed (${e.code ?? e.message}); file left untouched`);
    report.written.length = 0;
  }
}

function sameBlock(a, b) {
  return String(a).trim() === String(b).trim();
}

// ── TOML value rendering ──────────────────────────────────────────────
function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}
// TOML basic strings escape backslash and quote, and every control
// character must be escaped too (\n \r \t by name, the rest \uXXXX): a
// raw control character makes the WHOLE file unparseable — bricking the
// agent's config while the run reports success. describeRefusal
// deliberately allows such values (multiline PEMs, JSON blobs in env),
// so this renderer is the only place the written file can be kept valid.
function tomlString(s) {
  let out = "";
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code <= 0x1f || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return `"${out}"`;
}
function tomlValue(v) {
  if (typeof v === "string") return tomlString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (isPlainObject(v)) {
    const inner = Object.entries(v).map(([k, val]) => `${tomlKey(k)} = ${tomlValue(val)}`).join(", ");
    return `{ ${inner} }`;
  }
  return tomlString(String(v));
}
function unquoteKey(k) {
  if (k.startsWith('"') && k.endsWith('"')) {
    return k.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return k;
}

// ── Small object helpers (own-key safe) ───────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function hasOwn(obj, key) {
  return Object.hasOwn(obj, key);
}
function setOwn(obj, key, val) {
  // defineProperty sets an own key even for "__proto__" without triggering
  // the prototype setter.
  Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
}

// Order-insensitive structural equality (compares keys/values, not order).
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}
