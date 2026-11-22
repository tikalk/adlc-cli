// Skill lifecycle commands: add, upgrade, remove, status.
// These share imports and operate on the skill installation state.

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AGENTS, resolveNpxAgent, getAgent, getHookAgentConfig } from "../registry.mjs";
import { findInstalledSkills, detectAdlc, expandTilde } from "../source.mjs";
import { spawnNpxSync, resolveSkillsPackageSpec } from "../utils/spawn.mjs";
import { normalizePs1Scripts } from "../utils/encoding.mjs";
import { generateCommand, commandFilename, isGenerated, removeGeneratedCommands } from "../convert.mjs";
import {
  installDispatcher,
  installHooks,
  removeHooks,
  fetchHooksManifest,
  fetchSkillsDeps,
  expandSkillSelection,
  readLocalHooksManifest,
  resolveHooks,
} from "../hooks.mjs";
import { writeAgent, writeSkillsSource, readSkillsSource } from "../utils/init-options.mjs";
import { describeSpawnError } from "../utils/spawn.mjs";
import {
  out,
  error,
  failure,
  item,
  section,
  panel,
  table,
  keyValue,
  style,
  tint,
  combine,
  sym,
  ACCENT,
} from "../ui/index.mjs";

// A step-list header for one agent. A panel is deliberately not used here:
// `npx` writes straight to the terminal, so a box would be torn apart by the
// interleaved child output. The items are printed one at a time as they
// happen, so the header is the only part a shared primitive can own.
function agentHeader(agent, agentKey) {
  section(`${agent.name} (${agentKey})`);
}

// `flags.agents` is always an array — an empty array is truthy, so the old
// `flags.agents || ALL_AGENTS` never fell back to "every agent" and the
// no-flag path silently did nothing.
const ALL_AGENTS = () => Object.keys(AGENTS).filter((key) => key !== "generic");

function targetAgents(flags) {
  if (flags.agents && flags.agents.length > 0) return flags.agents;
  return ALL_AGENTS();
}

// A marked skill ships no command file (ADR-507). Both marker spellings
// arrive as the string "true" after frontmatter quote-stripping, but the
// bare boolean is accepted too.
function isReferenceOnly(skill) {
  const marker = skill.frontmatter?.["reference-only"];
  return marker === true || marker === "true";
}

