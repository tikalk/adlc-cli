// `adlc-cli mcp install` — materialise the project's `.mcp.json` into each
// NAMED agent's own MCP config. The command is the promise surface
// (PDR-138/139): exit 0 only when every named agent is configured; on any
// failure it exits 1 naming the agent, the target file and the reason.
//
// ── Precondition (PDR-139) ────────────────────────────────────────────
// team-setup has run, observable as `.adlc/init-options.json` naming the
// agent. `--agent`/`-a`/`--agents` overrides it. Nothing is ever silently
// defaulted to claude — an unknown agent target is a loud failure, not a
// quiet no-op.
//
// ── Naming an agent is a commitment ───────────────────────────────────
// Only `MCP_AGENTS` keys get a file written. A named agent outside that set
// gets nothing written and the servers listed for hand-install on stderr
// ("add these by hand", PDR-138 scope-out) with the run failing. An agent
// never named is simply out of scope.
//
// ── Two failure channels, one exit code ───────────────────────────────
// installForAgent reports target-level `errors[]` (file left untouched) and
// per-server `refused` entries. Either fails the run: a named agent that
// will start without its servers is never reported as success. The exit
// contract is 0 | 1 only — never 3 (workflow.mjs reserves it for PAUSED).
//
// `.mcp.json` is the source of truth and is never rewritten here;
// `claude-code` is therefore a no-op that reports every server kept.
//
// ── The copy-once gap report (PDR-140) ────────────────────────────────
// After the install, the team's .mcp.json (the upstream declaration) is
// compared against the project's (the copy). What the copy lacks is
// reported as a warning — never written, never blocking — so it can never
// change the exit code. A missing team source is itself reported: a
// report that quietly reports nothing is worse than no report.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { droppedDefaults, reportGap } from "../mcp/gap.mjs";
import { installForAgent } from "../mcp/install.mjs";
import { getMcpAgent, MCP_AGENTS } from "../registry.mjs";
import { readAgent } from "../utils/init-options.mjs";
import {
  out,
  err,
  error,
  failure,
  success,
  section,
  item,
  sym,
} from "../ui/index.mjs";

const MCP_SOURCE = ".mcp.json";
const INIT_OPTIONS = ".adlc/init-options.json";
const SUPPORTED = Object.keys(MCP_AGENTS).join(", ");

/**
 * `adlc-cli mcp install [DIR] --agent NAME` — write each named agent's MCP
 * config from the project's `.mcp.json`.
 *
 * @param {string[]} args positional args; `args[0]` is the project dir (default: cwd).
 * @param {object} flags parsed flags; `flags.agents` names the committed agents.
 * @returns {Promise<number>} 0 when every named agent is configured, 1 otherwise.
 */
export async function cmdMcpInstall(args = [], flags = {}) {
  const projectRoot = resolve(args[0] ?? process.cwd());

  // Precondition: an agent must be named before anything can be delivered.
  // --agent/-a/--agents wins; else the agent team-setup recorded; else fail
  // loudly — never silently default to claude (PDR-139).
  const named = Array.isArray(flags.agents) ? [...flags.agents] : [];
  if (named.some((agent) => !agent)) {
    error(`--agent requires a NAME (${SUPPORTED})`);
    return 1;
  }
  if (named.length === 0) {
    const recorded = readAgent(projectRoot);
    if (recorded) {
      named.push(recorded);
    } else {
      if (existsSync(join(projectRoot, INIT_OPTIONS))) {
        error(`no agent available: ${INIT_OPTIONS} records none and no --agent was given`);
      } else {
        error(`team-setup has not run: ${INIT_OPTIONS} is missing and no --agent was given`);
      }
      err(`Run 'adlc-cli team setup' first, or pass --agent NAME (${SUPPORTED}).`);
      return 1;
    }
  }

  // Read the source of truth. Its absence is a legitimate no-op: there is
  // nothing to install and nobody was promised anything.
  const sourcePath = join(projectRoot, MCP_SOURCE);
  if (!existsSync(sourcePath)) {
    out(`nothing to install: no ${MCP_SOURCE} in ${projectRoot}`);
    // The copy-once contract is drift detection, not an install
    // postscript: a project that has not copied yet lacks every
    // team-declared server, and never-blocking means exit stays 0.
    printGapReport(projectRoot, {}, named);
    return 0;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(sourcePath, "utf-8"));
  } catch {
    error(`${MCP_SOURCE} is not plain JSON; refusing to install from it`);
    return 1;
  }
  if (!isPlainObject(doc)) {
    error(`${MCP_SOURCE} has the wrong shape (root is not an object); refusing to install from it`);
    return 1;
  }
  // Lenient source validation: only `mcpServers` is translated; unknown
  // top-level keys are never an error (the team file ships a "tools" block).
  const servers = doc.mcpServers ?? {};
  if (!isPlainObject(servers)) {
    error(`${MCP_SOURCE}: "mcpServers" is not an object; refusing to install from it`);
    return 1;
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    out(`nothing to install: ${MCP_SOURCE} declares no servers`);
    printGapReport(projectRoot, servers, named);
    return 0;
  }

  // Deliver per named agent; what can be delivered still is, and the run
  // verdict below aggregates — one failure fails the whole run.
  const failedAgents = [];
  for (const agent of named) {
    const row = getMcpAgent(agent);
    if (!row) {
      failedAgents.push(agent);
      reportNoAdapter(agent, names);
      continue;
    }
    const report = installForAgent({ projectRoot, agent, servers });
    printReport(agent, report);

    const targetFailed = report.errors.length > 0;
    const refused = report.written.filter((w) => w.action === "refused").map((w) => w.name);
    if (targetFailed || refused.length > 0) {
      failedAgents.push(agent);
      // A named agent without one of its servers: say exactly what must be
      // added by hand, and where.
      reportByHand(report.target, targetFailed ? names : refused);
    }
  }

  // Copy-once gap report: additive warning lines after the install report,
  // before the verdict — it must never change the exit code (PDR-140).
  printGapReport(projectRoot, servers, named);

  if (failedAgents.length > 0) {
    failure(`MCP install failed for: ${failedAgents.join(", ")} — add the listed servers by hand`);
    return 1;
  }
  success("MCP install complete");
  return 0;
}

