// Workspace commands: setup (workspace.yml-driven), init (brownfield), status (audit).
// Setup separates deterministic steps (git clone, dirs, skills add — no LLM) from
// agent-led steps (workspace init/link, commands, first-boot goal — via agent run).
// The goal runs only when setup assembled something (clone or dir creation) —
// AX-faithful first-boot workspace finishing; convergence re-runs skip it.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { parseYaml } from "../utils/yaml.mjs";
import { readAgent } from "../utils/init-options.mjs";
import {
  out,
  error,
  failure,
  warn,
  success,
  item,
  section,
  panel,
  keyValue,
  style,
  tint,
  sym,
  ACCENT,
} from "../ui/index.mjs";

// A section header for the workspace setup flow. A panel is not used here:
// git and the agent CLI write straight to the terminal, so a box would be
// torn apart by interleaved child output. The items are printed one at a
// time as they happen, so the header is the only part a shared primitive
// can own.
function sectionHeader(text) {
  section(text);
}

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

// Split credentials out of an HTTP(S) git URL. Git stores the clone URL in
// .git/config and exposes argv to the process table, so a credentialed URL
// must never reach either one. The caller supplies the credentials through
// GIT_ASKPASS instead.
export function splitGitCredentials(repo) {
  if (typeof repo !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(repo)) return null;
  let url;
  try {
    url = new URL(repo);
  } catch {
    return null;
  }
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  // For HTTP(S), a token in the username is a credential too. For other
  // schemes (ssh://), the username is routing information, not a secret;
  // preserve it unless there is a password to strip.
  if (isHttp ? !url.username && !url.password : !url.password) return null;
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const username = decode(url.username);
  const password = decode(url.password);
  if (isHttp) url.username = "";
  url.password = "";
  return { url: url.toString(), username, password };
}

function makeGitAskPass({ username, password }) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-git-askpass-"));
  const script = join(dir, "askpass.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  *Username*) printf \'%s\\n\' "$ADLC_GIT_USERNAME" ;;',
      '  *Password*) printf \'%s\\n\' "$ADLC_GIT_PASSWORD" ;;',
      "  *) printf '\\n' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 }
  );
  chmodSync(script, 0o700);
  return {
    dir,
    env: {
      GIT_ASKPASS: script,
      GIT_TERMINAL_PROMPT: "0",
      ADLC_GIT_USERNAME: username,
      ADLC_GIT_PASSWORD: password,
    },
  };
}

