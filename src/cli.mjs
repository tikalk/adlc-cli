// CLI entry point — parses args, orchestrates npx skills + command generation + events.

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { AGENTS, resolveNpxAgent, getAgent, getRunProfile, GENERATED_HEADER, EVENT_AGENTS, getEventAgentConfig } from "./registry.mjs";
import { findInstalledSkills, detectAdlc, expandTilde } from "./source.mjs";
import { generateCommand, commandFilename, isGenerated, removeGeneratedCommands } from "./convert.mjs";
import {
  installDispatcher,
  installEvents,
  removeEvents,
  fetchEventsManifest,
  readLocalEventsManifest,
  resolveEvents,
} from "./events.mjs";
import { runTask } from "./run.mjs";

export async function main(argv = process.argv.slice(2), opts = {}) {
  const mode = opts.mode ?? "legacy"; // "cli" (new tree) | "legacy" (adlc-skills-cli alias)
  const parsed = parseArgs(argv);
  return mode === "cli" ? runNewTree(parsed, argv) : runLegacyTree(parsed);
}

// ── legacy tree (adlc-skills-cli bin — frozen surface) ─────────────────
function runLegacyTree({ command, args, flags }) {
  switch (command) {
    case "add":
      return cmdAdd(args, flags);
    case "upgrade":
      return cmdUpgrade(args, flags);
    case "remove":
      return cmdRemove(args, flags);
    case "status":
      return cmdStatus(args, flags);
    case "agents":
      return cmdAgents(args, flags);
    case "help":
    default:
      printHelp();
      return 0;
  }
}

// ── new tree (adlc-cli bin — dual mode: skill management + run) ──────────
function runNewTree({ command, args, flags }, argv) {
  switch (command) {
    case "skill": {
      const sub = args[0] ?? "help";
      const rest = args.slice(1);
      switch (sub) {
        case "add":
          return cmdAdd(rest, flags);
        case "upgrade":
          return cmdUpgrade(rest, flags);
        case "remove":
          return cmdRemove(rest, flags);
        case "status":
          return cmdStatus(rest, flags);
        case "agents":
          return cmdAgents(rest, flags);
        case "help":
          printSkillHelp();
          return 0;
        default:
          console.error(`Unknown skill command: "${sub}"`);
          printSkillHelp();
          return 1;
      }
    }
    case "run":
      return cmdRun(argv.slice(1));
    case "help":
    default:
      printCliHelp();
      return 0;
  }
}

function cmdRun(runArgs) {
  return cmdRunImpl(runArgs);
}

// Dedicated arg parser for run (keeps the legacy parseArgs frozen).
function parseRunArgs(argv) {
  let agent = "opencode";
  let model = null;
  let format = "text";
  let requireApproval = null;
  let prompt = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-a" || arg === "--agent") {
      agent = argv[++i];
    } else if (arg === "--model") {
      model = argv[++i];
    } else if (arg === "--format") {
      format = argv[++i];
    } else if (arg === "--require-approval") {
      requireApproval = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "-") {
      prompt = "__STDIN__";
    } else if (!arg.startsWith("-")) {
      prompt = arg;
    }
  }

  return { agent, model, format, requireApproval, prompt };
}

