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

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