function secretPlaceholderOutsideUserinfo(rawRepo, secretValues) {
  const authority = String(rawRepo).match(/^([a-z+]+:\/\/)([^/@]*)@/i);
  const withoutUserinfo = authority
    ? String(rawRepo).replace(authority[0], authority[1])
    : String(rawRepo);
  return Object.keys(secretValues ?? {}).some(
    (key) => withoutUserinfo.includes(`\${${key}}`)
  );
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
    error(
      "no workspace file found. Pass a path/URL, set ADLC_WORKSPACE_FILE, or create .adlc/workspace.yml",
    );
    return 1;
  }

  // 2. Load workspace file (local file or HTTP)
  const content = await loadWorkspaceFile(source, projectRoot);
  if (content === null) return 1;

  // 3. Parse + validate. The provider path materializes the expanded config
  // as JSON so a process-env value can never inject YAML structure; the local
  // path accepts the same JSON form.
  let wsfile;
  try {
    const isJson = /\.json$/i.test(source) || content.trim().startsWith("{");
    if (!isJson && /^[ ]*\t/m.test(content)) {
      // Tabs are never valid YAML indentation — fail fast with a clear error
      // instead of silently mis-parsing (the minimal parser skips bad lines).
      throw new Error("tab indentation is not valid YAML (use spaces)");
    }
    wsfile = isJson ? JSON.parse(content) : parseYaml(content);
    // Workspace files are location-free: a `provider:` key is REJECTED, never
    // ignored — the same contract the provider path enforces.
    const { validateWorkspaceConfig } = await import("../providers/transport.mjs");
    validateWorkspaceConfig(wsfile);
  } catch (err) {
    error(`invalid workspace file: ${err.message}`);
    return 1;
  }
  if (!wsfile || typeof wsfile !== "object" || !wsfile.schema_version) {
    error(`workspace file missing schema_version (${source})`);
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
    const {
      expandWorkspaceVars,
      expansionEnv,
      loadSecretsEnv,
    } = await import("../providers/transport.mjs");
    // Secret-sourced and secret-SHAPED process-env values both stay as
    // placeholders in the plan. Collect the latter too, or a credential such
    // as GITLAB_TOKEN in the operator's environment would be inlined into the
    // printed goal while only secrets.env was masked.
    secretValues = loadSecretsEnv(projectRoot);
    const expandEnv = expansionEnv(projectRoot);
    for (const [key, value] of Object.entries(process.env)) {
      if (expandEnv[key] === `\${${key}}` && secretValues[key] === undefined) {
        secretValues[key] = value;
      }
    }
    wsfile = expandWorkspaceVars(wsfile, expandEnv);
  } catch (err) {
    error(err.message);
    return 1;
  }

  // 4. Resolve agent: -a flag > workspace agent: > init-options.json
  const agent = (flags.agents && flags.agents[0]) || wsfile.agent || readAgent();
  if (!agent) {
    error("agent required (-a <agent>, workspace agent:, or init-options.json)");
    return 1;
  }

  const dryRun = flags.dryRun || false;
  out("");
  out(
    panel({
      title: "Workspace",
      lines: [
        keyValue([
          ["Workspace:", wsfile.name || source],
          ["Agent:", agent + (dryRun ? "  [dry-run]" : "")],
        ]),
      ],
    }),
  );

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
    sectionHeader(`workspace.git (${gitModules.length} repo(s))`);
    for (const mod of gitModules) {
      if (!mod || !mod.repo || !mod.path) {
        failure("git entry missing repo or path");
        return 1;
      }
      if (typeof mod.path !== "string") {
        failure(`git entry path escapes the project root: ${mod.path}`);
        return 1;
      }
      const target = join(projectRoot, mod.path);
      if (existsSync(target)) {
        item(`${mod.path} (exists, skipping clone)`, { glyph: sym.exists, color: "gray" });
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
      if (secretPlaceholderOutsideUserinfo(mod.repo, secretValues)) {
        failure(
          "git entry has a secret placeholder outside the URL userinfo; " +
            "put HTTP(S) credentials in the userinfo or use a credential helper"
        );
        return 1;
      }
      const repo = resolveSecrets(mod.repo);
      const credentials = splitGitCredentials(repo);
      const safeRepo = credentials ? credentials.url : repo;
      if (
        Object.values(secretValues).some(
          (v) => typeof v === "string" && v.length >= 3 && safeRepo.includes(v)
        )
      ) {
        failure("git entry would place a secret value in the clone URL");
        return 1;
      }
      if (!isSafeGitRemote(safeRepo)) {
        failure(`git entry has an unsafe repo URL (ext:: helpers, leading -, whitespace, or shell metachars rejected): ${scrubSecretValues(mod.repo, secretValues)}`);
        return 1;
      }
      if (typeof mod.path !== "string" || !isPathWithinRoot(projectRoot, join(projectRoot, mod.path))) {
        failure(`git entry path escapes the project root: ${mod.path}`);
        return 1;
      }
      for (const ref of [mod.branch, mod.ref]) {
        if (ref !== undefined && ref !== null && !isSafeGitRef(String(ref))) {
          failure(`git entry has an unsafe branch/ref (must match [A-Za-z0-9._/-], no leading -, no ..): ${ref}`);
          return 1;
        }
      }
      changed = true;
      const gitArgs = ["clone", safeRepo, mod.path];
      if (mod.branch) gitArgs.push("--branch", resolveSecrets(mod.branch));
      // The printed plan must never carry a secret — not even a 2-character
      // one (the value-based scrub only masks needles of 3+ characters).
      const maskCredentials = (url) => {
        const carriesSecret = Object.values(secretValues).some(
          (v) => typeof v === "string" && v !== "" && url.includes(v)
        );
        if (!carriesSecret) return url;
        return url.replace(/([a-z+]+:\/\/)[^/@\s]+@/, `$1[REDACTED]@`);
      };
      const printable = maskCredentials(scrubSecretValues(gitArgs.join(" "), secretValues));
      item(`$ git ${printable}`, { glyph: sym.arrow, color: "gray" });
      if (!dryRun) {
        const askpass = credentials ? makeGitAskPass(credentials) : null;
        let result;
        try {
          result = spawnSync("git", gitArgs, {
            stdio: "inherit",
            cwd: projectRoot,
            env: askpass ? { ...process.env, ...askpass.env } : process.env,
          });
        } finally {
          if (askpass) rmSync(askpass.dir, { recursive: true, force: true });
        }
        if (result.status !== 0) {
          failure(`git clone failed for ${mod.path}`);
          return result.status || 1;
        }
        if (mod.ref) {
          const co = spawnSync("git", ["-C", mod.path, "checkout", resolveSecrets(mod.ref)], {
            stdio: "inherit",
            cwd: projectRoot,
          });
          if (co.status !== 0) {
            failure(`git checkout ${mod.ref} failed for ${mod.path}`);
            return co.status || 1;
          }
        }
      }
    }
  }

  // 5.5 workspace.dirs — deterministic empty-dir scaffolding (greenfield)
  const ws = wsfile.workspace || {};
  const dirs = ws.dirs;
  if (Array.isArray(dirs) && dirs.length > 0) {
    sectionHeader(`workspace.dirs (${dirs.length})`);
    for (const dir of dirs) {
      if (typeof dir !== "string" || !dir || dir.includes("..")) {
        failure(`invalid workspace.dirs entry: ${JSON.stringify(dir)}`);
        return 1;
      }
      const target = join(projectRoot, dir);
      if (existsSync(target)) {
        item(`${dir} (exists, skipping)`, { glyph: sym.exists, color: "gray" });
        continue;
      }
      changed = true;
      item(`mkdir -p ${dir}`, { glyph: sym.arrow, color: "gray" });
      if (!dryRun) mkdirSync(target, { recursive: true });
    }
  }

  // 6. workspace.init / workspace.link — agent-led (workspace skill)
  if (ws.init) {
    const linkFlag = ws.link ? " --link" : "";
    sectionHeader(`workspace init${ws.link ? " + link" : ""} (agent-led)`);
    if (dryRun) {
      item(`agent run -a ${agent} "Run /workspace --init${linkFlag}"`, {
        glyph: sym.arrow,
        color: "gray",
      });
    } else {
      const code = await cmdAgentRun(["-a", agent, `Run /workspace --init${linkFlag}`]);
      if (code !== 0) {
        failure("workspace init failed");
        return code || 1;
      }
    }
  }

  // 7. skills.sources — deterministic install (no LLM); -y: setup is non-interactive
  const sources = wsfile.skills && wsfile.skills.sources;
  if (Array.isArray(sources) && sources.length > 0) {
    sectionHeader(`skills.sources (${sources.length} source(s))`);
    for (const src of sources) {
      item(`skills add ${src}`, { glyph: sym.arrow, color: "gray" });
      if (!dryRun) {
        const code = await cmdAdd([src], { agents: [agent], yes: true });
        if (code !== 0) {
          failure(`skills add failed for ${src}`);
          return code || 1;
        }
      }
    }
  }

  // 8. commands — sequential, stop on first failure
  const commands = wsfile.commands;
  if (Array.isArray(commands) && commands.length > 0) {
    sectionHeader(`commands (${commands.length})`);
    for (const command of commands) {
      const code = await runWorkspaceCommand(String(command), agent, cmdAgentRun, cmdAdd, cmdTeamSetup, dryRun);
      if (code !== 0) {
        return code || 1;
      }
    }
  }

  // 9. goal — agent-led first-boot workspace finishing (AX binding model):
  // a plain-language description of the environment state, handed to an agent
  // once, when this run assembled the workspace. Re-runs skip it silently.
  let goalRan = false;
  if (wsfile.goal) {
    if (!changed) {
      sectionHeader("goal (first-boot only — nothing assembled this run, skipping)");
    } else {
      sectionHeader("goal (agent-led, first boot)");
      if (dryRun) {
        item(`agent run -a ${agent} "${wsfile.goal}"`, { glyph: sym.arrow, color: "gray" });
        goalRan = true;
      } else {
        const code = await cmdAgentRun(["-a", agent, wsfile.goal]);
        if (code !== 0) {
          failure("goal execution failed");
          return code || 1;
        }
        goalRan = true;
      }
    }
  }

  out("");
  success("Workspace setup complete.");
  if (!goalRan) {
    out(tint(`Next: adlc-cli agent run "<your goal>" -a ${agent}`, "gray"));
  }
  return 0;
}