async function cmdRunImpl(runArgs) {
  const { agent, model, format, requireApproval, prompt: rawPrompt } = parseRunArgs(runArgs);

  let prompt = rawPrompt;
  if (prompt === "__STDIN__") {
    const chunks = [];
    await new Promise((r) => {
      process.stdin.on("data", (c) => chunks.push(c)).on("end", r);
    });
    prompt = Buffer.concat(chunks).toString();
  }

  if (!prompt) {
    console.error("Error: task is required (pass a string, or '-' for stdin)");
    return 1;
  }

  let profile;
  try {
    profile = getRunProfile(agent);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const { promise } = runTask({
    profile,
    prompt,
    model,
    requireApproval,
    onLine: (line) => {
      // Task 5 replaces this with the format-aware normalizer.
      // For now: raw passthrough (text mode only).
      if (format === "json") {
        process.stdout.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    },
  });

  const { code, signal } = await promise;
  return code ?? (signal ? 130 : 1);
}

// ── add ────────────────────────────────────────────────────────────────
async function cmdAdd(args, flags) {
  const source = args[0];
  if (!source) {
    console.error("Error: source is required (e.g., tikalk/adlc-team-skills)");
    return 1;
  }

  const agents = flags.agents || [];
  if (agents.length === 0) {
    console.error("Error: at least one -a <agent> is required");
    return 1;
  }

  const projectRoot = process.cwd();
  const isGlobal = flags.global || false;
  const noEvents = flags.noEvents || false;
  const prefix = flags.prefix || null;
  const mode = flags.mode || null;
  const skillFilter = flags.skill || null;
  const npxYes = flags.yes || false;

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) {
      console.error(`Error: unknown agent "${agentKey}". Run 'adlc-skills-cli agents' to list supported agents.`);
      return 1;
    }

    console.log(`\n┌─ ${agent.name} (${agentKey})`);

    // 1. Run npx skills add
    const npxAgent = resolveNpxAgent(agentKey);
    const npxArgs = ["skills", "add", source, "-a", npxAgent];
    if (isGlobal) npxArgs.push("-g");
    if (skillFilter) {
      if (skillFilter === "*") npxArgs.push("--skill", "*");
      else npxArgs.push("--skill", skillFilter);
    }
    if (flags.copy) npxArgs.push("--copy");
    if (npxYes) npxArgs.push("-y");

    console.log(`│  Running: npx ${npxArgs.join(" ")}`);
    const result = spawnSync("npx", npxArgs, { stdio: "inherit", cwd: projectRoot });
    if (result.status !== 0) {
      console.error(`│  ✗ npx skills add failed for ${agentKey}`);
      return result.status || 1;
    }

    // 2. Find installed skills
    const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
    if (!skillsDir) {
      console.log(`│  No skills directory for ${agentKey} — skipping command generation`);
      continue;
    }

    const skills = await findInstalledSkills(skillsDir, projectRoot);
    const filtered = skillFilter && skillFilter !== "*" ? skills.filter((s) => s.name === skillFilter) : skills;

    console.log(`│  Found ${filtered.length} skill(s) in ${skillsDir}`);

    // 3. Generate command files
    const commandsDir = agent.commands_dir;
    if (!commandsDir) {
      console.log(`│  No commands directory for ${agentKey} — use --commands-dir`);
      continue;
    }

    const absCommandsDir = resolve(projectRoot, expandTilde(commandsDir));
    mkdirSync(absCommandsDir, { recursive: true });

    let generated = 0;
    for (const skill of filtered) {
      const filename = commandFilename(skill, agent, { prefix });
      const content = generateCommand(skill, agent, { mode, prefix, source });
      const filepath = join(absCommandsDir, filename);
      writeFileSync(filepath, content, "utf-8");
      generated++;
    }
    console.log(`│  Generated ${generated} command file(s) in ${commandsDir}`);

    // 4. Events (if agent supports hooks + .events.json found + not disabled)
    const agentEventConfig = getEventAgentConfig(agentKey);
    if (agentEventConfig && !noEvents) {
      const manifest = await fetchEventsManifest(source);
      if (manifest && manifest.events) {
        // Copy .events.json to target project so upgrade can re-read it
        const targetEventsPath = join(projectRoot, ".events.json");
        const sourceEventsPath = resolve(source, ".events.json");
        if (source !== "." && existsSync(sourceEventsPath)) {
          copyFileSync(sourceEventsPath, targetEventsPath);
        }
        const resolvedEvents = resolveEvents(manifest, agentEventConfig);
        const eventCount = Object.keys(resolvedEvents).length;
        if (eventCount > 0) {
          const dispatcherPath = installDispatcher(projectRoot);
          console.log(`│  Installed dispatcher: ${dispatcherPath.replace(projectRoot + "/", "")}`);
          const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
          const eventResult = installEvents(agentKey, projectRoot, resolvedEvents, skillsDir);
          if (eventResult) {
            const tag = eventResult.merged ? " (merged)" : " (created)";
            const errTag = eventResult.error ? ` [${eventResult.error}]` : "";
            console.log(`│  Event config: ${eventResult.path}${tag}${errTag}`);
            console.log(`│  Events: ${eventCount} (${Object.keys(resolvedEvents).join(", ")})`);
          }
        } else {
          console.log(`│  Events: none applicable for ${agentKey} in .events.json`);
        }
      } else {
        console.log(`│  Events: skipped (no .events.json found in source)`);
      }
    }

    console.log(`└─ done`);
  }

  console.log("");
  return 0;
}

