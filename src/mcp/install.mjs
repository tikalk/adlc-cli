// The merge engine for `adlc-cli mcp install`: materialise the .mcp.json
// server map into each agent's own config file, keyed on the server NAME.
//
// ── Ownership is the name ─────────────────────────────────────────────
// A name present in the .mcp.json `servers` map is tool-owned and
// regenerated every run, even if hand-edited. A name absent from it is
// never read, compared or written — everything else in the target is
// foreign and preserved (byte-for-byte where the format allows).
//
// ── Two failure channels (never mixed) ────────────────────────────────
//   errors[]  — target-level: unparseable / JSONC / wrong shape. The file
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
// .mcp.json itself is never rewritten; only the agent configs are.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getMcpAgent } from "../registry.mjs";
import { translateEntry, describeRefusal, offSwitchEntry, expressibleVars } from "./translate.mjs";

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

  // The file's own format decides the writer: never JSON.parse a .toml.
  if (target.endsWith(".toml")) mergeToml(absPath, row, servers, report);
  else mergeJson(absPath, row, servers, report);

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
function mergeJson(absPath, row, servers, report) {
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

    // A bare {"enabled": <bool>} override is the user's explicit switch on a
    // globally-defined server. Replacing it would re-enable what they turned
    // off — keep it untouched.
    if (existing !== undefined && isBareOffSwitch(existing)) {
      report.written.push({ name, action: "kept", detail: "existing off-switch override left untouched" });
      continue;
    }

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
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  }
}

// ── TOML merge (codex) ────────────────────────────────────────────────
// Rebuild only our `[mcp_servers.<name>]` fragments (a marker pair each),
// leaving the rest of the file byte-for-byte. We never re-serialise the
// whole file and never JSON.parse a .toml.
function mergeToml(absPath, row, servers, report) {
  const exists = existsSync(absPath);
  const raw = exists ? readFileSync(absPath, "utf-8") : "";
  const decisions = new Map();
  for (const [name, spec] of Object.entries(servers ?? {})) {
    decisions.set(name, classifySpec(spec, row));
  }
  // Refused names keep whatever is there (never destroy user config we cannot
  // faithfully regenerate). Everything else is managed: written or removed.
  const managed = new Set();
  for (const [name, c] of decisions) if (c.kind !== "refuse") managed.add(name);

  const { foreign, blocks } = splitToml(raw.split("\n"), managed);

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
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, newContent, "utf-8");
}

// Split TOML lines into foreign lines (kept verbatim) and the owned blocks
// (marker-delimited or a bare `[mcp_servers.<owned>]` table), keyed by name.
function splitToml(lines, managed) {
  const foreign = [];
  const blocks = new Map();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const bn = beginMarkName(line);
    if (bn !== null && managed.has(bn)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && endMarkName(lines[j]) !== bn) block.push(lines[j++]);
      if (j < lines.length) block.push(lines[j++]); // include the end mark
      blocks.set(bn, block.join("\n"));
      i = j;
      continue;
    }
    const tn = tableName(line);
    if (tn !== null && managed.has(tn)) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j]) && beginMarkName(lines[j]) === null) {
        block.push(lines[j++]);
      }
      blocks.set(tn, block.join("\n"));
      i = j;
      continue;
    }
    foreign.push(line);
    i++;
  }
  return { foreign: foreign.join("\n"), blocks };
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

const beginMark = (name) => `# adlc-mcp-begin ${name}`;
const endMark = (name) => `# adlc-mcp-end ${name}`;
const beginMarkName = (line) => (BEGIN_RE.exec(line)?.[1] ?? null);
const endMarkName = (line) => (END_RE.exec(line)?.[1] ?? null);
function tableName(line) {
  const m = TABLE_RE.exec(line);
  return m ? unquoteKey(m[1].trim()) : null;
}

function sameBlock(a, b) {
  return String(a).trim() === String(b).trim();
}

// ── TOML value rendering ──────────────────────────────────────────────
function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}
function tomlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

// A bare off-switch override: exactly {"enabled": <bool>} and nothing else.
function isBareOffSwitch(v) {
  return isPlainObject(v) && Object.keys(v).length === 1 && hasOwn(v, "enabled") && typeof v.enabled === "boolean";
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
