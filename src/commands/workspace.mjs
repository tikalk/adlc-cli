// Workspace commands: setup (profile-driven), init (brownfield), status (audit).
// Setup separates deterministic steps (git clone, skills add — no LLM) from
// agent-led steps (workspace init/link, goal — via agent run).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml } from "../utils/yaml.mjs";
import { readAgent } from "../utils/init-options.mjs";

const PROFILE_PATH = ".adlc/workspace-profile.yml";

// ── setup ──────────────────────────────────────────────────────────────
export async function cmdWorkspaceSetup(args, flags) {
  const projectRoot = process.cwd();

  // 1. Resolve profile source: explicit arg > ADLC_WORKSPACE_PROFILE env > local file
  const explicit = args.find((a) => !a.startsWith("-"));
  const envProfile = (process.env.ADLC_WORKSPACE_PROFILE || "").trim();
  const source =
    explicit ||
    (envProfile !== "" ? envProfile : null) ||
    (existsSync(join(projectRoot, PROFILE_PATH)) ? PROFILE_PATH : null);

  if (!source) {
    console.error(
      "Error: no workspace profile found. Pass a path/URL, set ADLC_WORKSPACE_PROFILE, or create .adlc/workspace-profile.yml",
    );
    return 1;
  }

  // 2. Load profile (local file or HTTP)
  const content = await loadProfile(source, projectRoot);
  if (content === null) return 1;

  // 3. Parse + validate
  let profile;
  try {
    profile = parseYaml(content);
  } catch (err) {
    console.error(`Error: invalid workspace profile: ${err.message}`);
    return 1;
  }
  if (!profile || typeof profile !== "object" || !profile.schema_version) {
    console.error(`Error: workspace profile missing schema_version (${source})`);
    return 1;
  }

  // 4. Resolve agent: -a flag > profile.agent > init-options.json
  const agent = (flags.agents && flags.agents[0]) || profile.agent || readAgent();
  if (!agent) {
    console.error("Error: agent required (-a <agent>, profile agent:, or init-options.json)");
    return 1;
  }

  const dryRun = flags.dryRun || false;
  console.log(`Workspace profile: ${profile.name || source}`);
  console.log(`Agent: ${agent}${dryRun ? "  [dry-run]" : ""}`);

  const { cmdAgentRun } = await import("./agent.mjs");
  const { cmdAdd } = await import("./skills.mjs");
  const { cmdTeamSetup } = await import("./team.mjs");

  // 5. workspace.git — deterministic clones (no LLM)
  const gitModules = profile.workspace && profile.workspace.git;
  if (Array.isArray(gitModules) && gitModules.length > 0) {
    console.log(`\n┌─ workspace.git (${gitModules.length} repo(s))`);
    for (const mod of gitModules) {
      if (!mod || !mod.repo || !mod.path) {
        console.error("│  ✗ git entry missing repo or path");
        console.log(`└─ failed`);
        return 1;
      }
      const target = join(projectRoot, mod.path);
      if (existsSync(target)) {
        console.log(`│  = ${mod.path} (exists, skipping clone)`);
        continue;
      }
      const gitArgs = ["clone", mod.repo, mod.path];
      if (mod.branch) gitArgs.push("--branch", mod.branch);
      console.log(`│  $ git ${gitArgs.join(" ")}`);
      if (!dryRun) {
        const result = spawnSync("git", gitArgs, { stdio: "inherit", cwd: projectRoot });
        if (result.status !== 0) {
          console.error(`│  ✗ git clone failed for ${mod.path}`);
          console.log(`└─ failed`);
          return result.status || 1;
        }
        if (mod.ref) {
          const co = spawnSync("git", ["-C", mod.path, "checkout", mod.ref], {
            stdio: "inherit",
            cwd: projectRoot,
          });
          if (co.status !== 0) {
            console.error(`│  ✗ git checkout ${mod.ref} failed for ${mod.path}`);
            console.log(`└─ failed`);
            return co.status || 1;
          }
        }
      }
    }
    console.log(`└─ done`);
  }

  // 5.5 workspace.dirs — deterministic empty-dir scaffolding (greenfield)
  const ws = profile.workspace || {};
  const dirs = ws.dirs;
  if (Array.isArray(dirs) && dirs.length > 0) {
    console.log(`\n┌─ workspace.dirs (${dirs.length})`);
    for (const dir of dirs) {
      if (typeof dir !== "string" || !dir || dir.includes("..")) {
        console.error(`│  ✗ invalid workspace.dirs entry: ${JSON.stringify(dir)}`);
        console.log(`└─ failed`);
        return 1;
      }
      const target = join(projectRoot, dir);
      if (existsSync(target)) {
        console.log(`│  = ${dir} (exists, skipping)`);
        continue;
      }
      console.log(`│  mkdir -p ${dir}`);
      if (!dryRun) mkdirSync(target, { recursive: true });
    }
    console.log(`└─ done`);
  }

  // 6. workspace.init / workspace.link — agent-led (workspace skill)
  if (ws.init) {
    const linkFlag = ws.link ? " --link" : "";
    console.log(`\n┌─ workspace init${ws.link ? " + link" : ""} (agent-led)`);
    if (dryRun) {
      console.log(`│  agent run -a ${agent} "Run /workspace --init${linkFlag}"`);
    } else {
      const code = await cmdAgentRun(["-a", agent, `Run /workspace --init${linkFlag}`]);
      if (code !== 0) {
        console.error("│  ✗ workspace init failed");
        console.log(`└─ failed`);
        return code || 1;
      }
    }
    console.log(`└─ done`);
  }

  // 7. skills.sources — deterministic install (no LLM); -y: setup is non-interactive
  const sources = profile.skills && profile.skills.sources;
  if (Array.isArray(sources) && sources.length > 0) {
    console.log(`\n┌─ skills.sources (${sources.length} source(s))`);
    for (const src of sources) {
      console.log(`│  skills add ${src}`);
      if (!dryRun) {
        const code = await cmdAdd([src], { agents: [agent], yes: true });
        if (code !== 0) {
          console.error(`│  ✗ skills add failed for ${src}`);
          console.log(`└─ failed`);
          return code || 1;
        }
      }
    }
    console.log(`└─ done`);
  }

  // 8. commands — sequential, stop on first failure
  const commands = profile.commands;
  if (Array.isArray(commands) && commands.length > 0) {
    console.log(`\n┌─ commands (${commands.length})`);
    for (const command of commands) {
      const code = await runProfileCommand(String(command), agent, cmdAgentRun, cmdAdd, cmdTeamSetup, dryRun);
      if (code !== 0) {
        console.log(`└─ failed`);
        return code || 1;
      }
    }
    console.log(`└─ done`);
  }

  console.log(`\nWorkspace setup complete.`);
  console.log(`Next: adlc-cli agent run "<your goal>" -a ${agent}`);
  return 0;
}