// ── add ────────────────────────────────────────────────────────────────
export async function cmdAdd(args, flags) {
  const source = args[0];
  if (!source) {
    error("source is required (e.g., tikalk/adlc-team-skills)");
    return 1;
  }

  const agents = flags.agents || [];
  if (agents.length === 0) {
    error("at least one -a <agent> is required");
    return 1;
  }

  const projectRoot = process.cwd();
  const isGlobal = flags.global || false;
  const noHooks = flags.noHooks || flags.noEvents || false; // --no-events is a deprecated alias
  const prefix = flags.prefix || null;
  const mode = flags.mode || null;
  const skillFilter = flags.skill || null;
  const npxYes = flags.yes || false;

  // Resolve the selective-install closure once (shared across agents).
  let selectedSkills = null;
  if (skillFilter && skillFilter !== "*") {
    selectedSkills = expandSkillSelection(await fetchSkillsDeps(source), skillFilter);
  }

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) {
      error(`unknown agent "${agentKey}". Run 'adlc-cli agent list' to list supported agents.`);
      return 1;
    }

    agentHeader(agent, agentKey);

    const npxAgent = resolveNpxAgent(agentKey);
    // Version-aware spec: skills@latest defeats the stale _npx cache install
    // without revalidating (Windows kept 1.5.18 after 1.7.2 shipped — missing
    // UI like the "Select All" row); older Nodes get pinned skills@1.5.18,
    // the newest release that runs there. --yes skips npx's own install confirm.
    const npxArgs = ["--yes", resolveSkillsPackageSpec(), "add", source, "-a", npxAgent];
    if (isGlobal) npxArgs.push("-g");
    // Selective installs expand through .skills-deps.json closure: borrowers
    // pull their canonical homes (npx accepts repeated --skill flags).
    // No manifest or no match → the plain selection (fail-open).
    if (skillFilter) {
      if (skillFilter === "*") {
        npxArgs.push("--skill", "*");
      } else {
        for (const name of selectedSkills) npxArgs.push("--skill", name);
        if (selectedSkills.length > 1) {
          item(
            `--skill expanded via .skills-deps.json: ${selectedSkills.join(", ")}`,
            { glyph: sym.info, color: "gray" },
          );
        }
      }
    }
    if (flags.copy) npxArgs.push("--copy");
    if (npxYes) npxArgs.push("-y");

    item(combine("Running: ", tint(`npx ${npxArgs.join(" ")}`, "cyan")), {
      glyph: sym.arrow,
      color: "gray",
    });
    const result = spawnNpxSync(npxArgs, { stdio: "inherit", cwd: projectRoot });
    if (result.status !== 0) {
      if (result.error) {
        item(`could not run npx: ${result.error.message}`, { glyph: sym.failure, color: "red" });
      }
      item(`npx skills add failed for ${agentKey}`, { glyph: sym.failure, color: "red" });
      const spawnError = describeSpawnError(result);
      if (spawnError) item(`spawn error: ${spawnError}`, { glyph: sym.info, color: "gray" });
      failure(`skills add failed for ${agentKey}`);
      return result.status || 1;
    }

    const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
    if (!skillsDir) {
      item(`No skills directory for ${agentKey} — skipping command generation`, {
        glyph: sym.info,
        color: "yellow",
      });
      continue;
    }

    // Windows PowerShell 5.1 misreads BOM-less non-ASCII .ps1 as ANSI — normalize now.
    const bomFixed = normalizePs1Scripts(resolve(projectRoot, expandTilde(skillsDir)));
    if (bomFixed > 0) {
      item(`UTF-8 BOM added to ${bomFixed} .ps1 script(s) (Windows PowerShell 5.1 compat)`, {
        glyph: sym.info,
        color: "gray",
      });
    }

    const skills = await findInstalledSkills(skillsDir, projectRoot);
    const filtered = selectedSkills ? skills.filter((s) => selectedSkills.includes(s.name)) : skills;

    item(`Found ${filtered.length} skill(s) in ${skillsDir}`, { glyph: sym.success, color: "green" });

    const commandsDir = agent.commands_dir;
    if (!commandsDir) {
      item(`No commands directory for ${agentKey} — use --commands-dir`, {
        glyph: sym.info,
        color: "yellow",
      });
      continue;
    }

    const absCommandsDir = resolve(projectRoot, expandTilde(commandsDir));
    mkdirSync(absCommandsDir, { recursive: true });

    let generated = 0;
    let referenceSkipped = 0;
    for (const skill of filtered) {
      if (isReferenceOnly(skill)) {
        referenceSkipped++;
        continue;
      }
      const filename = commandFilename(skill, agent, { prefix });
      const content = generateCommand(skill, agent, { mode, prefix, source });
      const filepath = join(absCommandsDir, filename);
      writeFileSync(filepath, content, "utf-8");
      generated++;
    }
    item(`Generated ${generated} command file(s) in ${commandsDir}`, {
      glyph: sym.success,
      color: "green",
    });
    if (referenceSkipped > 0) {
      item(`Skipped ${referenceSkipped} reference-only skill(s) (no command file)`, {
        glyph: sym.info,
        color: "gray",
      });
    }

    const agentHookConfig = getHookAgentConfig(agentKey);
    if (agentHookConfig && !noHooks) {
      const manifest = await fetchHooksManifest(source);
      if (manifest && manifest.hooks) {
        const targetHooksPath = join(projectRoot, ".hooks.json");
        const legacyHooksPath = join(projectRoot, ".events.json");
        // Persist the manifest to the project root so later commands
        // (update/remove) can re-resolve hooks without re-fetching.
        // Local sources: copy the file (preserves comments/ordering).
        // Remote sources: write the fetched manifest (resolve() on a
        // repo-id was never a valid path — the copy silently never ran).
        // Legacy `.events.json` sources copy to `.hooks.json` (canonical).
        const sourceHooksPath = resolve(source, ".hooks.json");
        const sourceLegacyPath = resolve(source, ".events.json");
        const sourceManifestPath =
          source !== "." && existsSync(sourceHooksPath)
            ? sourceHooksPath
            : source !== "." && existsSync(sourceLegacyPath)
              ? sourceLegacyPath
              : null;
        if (sourceManifestPath && !existsSync(targetHooksPath)) {
          copyFileSync(sourceManifestPath, targetHooksPath);
        }
        // Legacy `.events.json` in the project root still reads; `.hooks.json` wins.
        if (!existsSync(targetHooksPath) && existsSync(legacyHooksPath)) {
          copyFileSync(legacyHooksPath, targetHooksPath);
        }
        if (!existsSync(targetHooksPath)) {
          writeFileSync(targetHooksPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
        }
        const resolvedHooks = resolveHooks(manifest, agentHookConfig);
        const hookCount = Object.keys(resolvedHooks).length;
        if (hookCount > 0) {
          const dispatcherPath = installDispatcher(projectRoot);
          item(`Installed dispatcher: ${dispatcherPath.replace(projectRoot + "/", "")}`, {
            glyph: sym.success,
            color: "green",
          });
          const skillsDir2 = isGlobal ? agent.global_skills_dir : agent.skills_dir;
          const hookResult = installHooks(agentKey, projectRoot, resolvedHooks, skillsDir2);
          if (hookResult) {
            const tag = hookResult.merged ? " (merged)" : " (created)";
            const errTag = hookResult.error ? ` [${hookResult.error}]` : "";
            item(`Hook config: ${hookResult.path}${tag}${errTag}`, {
              glyph: sym.success,
              color: "green",
            });
            item(`Hooks: ${hookCount} (${Object.keys(resolvedHooks).join(", ")})`, {
              glyph: sym.success,
              color: "green",
            });
          }
        } else {
          item(`Hooks: none applicable for ${agentKey} in .hooks.json`, {
            glyph: sym.info,
            color: "yellow",
          });
        }
      } else {
        item(`Hooks: skipped (no .hooks.json found in source)`, {
          glyph: sym.info,
          color: "gray",
        });
      }
    }
  }

  out("");
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
  const agents = targetAgents(flags);
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
      error("--pull requires skills-lock.json with source info (run 'add' first)");
      return 1;
    }
    // Resolve the selective-install closure once (shared across agents).
    let pullSelected = null;
    if (flags.skill && flags.skill !== "*") {
      pullSelected = expandSkillSelection(await fetchSkillsDeps(pullSource), flags.skill);
    }
    for (const agentKey of agents) {
      const npxAgent = resolveNpxAgent(agentKey);
      const npxArgs = ["--yes", resolveSkillsPackageSpec(), "add", pullSource, "-a", npxAgent, "--copy"];
      if (pullSelected) {
        for (const name of pullSelected) npxArgs.push("-s", name);
      }
      npxArgs.push("-y");
      out("");
      out(combine(style("▸", ACCENT), ' ', style(`Pulling latest skills for ${agentKey}`, "bold")));
      item(`npx ${npxArgs.join(" ")}`, { glyph: sym.arrow, color: "gray" });
      const result = spawnNpxSync(npxArgs, { stdio: "inherit", cwd: projectRoot });
      if (result.status !== 0) {
        if (result.error) {
          item(`could not run npx: ${result.error.message}`, { glyph: sym.failure, color: "red" });
        }
        item(`npx skills add failed for ${agentKey}`, { glyph: sym.failure, color: "red" });
        const spawnError = describeSpawnError(result);
        if (spawnError) item(`spawn error: ${spawnError}`, { glyph: sym.info, color: "gray" });
        failure(`skills pull failed for ${agentKey}`);
        return result.status || 1;
      }
    }
  }

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) continue;

    const skillsDir = isGlobal ? agent.global_skills_dir : agent.skills_dir;
    if (!skillsDir) continue;

    // Re-copied skills come from upstream without BOMs — re-normalize every update.
    normalizePs1Scripts(resolve(projectRoot, expandTilde(skillsDir)));

    const skills = await findInstalledSkills(skillsDir, projectRoot);
    if (skills.length === 0) continue;

    const commandsDir = agent.commands_dir;
    if (!commandsDir) continue;

    const absCommandsDir = resolve(projectRoot, expandTilde(commandsDir));
    let updated = 0;
    let skipped = 0;

    for (const skill of skills) {
      if (isReferenceOnly(skill)) {
        const filename = commandFilename(skill, agent, { prefix });
        const filepath = join(absCommandsDir, filename);
        if (!existsSync(filepath)) continue; // nothing to clean up — not a skip
        if (isGenerated(readFileSync(filepath, "utf-8"))) {
          rmSync(filepath);
          updated++;
        } else {
          skipped++;
        }
        continue;
      }
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

    out("");
    out(combine(style("▸", ACCENT), ' ', style(`${agent.name} (${agentKey})`, "bold")));
    item(`${updated} updated, ${skipped} user-modified (skipped)`, {
      glyph: sym.success,
      color: "green",
    });

    const agentHookConfig = getHookAgentConfig(agentKey);
    if (agentHookConfig) {
      const localManifest = readLocalHooksManifest(projectRoot);
      if (localManifest && localManifest.hooks) {
        const resolvedHooks = resolveHooks(localManifest, agentHookConfig);
        const hookCount = Object.keys(resolvedHooks).length;
        if (hookCount > 0) {
          installDispatcher(projectRoot);
          const skillsDir2 = isGlobal ? agent.global_skills_dir : agent.skills_dir;
          installHooks(agentKey, projectRoot, resolvedHooks, skillsDir2);
          item(`hooks re-generated (${hookCount})`, { glyph: sym.success, color: "green" });
        }
      }
    }
  }

  return 0;
}