async function loadWorkspaceFile(source, projectRoot) {
  if (isHttpUrl(source)) {
    // Warn-and-continue on plaintext transport: the operator sees the
    // downgrade, but setup still proceeds (fail-open for local mirrors).
    warn(`workspace file source uses plaintext http (prefer https): ${source}`);
  }
  if (/^https?:\/\//.test(source)) {
    try {
      const res = await fetch(source);
      if (!res.ok) {
        error(`failed to fetch workspace file from ${source} (HTTP ${res.status})`);
        return null;
      }
      return await res.text();
    } catch (err) {
      error(`failed to fetch workspace file from ${source}: ${err.message}`);
      return null;
    }
  }
  // Explicit argv/env/default paths are operator intent (env vars and absolute
  // args legitimately point outside the project), so no containment check here.
  // Containment IS enforced for paths declared inside the file (git entry paths).
  const path = resolve(projectRoot, source);
  if (!existsSync(path)) {
    error(`workspace file not found at ${path}`);
    return null;
  }
  return readFileSync(path, "utf-8");
}

async function runWorkspaceCommand(command, agent, cmdAgentRun, cmdAdd, cmdTeamSetup, dryRun) {
  const trimmed = command.trim();

  // agent run "<quoted prompt>" — prompts contain spaces/quotes
  let match = trimmed.match(/^agent run "([\s\S]*)"$/);
  if (match) {
    item(`agent run "${match[1]}"`, { glyph: sym.arrow, color: "gray" });
    if (dryRun) return 0;
    return await cmdAgentRun(["-a", agent, match[1]]);
  }
  // agent run <bare prompt>
  match = trimmed.match(/^agent run (.+)$/);
  if (match) {
    item(`agent run ${match[1]}`, { glyph: sym.arrow, color: "gray" });
    if (dryRun) return 0;
    return await cmdAgentRun(["-a", agent, match[1]]);
  }
  // skills add <source>
  match = trimmed.match(/^skills add (\S+)$/);
  if (match) {
    item(`skills add ${match[1]}`, { glyph: sym.arrow, color: "gray" });
    if (dryRun) return 0;
    return await cmdAdd([match[1]], { agents: [agent], yes: true });
  }
  // team setup <source>
  match = trimmed.match(/^team setup (\S+)$/);
  if (match) {
    item(`team setup ${match[1]}`, { glyph: sym.arrow, color: "gray" });
    if (dryRun) return 0;
    return await cmdTeamSetup([match[1]], { agents: [agent], yes: true });
  }

  failure(`unknown command: "${trimmed}" (supported: skills add, team setup, agent run)`);
  return 1;
}

// ── init (brownfield) ──────────────────────────────────────────────────
export async function cmdWorkspaceInit(args, flags) {
  const agent = (flags.agents && flags.agents[0]) || readAgent();
  if (!agent) {
    error("Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  let prompt = "Run /workspace --init";
  if (flags.link) prompt += " --link";
  else if (flags.ignoreOnly) prompt += " --ignore-only";

  if (flags.dryRun) {
    out(tint(`agent run -a ${agent} "${prompt}"`, "cyan"));
    return 0;
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  return cmdAgentRun(["-a", agent, prompt]);
}

// ── status (audit) ─────────────────────────────────────────────────────
export async function cmdWorkspaceStatus(args, flags) {
  const agent = (flags.agents && flags.agents[0]) || readAgent();
  if (!agent) {
    error("Agent required (-a <agent> or set in init-options.json)");
    return 1;
  }

  if (flags.dryRun) {
    out(tint(`agent run -a ${agent} "Run /workspace --status"`, "cyan"));
    return 0;
  }

  const { cmdAgentRun } = await import("./agent.mjs");
  return cmdAgentRun(["-a", agent, "Run /workspace --status"]);
}