// One agent's result: the target it landed in and every server's outcome.
// Failures travel to stderr; the record itself is the human-facing result.
function printReport(agent, report) {
  section(`${agent} → ${report.target}`);
  for (const w of report.written) {
    const line = w.detail ? `${w.name} ${w.action} — ${w.detail}` : `${w.name} ${w.action}`;
    if (w.action === "refused") {
      failure(line);
    } else {
      item(line, { glyph: sym.success, color: "green" });
    }
  }
  for (const e of report.errors) {
    error(e);
  }
}

// A named agent with no adapter: nothing written, everything by hand.
// The target file is unknown for it — that is the point of saying so.
function reportNoAdapter(agent, names) {
  error(`no MCP adapter for "${agent}" (supported: ${SUPPORTED}); nothing was written`);
  err(`add these servers by hand to ${agent}'s MCP config (target file unknown — definitions are in ${MCP_SOURCE}):`);
  for (const name of names) err(`  ${name}`);
}

// A known target that could not take its servers: name the file and what
// belongs in it (PDR-139: agent, target file, reason).
function reportByHand(target, names) {
  err(`add these servers by hand to ${target}:`);
  for (const name of names) err(`  ${name}`);
}

// ── The copy-once gap report (PDR-140) ─────────────────────────────────
// Additive warning lines on stdout: they never change the exit code and
// never write anything. Silence when there is nothing to say; a missing
// team source is itself reported — a report that quietly reports nothing
// is worse than no report.
function printGapReport(projectRoot, servers, named) {
  const gap = reportGap({ projectRoot, servers });
  const lines = [];
  if (gap.teamSourceUnavailable) {
    lines.push(`team MCP source unavailable — gap not checked (team-ai-directives not configured or unreadable)`);
  }
  if (gap.missing.length > 0) {
    lines.push(`team declares servers missing from ${MCP_SOURCE}: ${gap.missing.join(", ")} (add them by hand if you want them)`);
  }
  if (gap.notCarried.length > 0) {
    lines.push(`team ${MCP_SOURCE} keys not carried to any target: ${gap.notCarried.join(", ")}`);
  }
  appendDroppedDefaults(lines, servers, named);
  if (lines.length === 0) return;
  section("MCP gap (warning only — nothing written, nothing blocked)");
  for (const line of lines) item(line, { glyph: sym.warn, color: "yellow" });
}

// ${VAR:-default} fallbacks are dropped by every variable syntax except
// "passthrough". The install report already carries the note for "env-vars"
// targets (droppedDefaultsNote in install.mjs prints it in the entry
// detail), so the gap report surfaces the drop only for the targets where
// it would otherwise stay silent.
function appendDroppedDefaults(lines, servers, named) {
  const targets = [...new Set(named.filter((agent) => {
    const row = getMcpAgent(agent);
    return row && (row.var_syntax === "env-braces" || row.var_syntax === "env-prefix");
  }))];
  if (targets.length === 0) return;
  for (const { server, vars } of droppedDefaults(servers)) {
    lines.push(`${server}: defaults dropped in translation to ${targets.join(", ")} — set explicitly: ${vars.join(", ")}`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