// ── remove ─────────────────────────────────────────────────────────────
export async function cmdRemove(args, flags) {
  const projectRoot = process.cwd();
  const agents = targetAgents(flags);

  for (const agentKey of agents) {
    const agent = getAgent(agentKey);
    if (!agent) continue;

    const commandsDir = agent.commands_dir;
    if (!commandsDir) continue;

    const absCommandsDir = resolve(projectRoot, expandTilde(commandsDir));
    const removed = removeGeneratedCommands(absCommandsDir);

    if (removed > 0) {
      out("");
      out(combine(style("▸", ACCENT), ' ', style(`${agent.name} (${agentKey})`, "bold")));
      item(`removed ${removed} command file(s)`, { glyph: sym.success, color: "green" });
    }

    if (getHookAgentConfig(agentKey)) {
      const hookResult = removeHooks(agentKey, projectRoot);
      if (hookResult) {
        if (hookResult.action === "deleted") {
          const path = join(projectRoot, hookResult.path);
          if (existsSync(path)) rmSync(path);
          item(`removed hook config ${hookResult.path}`, { glyph: sym.success, color: "green" });
        } else if (hookResult.action === "cleaned") {
          item(`cleaned hook entries from ${hookResult.path}`, {
            glyph: sym.success,
            color: "green",
          });
        } else if (hookResult.action === "manual") {
          item(`hook config merged into ${hookResult.path} — remove manually`, {
            glyph: sym.info,
            color: "yellow",
          });
        }
      }
    }
  }

  const dispatcherPath = join(projectRoot, ".agents", "dispatcher.mjs");
  if (existsSync(dispatcherPath)) {
    rmSync(dispatcherPath);
    out("");
    item(`Removed dispatcher: .agents/dispatcher.mjs`, { glyph: sym.success, color: "green" });
  }

  const hooksPath = join(projectRoot, ".hooks.json");
  if (existsSync(hooksPath)) {
    rmSync(hooksPath);
    item(`Removed .hooks.json`, { glyph: sym.success, color: "green" });
  }
  // Legacy manifest: still cleaned up on remove when present.
  const legacyManifestPath = join(projectRoot, ".events.json");
  if (existsSync(legacyManifestPath)) {
    rmSync(legacyManifestPath);
    item(`Removed .events.json`, { glyph: sym.success, color: "green" });
  }

  return 0;
}

