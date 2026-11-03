// The copy-once gap report (PDR-140).
//
// The team's .mcp.json is the upstream declaration; the project's .mcp.json
// is the copy made once. When the upstream declares servers the copy lacks,
// that drift is REPORTED — never written, never blocking, never a merge.
//
// ── A missing team source is itself reported ──────────────────────────
// teamSourceUnavailable is true whenever the team's .mcp.json cannot be
// located or read (not configured, not cloned, unparseable, wrong shape).
// A report that quietly reports nothing is worse than no report — the gap
// never degrades to "no gap" just because the upstream went missing.
//
// ── Purity split ──────────────────────────────────────────────────────
// reportGap locates and parses the team's .mcp.json (I/O, via
// readTeamAiDirectives); the comparison itself is pure (diffGap), so it
// stays testable without fixtures. Nothing here writes anything — the
// no-write property of the whole command is pinned by the install tests.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandTilde } from "../source.mjs";
import { readTeamAiDirectives } from "../utils/init-options.mjs";
import { expressibleVars } from "./translate.mjs";

const MCP_SOURCE = ".mcp.json";

/**
 * Compare the project's server map against the team's declared one.
 *
 * @param {{projectRoot: string, servers: object}} args
 *   `servers` is the project's parsed .mcp.json mcpServers map.
 * @returns {{missing: string[], notCarried: string[], teamSourceUnavailable: boolean}}
 *   missing — team-declared server names the project lacks;
 *   notCarried — top-level keys in the team's .mcp.json that no target
 *   carries (its "tools" block; settled decision 4: never an error, never
 *   silently dropped);
 *   teamSourceUnavailable — the team's .mcp.json could not be read at all.
 */
export function reportGap({ projectRoot, servers }) {
  const teamDir = readTeamAiDirectives(projectRoot);
  if (!teamDir) return unavailable();
  const teamPath = join(resolve(projectRoot, expandTilde(teamDir)), MCP_SOURCE);
  if (!existsSync(teamPath)) return unavailable();
  let doc;
  try {
    doc = JSON.parse(readFileSync(teamPath, "utf-8"));
  } catch {
    return unavailable();
  }
  // A root or mcpServers of the wrong shape cannot be compared honestly —
  // report the source as unavailable rather than guess at its meaning.
  if (!isPlainObject(doc)) return unavailable();
  if (doc.mcpServers !== undefined && !isPlainObject(doc.mcpServers)) return unavailable();
  return diffGap(servers, doc);
}

/**
 * The pure comparison: team-declared names the project lacks, and team
 * top-level keys no target carries. `mcpServers` is the only key any
 * target reads; every other top-level key in the team's file is reported
 * as not carried.
 */
export function diffGap(projectServers, teamDoc) {
  const teamServers = isPlainObject(teamDoc?.mcpServers) ? teamDoc.mcpServers : {};
  const declared = new Set(Object.keys(projectServers ?? {}));
  const missing = Object.keys(teamServers).filter((name) => !declared.has(name));
  const notCarried = Object.keys(teamDoc).filter((key) => key !== "mcpServers");
  return { missing, notCarried, teamSourceUnavailable: false };
}

/**
 * Per-server ${VAR:-default} fallbacks that do not survive translation
 * into targets without default support — the "set these explicitly"
 * carry. Which targets drop them is the caller's knowledge (the registry
 * rows); this stays a pure function of the server specs.
 */
export function droppedDefaults(servers) {
  const out = [];
  for (const [name, spec] of Object.entries(servers ?? {})) {
    const { droppedDefaults: vars } = expressibleVars(spec);
    if (vars.length > 0) out.push({ server: name, vars });
  }
  return out;
}

function unavailable() {
  return { missing: [], notCarried: [], teamSourceUnavailable: true };
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