// ── upgrade ────────────────────────────────────────────────────────────
async function cmdUpgrade(args, flags) {
  const projectRoot = process.cwd();
  const agents = flags.agents || Object.keys(AGENTS).filter((k) => k !== "generic");
  const prefix = flags.prefix || null;
  const mode = flags.mode || null;
  const isGlobal = flags.global || false;

  if (flags.pull) {
    // npx skills update doesn't re-copy files for local sources, so we
    // read skills-lock.json for the source and re-install via npx skills add --copy
    const lockPath = join(projectRoot, "skills-lock.json");
    let pullSource = null;
    if (existsSync(lockPath)) {
      try {
        const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
        const skillNames = flags.skill && flags.skill !== "*" ? [flags.skill] : Object.keys(lock.skills || {});
        for (const name of skillNames) {
          const entry = lock.skills?.[name];
          if (entry?.source && !pullSource) pullSource = entry.source;
        }
      } catch {}
    }
    if (!pullSource) {
      console.error("│  ✗ --pull requires skills-lock.json with source info (run 'add' first)");
      return 1;
    }
    for (const agentKey of agents) {
      const npxAgent = resolveNpxAgent(agentKey);
      const npxArgs = ["skills", "add", pullSource, "-a", npxAgent, "--copy"];
      if (flags.skill && flags.skill !== "*") { npxArgs.push("-s", flags.skill); }
      npxArgs.push("-y");
      console.log(`Pulling latest skills from ${pullSource} for ${agentKey}...`);
      const result = spawnSync("npx", npxArgs, { stdio: "inherit", cwd: projectRoot });
      if (result.status !== 0) {
        console.error(`│  ✗ npx skills add failed for ${agentKey}`);
        return result.status || 1;
      }
    }
  }

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) continue;

    const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
    if (!skillsDir) continue;

    const skills = await findInstalledSkills(skillsDir, projectRoot);
    if (skills.length === 0) continue;

    const commandsDir = agent.commands_dir;
    if (!commandsDir) continue;

    const absCommandsDir = resolve(projectRoot, expandTilde(commandsDir));
    mkdirSync(absCommandsDir, { recursive: true });

    let updated = 0;
    let skipped = 0;

    for (const skill of skills) {
      const filename = commandFilename(skill, agent, { prefix });
      const filepath = join(absCommandsDir, filename);

      if (existsSync(filepath)) {
        const existing = readFileSync(filepath, "utf-8");
        if (isGenerated(existing)) {
          const content = generateCommand(skill, agent, { mode, prefix, source: "upgrade" });
          writeFileSync(filepath, content, "utf-8");
          updated++;
        } else {
          skipped++;
        }
      } else {
        const content = generateCommand(skill, agent, { mode, prefix, source: "upgrade" });
        writeFileSync(filepath, content, "utf-8");
        updated++;
      }
    }

    console.log(`${agent.name}: ${updated} updated, ${skipped} user-modified (skipped)`);

    // Re-generate events from .events.json in target project (if present)
    const agentEventConfig = getEventAgentConfig(agentKey);
    if (agentEventConfig) {
      const localManifest = readLocalEventsManifest(projectRoot);
      if (localManifest && localManifest.events) {
        const resolvedEvents = resolveEvents(localManifest, agentEventConfig);
        const eventCount = Object.keys(resolvedEvents).length;
        if (eventCount > 0) {
          installDispatcher(projectRoot);
          const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
          installEvents(agentKey, projectRoot, resolvedEvents, skillsDir);
          console.log(`${agent.name}: events re-generated (${eventCount})`);
        }
      }
    }
  }

  return 0;
}