// ── status ─────────────────────────────────────────────────────────────
export async function cmdStatus(args, flags) {
  const projectRoot = process.cwd();
  const agents = targetAgents(flags);
  const isGlobal = flags.global || false;

  const dispatcherInstalled = existsSync(join(projectRoot, ".agents", "dispatcher.mjs"));

  out("");
  out(
    panel({
      title: "Project",
      lines: [
        keyValue([
          ["Project:", projectRoot],
          ["ADLC:", detectAdlc(projectRoot) ? "detected" : "not detected"],
          ["Dispatcher:", dispatcherInstalled ? "installed" : "not installed"],
        ]),
      ],
    }),
  );

  const rows = [];
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

    const agentHookConfig = getHookAgentConfig(agentKey);
    let hookStatus = "n/a";
    if (agentHookConfig) {
      const configPath = join(projectRoot, agentHookConfig.config_file);
      hookStatus = existsSync(configPath) ? "installed" : "eligible";
    }

    rows.push([
      tint(agent.name, ACCENT),
      String(skills.length),
      String(commandCount),
      `${generatedCount} generated`,
      hookStatus,
    ]);
  }

  out("");
  out(
    table({
      title: "Installed skills",
      columns: [
        { header: "Agent", style: ACCENT },
        { header: "Skills", justify: "right" },
        { header: "Commands", justify: "right" },
        { header: "Generated", optional: true },
        { header: "Hooks" },
      ],
      rows,
    }),
  );
  out("");

  return 0;
}
