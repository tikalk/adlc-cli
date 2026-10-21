// Workspace commands: setup (workspace.yml-driven), init (brownfield), status (audit).
// Setup separates deterministic steps (git clone, dirs, skills add — no LLM) from
// agent-led steps (workspace init/link, commands, first-boot goal — via agent run).
// The goal runs only when setup assembled something (clone or dir creation) —
// AX-faithful first-boot workspace finishing; convergence re-runs skip it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { parseYaml } from "../utils/yaml.mjs";
import { readAgent } from "../utils/init-options.mjs";

const WORKSPACE_FILE = ".adlc/workspace.yml";

// ── Security validators (skills.sh audit: Socket/Snyk/Gen) ─────────────
// Workspace files are agent-authored but may arrive from shared repos, so
// URLs, refs, and paths from them are untrusted input. These pure helpers
// are exported for unit testing.
export function isHttpUrl(source) {
  return /^http:\/\//i.test(source);
}

export function isHttpsUrl(source) {
  return /^https:\/\//i.test(source);
}

export function isSafeGitRemote(url) {
  // spawnSync argv-form already neutralizes shell metachars; these rules kill
  // the vectors argv-form does NOT stop: ext:: remote-helper command
  // execution and option injection (a repo/branch starting with -).
  // Local paths and file:// are legitimate (mirrors, test fixtures).
  // Windows local paths legitimately contain backslashes (C:\mirrors\repo,
  // UNC \\server\share), so they validate on a separate branch that allows
  // the separator but keeps every other rejection intact.
  if (typeof url !== "string" || url === "") return false;
  if (/^[\s-]/.test(url)) return false;
  if (/^[A-Za-z]:[\\/]/.test(url) || /^\\\\/.test(url)) {
    if (/[\s\x00-\x1f\x7f;|&$`'"]/.test(url)) return false;
    if (/^ext::/i.test(url)) return false;
    return true;
  }
  if (/[\s\x00-\x1f\x7f;|&$`'"\\]/.test(url)) return false;
  if (/^ext::/i.test(url)) return false;
  return true;
}

export function isSafeGitRef(ref) {
  return typeof ref === "string" && /^(?![-])(?!.*\.\.)[A-Za-z0-9._/-]+$/.test(ref);
}

export function isPathWithinRoot(root, candidate) {
  // Separator-aware containment: path.relative-based so Windows backslash
  // paths resolve correctly (the old normRoot + "/" suffix check falsely
  // rejected every legitimate relative entry on win32). isAbsolute dispatch
  // covers drive-letter and UNC absolutes, not just POSIX leading "/".
  if (typeof candidate !== "string") return false;
  const normRoot = resolve(root);
  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(normRoot, candidate);
  let base = normRoot;
  let target = abs;
  if (process.platform === "win32") {
    base = base.toLowerCase();
    target = target.toLowerCase();
  }
  const rel = relative(base, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) {
    return false;
  }
  return true;
}

// ── setup ──────────────────────────────────────────────────────────────
export async function cmdWorkspaceSetup(args, flags) {
  const projectRoot = process.cwd();

  // 1. Resolve workspace file source: explicit arg > ADLC_WORKSPACE_FILE env > local file
  const explicit = args.find((a) => !a.startsWith("-"));
  const envFile = (process.env.ADLC_WORKSPACE_FILE || "").trim();
  const source =
    explicit ||
    (envFile !== "" ? envFile : null) ||
    (existsSync(join(projectRoot, WORKSPACE_FILE)) ? WORKSPACE_FILE : null);

  if (!source) {
    console.error(
      "Error: no workspace file found. Pass a path/URL, set ADLC_WORKSPACE_FILE, or create .adlc/workspace.yml",
    );
    return 1;
  }

  // 2. Load workspace file (local file or HTTP)
  const content = await loadWorkspaceFile(source, projectRoot);
  if (content === null) return 1;

  // 3. Parse + validate
  let wsfile;
  try {
    // Tabs are never valid YAML indentation — fail fast with a clear error
    // instead of silently mis-parsing (the minimal parser skips bad lines).
    if (/^[ ]*\t/m.test(content)) {
      throw new Error("tab indentation is not valid YAML (use spaces)");
    }
    wsfile = parseYaml(content);
    // Workspace files are location-free: a `provider:` key is REJECTED, never
    // ignored — the same contract the provider path enforces.
    const { validateWorkspaceConfig } = await import("../providers/transport.mjs");
    validateWorkspaceConfig(wsfile);
  } catch (err) {
    console.error(`Error: invalid workspace file: ${err.message}`);
    return 1;
  }
  if (!wsfile || typeof wsfile !== "object" || !wsfile.schema_version) {
    console.error(`Error: workspace file missing schema_version (${source})`);
    return 1;
  }

  // 3.5 Expand ${VAR} — same contract as the provider path: fail fast on a
  // missing variable (naming it) so a repo-owned workspace file can carry
  // per-run values (e.g. name: ${WORKSPACE_NAME}, branch: ${BRANCH}).
  // Secret-sourced values (secrets.env / docker secrets) are kept as
  // placeholders here: the plan is printed to stdout, so a secret must never
  // be inlined into it. The placeholder is resolved only where the value is
  // actually used (the git argv), never in what is printed.
  let secretValues = {};
  try {
    const { expandWorkspaceVars, loadSecretsEnv } = await import("../providers/transport.mjs");
    secretValues = loadSecretsEnv(projectRoot);
    const expandEnv = { ...process.env };
    for (const key of Object.keys(secretValues)) expandEnv[key] = `\${${key}}`;
    wsfile = expandWorkspaceVars(wsfile, expandEnv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }

  // 4. Resolve agent: -a flag > workspace agent: > init-options.json
  const agent = (flags.agents && flags.agents[0]) || wsfile.agent || readAgent();
  if (!agent) {
    console.error("Error: agent required (-a <agent>, workspace agent:, or init-options.json)");
    return 1;
  }

  const dryRun = flags.dryRun || false;
  console.log(`Workspace: ${wsfile.name || source}`);
  console.log(`Agent: ${agent}${dryRun ? "  [dry-run]" : ""}`);

  const { cmdAgentRun } = await import("./agent.mjs");
  const { cmdAdd } = await import("./skills.mjs");
  const { cmdTeamSetup } = await import("./team.mjs");

  // First-boot signal: did this run actually assemble anything? The goal
  // (agent-led workspace finishing) runs only when true — re-runs converge
  // deterministically and skip it. init/skills/commands never count: init
  // always runs when declared, so counting it would re-fire the goal every time.
  let changed = false;

  // 5. workspace.git — deterministic clones (no LLM)
  const gitModules = wsfile.workspace && wsfile.workspace.git;
  if (Array.isArray(gitModules) && gitModules.length > 0) {
    console.log(`\n┌─ workspace.git (${gitModules.length} repo(s))`);
    for (const mod of gitModules) {
      if (!mod || !mod.repo || !mod.path) {
        console.error("│  ✗ git entry missing repo or path");
        console.log(`└─ failed`);
        return 1;
      }
      if (typeof mod.path !== "string") {
        console.error(`│  ✗ git entry path escapes the project root: ${mod.path}`);
        console.log(`└─ failed`);
        return 1;
      }
      const target = join(projectRoot, mod.path);
      if (existsSync(target)) {
        console.log(`│  = ${mod.path} (exists, skipping clone)`);
        continue;
      }
      // Secret-sourced values are kept as ${VAR} placeholders in the plan;
      // git needs the real value in its argv, so resolve it here — and never
      // print it (the plan is scrubbed).
      const { scrubSecretValues } = await import("../providers/transport.mjs");
      const resolveSecrets = (value) =>
        String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) =>
          secretValues[key] !== undefined ? secretValues[key] : match
        );
      const repo = resolveSecrets(mod.repo);
      if (!isSafeGitRemote(repo)) {
        console.error(`│  ✗ git entry has an unsafe repo URL (ext:: helpers, leading -, whitespace, or shell metachars rejected): ${scrubSecretValues(mod.repo, secretValues)}`);
        console.log(`└─ failed`);
        return 1;
      }
      if (typeof mod.path !== "string" || !isPathWithinRoot(projectRoot, join(projectRoot, mod.path))) {
        console.error(`│  ✗ git entry path escapes the project root: ${mod.path}`);
        console.log(`└─ failed`);
        return 1;
      }
      for (const ref of [mod.branch, mod.ref]) {
        if (ref !== undefined && ref !== null && !isSafeGitRef(String(ref))) {
          console.error(`│  ✗ git entry has an unsafe branch/ref (must match [A-Za-z0-9._/-], no leading -, no ..): ${ref}`);
          console.log(`└─ failed`);
          return 1;
        }
      }
      changed = true;
      const gitArgs = ["clone", repo, mod.path];
      if (mod.branch) gitArgs.push("--branch", resolveSecrets(mod.branch));
      console.log(`│  $ git ${scrubSecretValues(gitArgs.join(" "), secretValues)}`);
      if (!dryRun) {
        const result = spawnSync("git", gitArgs, { stdio: "inherit", cwd: projectRoot });
        if (result.status !== 0) {
          console.error(`│  ✗ git clone failed for ${mod.path}`);
          console.log(`└─ failed`);
          return result.status || 1;
        }
        if (mod.ref) {
          const co = spawnSync("git", ["-C", mod.path, "checkout", resolveSecrets(mod.ref)], {
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
  const ws = wsfile.workspace || {};
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
      changed = true;
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
  const sources = wsfile.skills && wsfile.skills.sources;
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
  const commands = wsfile.commands;
  if (Array.isArray(commands) && commands.length > 0) {
    console.log(`\n┌─ commands (${commands.length})`);
    for (const command of commands) {
      const code = await runWorkspaceCommand(String(command), agent, cmdAgentRun, cmdAdd, cmdTeamSetup, dryRun);
      if (code !== 0) {
        console.log(`└─ failed`);
        return code || 1;
      }
    }
    console.log(`└─ done`);
  }

  // 9. goal — agent-led first-boot workspace finishing (AX binding model):
  // a plain-language description of the environment state, handed to an agent
  // once, when this run assembled the workspace. Re-runs skip it silently.
  let goalRan = false;
  if (wsfile.goal) {
    if (!changed) {
      console.log(`\n┌─ goal (first-boot only — nothing assembled this run, skipping)`);
      console.log(`└─ done`);
    } else {
      console.log(`\n┌─ goal (agent-led, first boot)`);
      if (dryRun) {
        console.log(`│  agent run -a ${agent} "${wsfile.goal}"`);
        goalRan = true;
      } else {
        const code = await cmdAgentRun(["-a", agent, wsfile.goal]);
        if (code !== 0) {
          console.error("│  ✗ goal execution failed");
          console.log(`└─ failed`);
          return code || 1;
        }
        goalRan = true;
      }
      console.log(`└─ done`);
    }
  }

  console.log(`\nWorkspace setup complete.`);
  if (!goalRan) {
    console.log(`Next: adlc-cli agent run "<your goal>" -a ${agent}`);
  }
  return 0;
}

async function loadWorkspaceFile(source, projectRoot) {
  if (isHttpUrl(source)) {
    // Warn-and-continue on plaintext transport: the operator sees the
    // downgrade, but setup still proceeds (fail-open for local mirrors).
    console.warn(`Warning: workspace file source uses plaintext http (prefer https): ${source}`);
  }
  if (/^https?:\/\//.test(source)) {
    try {
      const res = await fetch(source);
      if (!res.ok) {
        console.error(`Error: failed to fetch workspace file from ${source} (HTTP ${res.status})`);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.error(`Error: failed to fetch workspace file from ${source}: ${err.message}`);
      return null;
    }
  }
  // Explicit argv/env/default paths are operator intent (env vars and absolute
  // args legitimately point outside the project), so no containment check here.
  // Containment IS enforced for paths declared inside the file (git entry paths).
  const path = resolve(projectRoot, source);
  if (!existsSync(path)) {
    console.error(`Error: workspace file not found at ${path}`);
    return null;
  }
  return readFileSync(path, "utf-8");
}

async function runWorkspaceCommand(command, agent, cmdAgentRun, cmdAdd, cmdTeamSetup, dryRun) {
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
