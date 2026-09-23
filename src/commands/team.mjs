// Team commands: setup, update, repair for team-ai-directives lifecycle.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readInitOptions, writeInitOptions, readAgent, readTeamAiDirectives } from "../utils/init-options.mjs";
import { findInstalledSkills } from "../source.mjs";
import { getAgent } from "../registry.mjs";
import { cmdAdd, cmdUpdate } from "./skills.mjs";

// ── setup ──────────────────────────────────────────────────────────────
export async function cmdTeamSetup(args, flags) {
  const source = args[0];
  if (!source) {
    console.error("Error: source is required");
    return 1;
  }

  const agentKey = flags.agents[0] || readAgent();
  if (!agentKey) {
    console.error("Error: Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  writeInitOptions({ agent: agentKey, skills_source: source });

  if (!flags.skipSkills) {
    const agent = getAgent(agentKey);
    if (agent) {
      const projectRoot = process.cwd();
      const skillsDir = flags.global ? agent.global_skills_dir : agent.skills_dir;
      if (skillsDir) {
        const skills = await findInstalledSkills(skillsDir, projectRoot);
        if (skills.length === 0) {
          const code = await cmdAdd([source], { agents: [agentKey], yes: flags.yes });
          if (code !== 0) {
            console.error("✗ Skills installation failed — aborting team setup");
            return code || 1;
          }
        }
      }
    }
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  const runArgs = ["-a", agentKey, "--timeout", "300"];
  if (flags.format) runArgs.push("--format", flags.format);
  if (flags.cwd) runArgs.push("--cwd", flags.cwd);
  runArgs.push("Run /team-setup to configure team-ai-directives for this project");
  return cmdAgentRun(runArgs);
}

// ── update ─────────────────────────────────────────────────────────────
export async function cmdTeamUpdate(args, flags) {
  const opts = readInitOptions();
  const teamDir = opts.team_ai_directives;
  const source = opts.skills_source;
  if (!teamDir || !source) {
    console.error("Error: team-ai-directives not configured. Run 'adlc-cli team setup' first.");
    return 1;
  }

  const pullResult = spawnSync("git", ["-C", teamDir, "pull"], { stdio: "inherit" });
  if (pullResult.status !== 0) {
    console.error(`✗ git pull failed for ${teamDir}`);
    return pullResult.status || 1;
  }

  const updateCode = await cmdUpdate([], { ...flags, pull: true });
  if (updateCode !== 0) {
    console.error("✗ Skills update failed — aborting team update");
    return updateCode || 1;
  }

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
      console.error("Error: setup-team.sh not found. Run 'adlc-cli team setup' first.");
      return 1;
    }

    const scriptArgs = flags.validateDrafts ? ["--validate-drafts"] : ["--update-confidence"];
    const result = spawnSync("bash", [scriptPath, ...scriptArgs], { stdio: "inherit" });
    return result.status || 1;
  }

  const agentKey = flags.agents[0] || readAgent();
  if (!agentKey) {
    console.error("Error: Agent required (-a <agent> or set in init-options.json)");
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