// ── remove ─────────────────────────────────────────────────────────────
async function cmdRemove(args, flags) {
  const projectRoot = process.cwd();
  const agents = flags.agents || Object.keys(AGENTS).filter((k) => k !== "generic");

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) continue;

    const commandsDir = agent.commands_dir;
    if (!commandsDir) continue;

    const absCommandsDir = resolve(projectRoot, expandTilde(commandsDir));
    const removed = removeGeneratedCommands(absCommandsDir);

    if (removed > 0) {
      console.log(`${agent.name}: removed ${removed} command file(s)`);
    }

    // Remove event configs (only for event-capable agents)
    if (getEventAgentConfig(agentKey)) {
      const eventResult = removeEvents(agentKey, projectRoot);
      if (eventResult) {
        if (eventResult.action === "deleted") {
          const path = join(projectRoot, eventResult.path);
          if (existsSync(path)) rmSync(path);
          console.log(`${agent.name}: removed event config ${eventResult.path}`);
        } else if (eventResult.action === "cleaned") {
          console.log(`${agent.name}: cleaned event entries from ${eventResult.path}`);
        } else if (eventResult.action === "manual") {
          console.log(`${agent.name}: event config merged into ${eventResult.path} — remove manually`);
        }
      }
    }
  }

  // Clean up dispatcher if no event agents remain
  const dispatcherPath = join(projectRoot, ".agents", "dispatcher.mjs");
  if (existsSync(dispatcherPath)) {
    rmSync(dispatcherPath);
    console.log("Removed dispatcher: .agents/dispatcher.mjs");
  }

  // Clean up .events.json (copied from source during add)
  const eventsPath = join(projectRoot, ".events.json");
  if (existsSync(eventsPath)) {
    rmSync(eventsPath);
    console.log("Removed .events.json");
  }

  return 0;
}

// ── status ─────────────────────────────────────────────────────────────
async function cmdStatus(args, flags) {
  const projectRoot = process.cwd();
  const agents = flags.agents || Object.keys(AGENTS).filter((k) => k !== "generic");
  const isGlobal = flags.global || false;

  console.log(`Project: ${projectRoot}`);
  console.log(`ADLC: ${detectAdlc(projectRoot) ? "detected" : "not detected"}`);

  // Check if dispatcher is installed
  const dispatcherInstalled = existsSync(join(projectRoot, ".agents", "dispatcher.mjs"));
  console.log(`Dispatcher: ${dispatcherInstalled ? "installed" : "not installed"}`);
  console.log("");

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) continue;

    const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
    const commandsDir = agent.commands_dir;

    const skills = skillsDir ? await findInstalledSkills(skillsDir, projectRoot) : [];
    const absCommandsDir = commandsDir ? resolve(projectRoot, expandTilde(commandsDir)) : null;

    let commandCount = 0;
    let generatedCount = 0;
    if (absCommandsDir && existsSync(absCommandsDir)) {
      for (const entry of readdirSync(absCommandsDir)) {
        const filepath = join(absCommandsDir, entry);
        if (statSync(filepath).isFile()) {
          commandCount++;
          if (isGenerated(readFileSync(filepath, "utf-8"))) generatedCount++;
        }
      }
    }

    const agentEventConfig = getEventAgentConfig(agentKey);
    let eventStatus = "n/a";
    if (agentEventConfig) {
      const configPath = join(projectRoot, agentEventConfig.config_file);
      eventStatus = existsSync(configPath) ? "installed" : "eligible";
    }

    console.log(
      `${agent.name.padEnd(20)} skills:${String(skills.length).padStart(3)}  commands:${String(commandCount).padStart(3)} (${generatedCount} generated)  events:${eventStatus}`,
    );
  }

  return 0;
}

// ── agents ─────────────────────────────────────────────────────────────
function cmdAgents(args, flags) {
  console.log("Supported agents:\n");
  console.log("Key                 Name                Commands dir                    Format   Events  Npx agent");
  console.log("─────────────────── ─────────────────── ─────────────────────────────── ──────── ─────── ─────────────");

  for (const [key, agent] of Object.entries(AGENTS)) {
    if (key === "generic") continue;
    console.log(
      `${key.padEnd(20)}${agent.name.padEnd(20)}${(agent.commands_dir || "—").padEnd(31)}${agent.format.padEnd(9)}${(agent.events ? "yes" : "no").padEnd(8)}${agent.npx_agent || "universal"}`,
    );
  }

  console.log("\nUse -a <key> to target an agent.");
  return 0;
}

