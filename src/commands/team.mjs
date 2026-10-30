// Team commands: setup, update, repair for team-ai-directives lifecycle.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readInitOptions, writeInitOptions, readAgent, readTeamAiDirectives } from "../utils/init-options.mjs";
import { findInstalledSkills, expandTilde } from "../source.mjs";
import { getAgent } from "../registry.mjs";
import { cmdAdd, cmdUpdate } from "./skills.mjs";
import { cmdMcpInstall } from "./mcp.mjs";
import { error, failure, note } from "../ui/index.mjs";

// ── mcp install chaining ────────────────────────────────────────────────
// `team setup`/`team update` configure the agent's MCP servers before its
// session starts — a named agent that would start without its servers is
// never reported as success (PDR-138/139). CLI-to-CLI chaining only: the
// skill prose never orchestrates this.

/**
 * Resolve the team-setup helper script `team-helpers.sh` from the installed
 * skills. Repo sibling (adlc-team-skills checkout next to the directives),
 * then the agent's installed skills dir (same two-tier convention as
 * cmdTeamRepair's setup-team.sh candidates).
 */
function resolveTeamSetupScript(projectRoot, agent) {
  const teamDir = readTeamAiDirectives(projectRoot);
  const candidates = [];
  if (teamDir) {
    candidates.push(
      resolve(join(teamDir, "..", "adlc-team-skills", "skills", "team", "team-setup", "scripts", "bash", "team-helpers.sh")),
    );
  }
  if (agent) {
    const skillsDir = agent.skills_dir;
    if (skillsDir) {
      candidates.push(
        resolve(projectRoot, expandTilde(skillsDir), "team-setup", "scripts", "bash", "team-helpers.sh"),
      );
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Probe a `team-helpers.sh` for `--wire` support (Phase 2 skills-repo flag).
 * Older script copies lack the flag; the documented interim 6-path JS check
 * applies instead.
 */
function scriptSupportsWire(scriptPath) {
  const probe = spawnSync("bash", [scriptPath, "--help"], { encoding: "utf-8" });
  const help = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  return help.includes("--wire");
}

/**
 * Interim 6-path structure check — the Verification list inlined while the
 * installed skill copy predates the Phase 2 `--wire` flag. Deleted in
 * Phase 3 when `--wire` invocation becomes unconditional.
 */
function interimValidateDirectives(teamDir) {
  const missing = [];
  for (const rel of [
    "context_modules/constitution.md",
    "context_modules/rules",
    "context_modules/personas",
    "context_modules/examples",
    "CDR.md",
    ".skills.json",
  ]) {
    if (!existsSync(join(teamDir, rel))) missing.push(rel);
  }
  return missing;
}
/**
 * Run `mcp install` for one agent as part of a team command, aborting the
 * command when it fails (ruling 1a).
 *
 * Thin by design: every decision — the missing-source no-op, the copy-once
 * gap report, refusals — already lives in (and is tested on) cmdMcpInstall.
 * Do not pre-check for `.mcp.json` here; the chained run must behave exactly
 * like the standalone command (ruling 3: the gap report runs chained too).
 *
 * @param {string} projectRoot project dir holding `.mcp.json`.
 * @param {string} agentKey registry key of the committed agent.
 * @param {string} label the aborting message names the team command.
 * @returns {Promise<number>} 0 the agent is configured, 1 otherwise.
 */
export async function chainMcpInstall(projectRoot, agentKey, label) {
  const code = await cmdMcpInstall([projectRoot], { agents: [agentKey] });
  if (code !== 0) failure(`MCP install failed — aborting ${label}`);
  return code;
}

// ── setup ──────────────────────────────────────────────────────────────
export async function cmdTeamSetup(args, flags) {
  const source = args[0];
  if (!source) {
    error("source is required");
    return 1;
  }

  const agentKey = flags.agents[0] || readAgent();
  if (!agentKey) {
    error("Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  writeInitOptions({ agent: agentKey, skills_source: source });
  const projectRoot = resolve(flags.cwd ?? process.cwd());

  if (!flags.skipSkills) {
    const agent = getAgent(agentKey);
    if (agent) {
      const skillsDir = flags.global ? agent.global_skills_dir : agent.skills_dir;
      if (skillsDir) {
        const skills = await findInstalledSkills(skillsDir, process.cwd());
        if (skills.length === 0) {
          const code = await cmdAdd([source], { agents: [agentKey], yes: flags.yes });
          if (code !== 0) {
            failure("Skills installation failed — aborting team setup");
            return code || 1;
          }
        }
      }
    }
  }

  // ── Deterministic wiring: --directives <path> (headless-safe) ─────────
  // A known directives path wires without any agent session — the
  // ADR-386-amendment follow-up. This never spawns an LLM: it validates the
  // structure via the skill-owned script (or the interim JS check when the
  // installed skill copy predates the Phase 2 --wire flag), then resolves
  // the absolute path and persists it exactly like the script does.
  if (flags.directives) {
    const directivesArg = flags.directives;
    if (!existsSync(directivesArg)) {
      error(`team-ai-directives directory not found: ${directivesArg}`);
      return 1;
    }
    const teamDir = resolve(directivesArg);

    const agent = getAgent(agentKey);
    const script = resolveTeamSetupScript(projectRoot, agent);
    let wireCode;
    if (script && scriptSupportsWire(script)) {
      const wired = spawnSync("bash", [script, "--wire", teamDir], {
        stdio: "inherit",
        env: { ...process.env, PROJECT_ROOT: projectRoot },
      });
      wireCode = wired.status ?? 1;
    } else {
      // Interim: installed skill predates --wire. Inline the same 6-path
      // Verification-list check (deleted in Phase 3).
      const missing = interimValidateDirectives(teamDir);
      if (missing.length > 0) {
        for (const rel of missing) console.log(`MISSING: ${rel}`);
        error(`INVALID team-ai-directives at ${teamDir} — missing ${missing.length} required path(s), not wired`);
        return 1;
      }
      writeInitOptions({ team_ai_directives: teamDir }, projectRoot);
      console.log(`WIRED team_ai_directives=${teamDir}`);
      wireCode = 0;
    }
    if (wireCode !== 0) return wireCode;

    // The wired directives are now configured, so the gap report reads them.
    const mcpCodeWire = await chainMcpInstall(projectRoot, agentKey, "team setup");
    if (mcpCodeWire !== 0) return mcpCodeWire;
    return 0;
  }

  // No --directives and no TTY: the interactive skill below cannot ask its
  // mode-selection questions, and spawning it headlessly hangs until the
  // agent-run timeout. Fail loudly with the deterministic alternative.
  if (!process.stdin.isTTY) {
    error("team setup needs interactive mode selection, but stdin is not a TTY.");
    error(`Re-run with an explicit path: adlc-cli team setup ${source} -a ${agentKey} --directives <path> [--skip-skills]`);
    return 1;
  }

  // Configure the agent's MCP servers before its session starts — an agent
  // that would start without its servers is never reported as success
  // (PDR-138/139). The chained run is the full mcp install behavior, gap
  // report included (ruling 3); a failure aborts the command (ruling 1a).
  const mcpCode = await chainMcpInstall(resolve(flags.cwd ?? process.cwd()), agentKey, "team setup");
  if (mcpCode !== 0) return mcpCode;

  const { cmdAgentRun, runAgentInteractive } = await import("./agent.mjs");
  const prompt = "Run /team-setup to configure team-ai-directives for this project";

  // The /team-setup skill is an interactive wizard (mode selection +
  // confirm). We own a real terminal here (non-TTY returned above), so hand
  // off to the agent's interactive UI with the prompt seeded; profiles
  // without an interactive form fall through to the headless run.
  const interactiveEligible = !flags.format && process.stdin.isTTY && process.stdout.isTTY;
  if (interactiveEligible) {
    note("Opening an interactive session for /team-setup — answer the mode question there.");
    const code = await runAgentInteractive(agentKey, prompt, { cwd: flags.cwd ?? process.cwd() });
    if (code !== null) return code;
    // profile has no interactive form → fall through to headless
  }

  const runArgs = ["-a", agentKey, "--timeout", "300"];
  if (flags.format) runArgs.push("--format", flags.format);
  if (flags.cwd) runArgs.push("--cwd", flags.cwd);
  runArgs.push(prompt);
  return cmdAgentRun(runArgs);
}

// ── update ─────────────────────────────────────────────────────────────
export async function cmdTeamUpdate(args, flags) {
  const opts = readInitOptions();
  const teamDir = opts.team_ai_directives;
  const source = opts.skills_source;
  if (!teamDir || !source) {
    error("team-ai-directives not configured. Run 'adlc-cli team setup' first.");
    return 1;
  }

  const pullResult = spawnSync("git", ["-C", teamDir, "pull"], { stdio: "inherit" });
  if (pullResult.status !== 0) {
    failure(`git pull failed for ${teamDir}`);
    return pullResult.status || 1;
  }

  const updateCode = await cmdUpdate([], { ...flags, pull: true });
  if (updateCode !== 0) {
    failure("Skills update failed — aborting team update");
    return updateCode || 1;
  }

  // The agent's MCP servers are (re)configured from .mcp.json before the
  // repair pass; an MCP failure aborts the update before repair runs
  // (ruling 1a). The agent is the one team-setup recorded (`-a` wins).
  const agentKey = flags.agents?.[0] || opts.agent;
  const mcpCode = await chainMcpInstall(process.cwd(), agentKey, "team update");
  if (mcpCode !== 0) return mcpCode;

  return cmdTeamRepair([], { updateConfidence: true });
}

// ── repair ────────────────────────────────────────────────────────────
export async function cmdTeamRepair(args, flags) {
  if (flags.updateConfidence || flags.validateDrafts) {
    const teamDir = readTeamAiDirectives() || "team-ai-directives";
    const scriptCandidates = [
      resolve(join(teamDir, "..", "adlc-team-skills", "skills", "team", "team-repair", "scripts", "bash", "setup-team.sh")),
      resolve(join(".agents", "skills", "team-repair", "scripts", "bash", "setup-team.sh")),
    ];

    let scriptPath = null;
    for (const candidate of scriptCandidates) {
      if (existsSync(candidate)) {
        scriptPath = candidate;
        break;
      }
    }

    if (!scriptPath) {
      error("setup-team.sh not found. Run 'adlc-cli team setup' first.");
      return 1;
    }

    const scriptArgs = flags.validateDrafts ? ["--validate-drafts"] : ["--update-confidence"];
    // Git Bash treats backslashes as escape characters, so hand it a
    // forward-slash path on Windows (same convention as dispatcher.mjs's
    // sh branch); POSIX paths pass through untouched.
    const bashScript = process.platform === "win32" ? scriptPath.replace(/\\/g, "/") : scriptPath;
    const result = spawnSync("bash", [bashScript, ...scriptArgs], { stdio: "inherit" });
    // ?? not ||: a successful script (status 0) is success — `0 || 1` made
    // every successful repair (and therefore every successful `team update`)
    // exit 1.
    return result.status ?? 1;
  }

  const agentKey = flags.agents[0] || readAgent();
  if (!agentKey) {
    error("Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  const prompt = flags.buildToDelete
    ? "Run /team-repair --build-to-delete"
    : "Run /team-repair";
  const runArgs = ["-a", agentKey];
  if (flags.format) runArgs.push("--format", flags.format);
  if (flags.cwd) runArgs.push("--cwd", flags.cwd);
  runArgs.push(prompt);
  return cmdAgentRun(runArgs);
}
