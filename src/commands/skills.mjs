// Skill lifecycle commands: add, upgrade, remove, status.
// These share imports and operate on the skill installation state.

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS, resolveNpxAgent, getAgent, getEventAgentConfig } from "../registry.mjs";
import { findInstalledSkills, detectAdlc, expandTilde } from "../source.mjs";
import { generateCommand, commandFilename, isGenerated, removeGeneratedCommands } from "../convert.mjs";
import {
  installDispatcher,
  installEvents,
  removeEvents,
  fetchEventsManifest,
  readLocalEventsManifest,
  resolveEvents,
} from "../events.mjs";
import { writeAgent, writeSkillsSource, readSkillsSource } from "../utils/init-options.mjs";

// ── add ────────────────────────────────────────────────────────────────
export async function cmdAdd(args, flags) {
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
      console.error(`Error: unknown agent "${agentKey}". Run 'adlc-cli agent list' to list supported agents.`);
      return 1;
    }

    console.log(`\n┌─ ${agent.name} (${agentKey})`);

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

    const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
    if (!skillsDir) {
      console.log(`│  No skills directory for ${agentKey} — skipping command generation`);
      continue;
    }

    const skills = await findInstalledSkills(skillsDir, projectRoot);
    const filtered = skillFilter && skillFilter !== "*" ? skills.filter((s) => s.name === skillFilter) : skills;

    console.log(`│  Found ${filtered.length} skill(s) in ${skillsDir}`);

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

    const agentEventConfig = getEventAgentConfig(agentKey);
    if (agentEventConfig && !noEvents) {
      const manifest = await fetchEventsManifest(source);
      if (manifest && manifest.events) {
        const targetEventsPath = join(projectRoot, ".events.json");
        // Persist the manifest to the project root so later commands
        // (update/remove) can re-resolve events without re-fetching.
        // Local sources: copy the file (preserves comments/ordering).
        // Remote sources: write the fetched manifest (resolve() on a
        // repo-id was never a valid path — the copy silently never ran).
        const sourceEventsPath = resolve(source, ".events.json");
        if (source !== "." && existsSync(sourceEventsPath)) {
          copyFileSync(sourceEventsPath, targetEventsPath);
        } else if (!existsSync(targetEventsPath)) {
          writeFileSync(targetEventsPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
        }
        const resolvedEvents = resolveEvents(manifest, agentEventConfig);
        const eventCount = Object.keys(resolvedEvents).length;
        if (eventCount > 0) {
          const dispatcherPath = installDispatcher(projectRoot);
          console.log(`│  Installed dispatcher: ${dispatcherPath.replace(projectRoot + "/", "")}`);
          const skillsDir2 = isGlobal ? agent.global_skills_dir : agent.skills_dir;
          const eventResult = installEvents(agentKey, projectRoot, resolvedEvents, skillsDir2);
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
  // Persist agent + source to init-options.json (merge, preserve existing)
  for (const agentKey of agents) {
    writeAgent(agentKey);
  }
  writeSkillsSource(source);
  return 0;
}

// ── upgrade ────────────────────────────────────────────────────────────
export async function cmdUpdate(args, flags) {
  const projectRoot = process.cwd();
  const agents = flags.agents || Object.keys(AGENTS).filter((k) => k !== "generic");
  const prefix = flags.prefix || null;
  const mode = flags.mode || null;
  const isGlobal = flags.global || false;

  if (flags.pull) {
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
    // Fallback: read from init-options.json
    if (!pullSource) {
      pullSource = readSkillsSource();
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

    const agentEventConfig = getEventAgentConfig(agentKey);
    if (agentEventConfig) {
      const localManifest = readLocalEventsManifest(projectRoot);
      if (localManifest && localManifest.events) {
        const resolvedEvents = resolveEvents(localManifest, agentEventConfig);
        const eventCount = Object.keys(resolvedEvents).length;
        if (eventCount > 0) {
          installDispatcher(projectRoot);
          const skillsDir2 = isGlobal ? agent.global_skills_dir : agent.skills_dir;
          installEvents(agentKey, projectRoot, resolvedEvents, skillsDir2);
          console.log(`${agent.name}: events re-generated (${eventCount})`);
        }
      }
    }
  }

  return 0;
}

// ── remove ─────────────────────────────────────────────────────────────
export async function cmdRemove(args, flags) {
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

  const dispatcherPath = join(projectRoot, ".agents", "dispatcher.mjs");
  if (existsSync(dispatcherPath)) {
    rmSync(dispatcherPath);
    console.log("Removed dispatcher: .agents/dispatcher.mjs");
  }

  const eventsPath = join(projectRoot, ".events.json");
  if (existsSync(eventsPath)) {
    rmSync(eventsPath);
    console.log("Removed .events.json");
  }

  return 0;
}

// ── status ─────────────────────────────────────────────────────────────
export async function cmdStatus(args, flags) {
  const projectRoot = process.cwd();
  const agents = flags.agents || Object.keys(AGENTS).filter((k) => k !== "generic");
  const isGlobal = flags.global || false;

  console.log(`Project: ${projectRoot}`);
  console.log(`ADLC: ${detectAdlc(projectRoot) ? "detected" : "not detected"}`);

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