// ── arg parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const command = argv[0] || "help";
  const rest = argv.slice(1);

  const args = [];
  const flags = { agents: [] };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (arg === "-a" || arg === "--agent") {
      flags.agents.push(rest[++i]);
    } else if (arg === "-g" || arg === "--global") {
      flags.global = true;
    } else if (arg === "--no-events") {
      flags.noEvents = true;
    } else if (arg === "--prefix") {
      flags.prefix = rest[++i];
    } else if (arg === "--mode") {
      flags.mode = rest[++i];
    } else if (arg === "--skill" || arg === "-s") {
      flags.skill = rest[++i];
    } else if (arg === "--copy") {
      flags.copy = true;
    } else if (arg === "--pull") {
      flags.pull = true;
    } else if (arg === "-y" || arg === "--yes") {
      flags.yes = true;
    } else if (arg === "--commands-dir") {
      flags.commandsDir = rest[++i];
    } else if (!arg.startsWith("-")) {
      args.push(arg);
    }
  }

  return { command, args, flags };
}

function printCliHelp() {
  console.log(`
adlc-cli — dual-mode CLI for coding agents: skill management + headless task runs

USAGE:
  adlc-cli <command> [options]

COMMANDS:
  skill add <source> -a <agent>    Install skills + generate commands + wire events
  skill upgrade [-a <agent>]       Regenerate commands from installed skills
  skill remove [-a <agent>]        Remove generated commands + event configs
  skill status [-a <agent>]        Report installed commands/events state
  skill agents                     List supported agents
  run "<task>" [flags]             Run a coding agent headlessly with a task
  help                             Show this help

RUN FLAGS:
  -a <agent>                       Agent: opencode | claude-code | goose | gemini (default: opencode)
  --model <id>                     Model id passed to the agent CLI
  --format <fmt>                   Output: text (default, human) | json (normalized JSONL)
  --require-approval <tools>       Tools that pause for human approval (comma-separated)
  -                                Read the task from stdin

INSTALL:
  npx adlc-cli skill add ...       one-off (no install needed)
  npm install -g adlc-cli          install as global binary

EXAMPLES:
  adlc-cli skill add tikalk/adlc-team-skills -a opencode
  adlc-cli run "Fix the failing auth test" -a opencode
  cat brief.md | adlc-cli run - --format json
`);
}

function printSkillHelp() {
  console.log(`
USAGE:
  adlc-cli skill <command> [flags]

COMMANDS:
  add <source>       Install skills via npx skills + generate commands + events
  upgrade [--pull]   Re-generate commands from currently-installed skills
  remove             Remove generated commands + event configs
  status             Show what's installed per agent
  agents             List supported agents

FLAGS: same as the legacy flags (-a, -g, --no-events, --prefix, --mode, --skill, --copy, --pull, -y)
Run 'adlc-cli help' for the full list.
`);
}

function printHelp() {
  console.log(`
adlc-skills-cli — wrap npx skills add + generate slash commands + session_start events

USAGE:
  adlc-skills-cli add <source> -a <agent> [-a ...] [flags]
  adlc-skills-cli upgrade [-a <agent>]
  adlc-skills-cli remove [-a <agent>]
  adlc-skills-cli status [-a <agent>]
  adlc-skills-cli agents

COMMANDS:
  add <source>       Install skills via npx skills + generate commands + events
  upgrade [--pull]    Re-generate commands from currently-installed skills
                      --pull: also re-install skills from source (via npx skills add)
  remove             Remove generated commands + event configs
  status             Show what's installed per agent
  agents             List supported agents

FLAGS:
  -a <agent>         Target agent (repeatable). Run 'agents' to list.
  -g, --global       Install to user directory instead of project
  --no-events        Skip event config generation
  --prefix <str>     Namespace command filenames (e.g., adlc.team-setup.md)
  --mode <mode>      inline (default) | wrapper
  --skill <name>     Install/generate for one skill only (use '*' for all)
  --copy             Copy files instead of symlinking (passthrough to npx skills)
  --pull              Pull latest from source before regenerating (upgrade only)
  -y, --yes          Skip confirmation prompts

INSTALL:
  npx adlc-skills-cli add ...     one-off (no install needed)
  npm install -g adlc-skills-cli  install as global binary → adlc-skills-cli add ...

EXAMPLES:
  adlc-skills-cli add tikalk/adlc-team-skills -a opencode
  adlc-skills-cli add mattpocock/skills -a claude-code -a opencode --no-events
  adlc-skills-cli add tikalk/adlc-team-skills -a opencode --prefix adlc --skill team-setup
  adlc-skills-cli upgrade --pull -a opencode
  adlc-skills-cli upgrade --pull --skill team-boot -a opencode
  adlc-skills-cli status
  adlc-skills-cli agents
`);
}