async function loadProfile(source, projectRoot) {
  if (/^https?:\/\//.test(source)) {
    try {
      const res = await fetch(source);
      if (!res.ok) {
        console.error(`Error: failed to fetch profile from ${source} (HTTP ${res.status})`);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.error(`Error: failed to fetch profile from ${source}: ${err.message}`);
      return null;
    }
  }
  const path = resolve(projectRoot, source);
  if (!existsSync(path)) {
    console.error(`Error: workspace profile not found at ${path}`);
    return null;
  }
  return readFileSync(path, "utf-8");
}

async function runProfileCommand(command, agent, cmdAgentRun, cmdAdd, cmdTeamSetup, dryRun) {
  const trimmed = command.trim();

  // agent run "<quoted prompt>" — prompts contain spaces/quotes
  let match = trimmed.match(/^agent run "([\s\S]*)"$/);
  if (match) {
    console.log(`│  agent run "${match[1]}"`);
    if (dryRun) return 0;
    return await cmdAgentRun(["-a", agent, match[1]]);
  }
  // agent run <bare prompt>
  match = trimmed.match(/^agent run (.+)$/);
  if (match) {
    console.log(`│  agent run ${match[1]}`);
    if (dryRun) return 0;
    return await cmdAgentRun(["-a", agent, match[1]]);
  }
  // skills add <source>
  match = trimmed.match(/^skills add (\S+)$/);
  if (match) {
    console.log(`│  skills add ${match[1]}`);
    if (dryRun) return 0;
    return await cmdAdd([match[1]], { agents: [agent], yes: true });
  }
  // team setup <source>
  match = trimmed.match(/^team setup (\S+)$/);
  if (match) {
    console.log(`│  team setup ${match[1]}`);
    if (dryRun) return 0;
    return await cmdTeamSetup([match[1]], { agents: [agent], yes: true });
  }

  console.error(`│  ✗ unknown command: "${trimmed}" (supported: skills add, team setup, agent run)`);
  return 1;
}

// ── init (brownfield) ──────────────────────────────────────────────────
export async function cmdWorkspaceInit(args, flags) {
  const agent = (flags.agents && flags.agents[0]) || readAgent();
  if (!agent) {
    console.error("Error: Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  let prompt = "Run /workspace --init";
  if (flags.link) prompt += " --link";
  else if (flags.ignoreOnly) prompt += " --ignore-only";

  if (flags.dryRun) {
    console.log(`agent run -a ${agent} "${prompt}"`);
    return 0;
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  return cmdAgentRun(["-a", agent, prompt]);
}

// ── status (audit) ─────────────────────────────────────────────────────
export async function cmdWorkspaceStatus(args, flags) {
  const agent = (flags.agents && flags.agents[0]) || readAgent();
  if (!agent) {
    console.error("Error: Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  if (flags.dryRun) {
    console.log(`agent run -a ${agent} "Run /workspace --status"`);
    return 0;
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  return cmdAgentRun(["-a", agent, "Run /workspace --status"]);
}
