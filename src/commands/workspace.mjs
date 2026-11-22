// Workspace commands: setup (workspace.yml-driven), init (brownfield), status (audit).
// Setup separates deterministic steps (git clone, dirs, skills add, workspace
// init/link via the workspace skill's scripts — no LLM) from agent-led steps
// (`agent run` commands, first-boot goal; init/link only as a fallback).
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
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { parseYaml } from "../utils/yaml.mjs";
import { readAgent } from "../utils/init-options.mjs";
import { getAgent } from "../registry.mjs";
import { expandTilde } from "../source.mjs";
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

// ── workspace init/link (deterministic) ─────────────────────────────────
const GITIGNORE_COMMIT_MSG = "[workspace] Configure .gitignore for workspace conventions";
// Tracked files setup itself writes (skills add / team setup), relative to
// the project root.
const SETUP_OWNED_FILES = [".adlc/init-options.json"];
// A hung skill script must not hang setup; init/link finish in seconds.
const WORKSPACE_SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;

// The workspace scripts print one JSON object (pretty-printed by jq) on
// stdout; null when there is none.
function parseScriptJson(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  if (start === -1) return null;
  try {
    const value = JSON.parse(text.slice(start));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// The workspace skill's bash scripts in the agent's project skills dir, or
// null when the skill is not installed (or on Windows, where the skill's
// PowerShell variant would need an agent to drive it).
function resolveWorkspaceScripts(projectRoot, agentKey) {
  if (process.platform === "win32") return null;
  const agentDef = getAgent(agentKey);
  if (!agentDef || !agentDef.skills_dir) return null;
  const dir = resolve(projectRoot, expandTilde(agentDef.skills_dir), "workspace", "scripts", "bash");
  const init = join(dir, "setup-workspace.sh");
  const link = join(dir, "workspace.sh");
  return existsSync(init) && existsSync(link) ? { init, link } : null;
}

// Mirrors the workspace skill's --init/--link contract without an agent:
// setup-workspace.sh --json, append (never remove) the .gitignore rules it
// reports missing and commit them, then workspace.sh --json --link.
async function runWorkspaceInit(projectRoot, agent, link, dryRun, cmdAgentRun, dirtyBefore = null) {
  const linkFlag = link ? " --link" : "";
  sectionHeader(`workspace init${link ? " + link" : ""}`);
  const scripts = resolveWorkspaceScripts(projectRoot, agent);
  if (dryRun && process.platform === "win32") {
    item(`agent run -a ${agent} "Run /workspace --init${linkFlag}"`, { glyph: sym.arrow, color: "gray" });
    return 0;
  }
  if (dryRun) {
    const agentDef = getAgent(agent);
    const base = join((agentDef && agentDef.skills_dir) || "<skills_dir>", "workspace", "scripts", "bash");
    item(`$ bash ${join(base, "setup-workspace.sh")} --json`, { glyph: sym.arrow, color: "gray" });
    if (link) item(`$ bash ${join(base, "workspace.sh")} --json --link`, { glyph: sym.arrow, color: "gray" });
    item(`(fallback when the workspace skill is not installed: agent run -a ${agent} "Run /workspace --init${linkFlag}")`, {
      glyph: sym.arrow,
      color: "gray",
    });
    return 0;
  }
  if (!scripts) {
    item(`workspace skill scripts not installed — agent-led fallback`, { glyph: sym.arrow, color: "gray" });
    item(`agent run -a ${agent} "Run /workspace --init${linkFlag}"`, { glyph: sym.arrow, color: "gray" });
    const code = await cmdAgentRun(["-a", agent, `Run /workspace --init${linkFlag}`]);
    if (code !== 0) {
      failure("workspace init failed");
      return code || 1;
    }
    return 0;
  }

  item(`$ bash ${relative(projectRoot, scripts.init)} --json`, { glyph: sym.arrow, color: "gray" });
  const init = spawnSync("bash", [scripts.init, "--json"], {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: WORKSPACE_SCRIPT_TIMEOUT_MS,
  });
  if (init.status !== 0) {
    failure(`workspace init script failed (${init.status === null ? `killed: ${init.signal}` : `exit ${init.status}`})`);
    return init.status || 1;
  }
  const report = parseScriptJson(init.stdout);
  if (!report) {
    failure("workspace init script did not emit JSON");
    return 1;
  }
  // Fail closed on a report that breaks the skill's contract.
  if (!Array.isArray(report.GITIGNORE_RULES_MISSING)) {
    failure("workspace init report has no GITIGNORE_RULES_MISSING array");
    return 1;
  }
  const missing = report.GITIGNORE_RULES_MISSING.filter(
    (r) => typeof r === "string" && r !== "" && !/[\r\n]/.test(r)
  );
  const dropped = report.GITIGNORE_RULES_MISSING.length - missing.length;
  if (dropped > 0) {
    item(`ignored ${dropped} malformed .gitignore rule(s) from the init report`, {
      glyph: sym.info,
      color: "yellow",
    });
  }
  if (missing.length > 0) {
    const code = appendGitignoreRules(projectRoot, missing);
    if (code !== 0) return code;
  }

  if (link) {
    item(`$ bash ${relative(projectRoot, scripts.link)} --json --link`, { glyph: sym.arrow, color: "gray" });
    // Before this step, init ran on the clean clone. Now skills install runs
    // first and rewrites tracked files (.adlc/init-options.json), and
    // workspace.sh --link refuses on any tracked change — so set aside only
    // the files setup itself changed, and put them back afterwards.
    const res = withSetupChangesSetAside(projectRoot, dirtyBefore, () =>
      spawnSync("bash", [scripts.link, "--json", "--link"], {
        cwd: projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
        timeout: WORKSPACE_SCRIPT_TIMEOUT_MS,
      })
    );
    if (res === null) {
      failure("could not set aside setup's own changes for --link (git checkout failed)");
      return 1;
    }
    const linkOut = String(res.stdout || "");
    if (res.status !== 0) {
      // On refusal the script's JSON carries the reason; show it raw.
      process.stdout.write(linkOut);
      failure(`workspace link script failed (${res.status === null ? `killed: ${res.signal}` : `exit ${res.status}`})`);
      return res.status || 1;
    }
    // workspace.sh exits 0 even when a repo fails to link — the errors are
    // only in its JSON report, which an agent would have read.
    const linkReport = parseScriptJson(linkOut);
    if (!linkReport) {
      failure("workspace link script did not emit JSON");
      return 1;
    }
    if (!Number.isInteger(linkReport.ERROR_COUNT)) {
      failure("workspace link report has no numeric ERROR_COUNT");
      return 1;
    }
    const count = (key) => (Number.isInteger(linkReport[key]) ? linkReport[key] : "?");
    item(
      `link: ${count("REGISTERED_COUNT")} registered, ${count("SKIPPED_COUNT")} skipped, ${linkReport.ERROR_COUNT} error(s)`,
      { glyph: sym.arrow, color: "gray" }
    );
    if (linkReport.ERROR_COUNT > 0) {
      const errors = Array.isArray(linkReport.ERRORS) ? linkReport.ERRORS.join("; ") : "";
      failure(`workspace link reported ${linkReport.ERROR_COUNT} error(s)${errors ? `: ${errors}` : ""}`);
      return 1;
    }
  }
  return 0;
}

// Tracked paths (relative to the repo top level) that differ from HEAD,
// staged or not, plus the top level itself; null outside a git work tree.
// -z keeps non-ASCII paths unquoted (core.quotepath).
export function trackedChanges(projectRoot) {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot, encoding: "utf-8" });
  if (top.status !== 0) return null;
  const root = top.stdout.trim();
  const diff = spawnSync("git", ["diff", "-z", "--name-only", "HEAD"], { cwd: root, encoding: "utf-8" });
  if (diff.status !== 0) return null;
  return { root, paths: new Set(diff.stdout.split("\0").filter(Boolean)) };
}

// Runs fn with the tracked files setup changed since `before` restored to
// HEAD, then writes setup's versions back (also when fn throws). Contract:
// fn (workspace.sh --link) must not write those files, since the restore
// would overwrite its changes. Returns null when they cannot be set aside.
function withSetupChangesSetAside(projectRoot, before, fn) {
  const now = before ? trackedChanges(projectRoot) : null;
  // Files setup owns are set aside even when already changed before this run
  // (e.g. by a previous setup run); their contents are written back as-is.
  const owned = now
    ? SETUP_OWNED_FILES.map((f) => relative(now.root, join(projectRoot, f)).split(sep).join("/"))
    : [];
  const changed = now ? [...now.paths].filter((p) => !before.paths.has(p) || owned.includes(p)) : [];
  if (changed.length === 0) return fn();
  const saved = changed.map((p) => {
    const file = join(now.root, p);
    return { file, content: existsSync(file) ? readFileSync(file) : null };
  });
  item(`setting aside setup's own changes for --link: ${changed.join(", ")}`, { glyph: sym.arrow, color: "gray" });
  const checkout = spawnSync("git", ["checkout", "HEAD", "--", ...changed], { cwd: now.root, stdio: "inherit" });
  try {
    return checkout.status === 0 ? fn() : null;
  } finally {
    for (const { file, content } of saved) {
      if (content === null) rmSync(file, { force: true });
      else writeFileSync(file, content);
    }
  }
}

function appendGitignoreRules(projectRoot, rules) {
  const file = join(projectRoot, ".gitignore");
  // Never write through a symlink: it could point outside the project.
  let isLink = false;
  try {
    isLink = lstatSync(file).isSymbolicLink();
  } catch {
    // no .gitignore yet
  }
  if (isLink) {
    failure(".gitignore is a symlink — refusing to append workspace rules");
    return 1;
  }
  const current = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const present = new Set(current.split(/\r?\n/));
  const toAdd = [...new Set(rules)].filter((r) => !present.has(r));
  if (toAdd.length === 0) return 0;
  const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
  try {
    writeFileSync(file, current + prefix + toAdd.join("\n") + "\n", "utf-8");
  } catch (err) {
    failure(`could not write .gitignore: ${err.message}`);
    return 1;
  }
  item(`.gitignore: added ${toAdd.length} rule(s)`, { glyph: sym.arrow, color: "gray" });
  // The skill commits the rules; outside a git work tree (greenfield, no
  // `git init` yet) there is nothing to commit to.
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectRoot, encoding: "utf-8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return 0;
  const add = spawnSync("git", ["add", "--", ".gitignore"], { cwd: projectRoot, stdio: "inherit" });
  const commit =
    add.status === 0
      ? spawnSync("git", ["commit", "-q", "-m", GITIGNORE_COMMIT_MSG, "--", ".gitignore"], {
          cwd: projectRoot,
          stdio: "inherit",
        })
      : add;
  if (commit.status !== 0) {
    failure("could not commit .gitignore rules");
    return commit.status || 1;
  }
  return 0;
}

// True when `dir` is a real directory (not a symlink) with no entries, e.g.
// an uninitialized submodule placeholder left by a non-recursive clone. A
// symlink never counts as empty: cloning into one could write outside the
// project root.
function isEmptyDir(dir) {
  try {
    return lstatSync(dir).isDirectory() && readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

// True when `path` is registered as a submodule path in projectRoot's
// .gitmodules (false with no .gitmodules, outside a git repo, or unregistered).
function isRegisteredSubmodule(projectRoot, path) {
  if (!existsSync(join(projectRoot, ".gitmodules"))) return false;
  const r = spawnSync(
    "git",
    ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { cwd: projectRoot, encoding: "utf-8" }
  );
  if (r.status !== 0) return false;
  const want = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return r.stdout
    .split("\n")
    .some((line) => line.slice(line.indexOf(" ") + 1).trim() === want);
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

export function makeGitAskPass({ username, password }) {
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
      if (existsSync(target) && !isEmptyDir(target)) {
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
      // An empty dir at a registered submodule path is a non-recursive clone's
      // placeholder: check it out at the superproject's pinned commit instead
      // of skipping it (git clone into an empty dir covers the other case).
      if (existsSync(target) && isRegisteredSubmodule(projectRoot, mod.path)) {
        // git fetches from the URL in .gitmodules (the trusted superproject's),
        // not from mod.repo; git's protocol policy applies to it.
        const subArgs = ["submodule", "update", "--init", "--", mod.path];
        item(`$ git ${subArgs.join(" ")}`, { glyph: sym.arrow, color: "gray" });
        if (mod.branch || mod.ref) {
          item(`branch/ref ignored for submodule ${mod.path} (the superproject pins its commit)`, {
            glyph: sym.arrow,
            color: "gray",
          });
        }
        if (!dryRun) {
          const result = spawnSync("git", subArgs, { stdio: "inherit", cwd: projectRoot });
          if (result.status !== 0) {
            failure(`git submodule update failed for ${mod.path}`);
            return result.status || 1;
          }
        }
        continue;
      }
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

  // 5.7 devcontainer trigger — thin `devcontainer up` (no emulation, #101).
  // Fires on declaration only (.devcontainer/devcontainer.json >
  // .devcontainer.json > skip), never on a provider flag (ADR-443).
  // Deterministic, no LLM: readiness wait, exact exit-code propagation,
  // dry-run silence. Fail-fast before skills/agent-led steps.
  {
    const { runDevcontainerTrigger } = await import("../utils/devcontainer.mjs");
    sectionHeader("devcontainer (step 5.7)");
    const trigger = runDevcontainerTrigger({
      projectRoot,
      dryRun,
      out: (line) => item(line.replace(/^  → /, ""), { glyph: sym.arrow, color: "gray" }),
    });
    if (trigger.ran) {
      if (trigger.code !== 0) {
        failure(trigger.error || "devcontainer up failed");
        return trigger.code || 1;
      }
      if (!dryRun) changed = true;
    } else {
      item("no devcontainer declaration (skipping)", { glyph: sym.exists, color: "gray" });
    }
  }

  // Tracked files already changed before setup installs skills: `--link`
  // must still refuse on those, but not on files setup itself changes below.
  const dirtyBeforeSkills = !dryRun && ws.init && ws.link ? trackedChanges(projectRoot) : null;

  // 6. skills.sources — deterministic install (no LLM); -y: setup is non-interactive.
  // Runs before init so the workspace skill's scripts exist when init needs them.
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

  // 7. workspace.init / workspace.link — the installed workspace skill's own
  // scripts, run directly (no LLM). Agent-led only as a fallback when the
  // skill (or bash) is not available.
  if (ws.init) {
    const code = await runWorkspaceInit(projectRoot, agent, !!ws.link, dryRun, cmdAgentRun, dirtyBeforeSkills);
    if (code !== 0) return code;
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
  // team setup <source> [--directives <path>]
  match = trimmed.match(/^team setup (\S+)(?:\s+([\s\S]+))?$/);
  if (match) {
    item(`team setup ${match[1]}`, { glyph: sym.arrow, color: "gray" });
    if (dryRun) return 0;
    const extra = match[2] ? match[2].trim().split(/\s+/) : [];
    const directivesIdx = extra.indexOf("--directives");
    const directives = directivesIdx !== -1 ? extra[directivesIdx + 1] : undefined;
    if (directivesIdx !== -1 && !directives) {
      failure(`team setup: --directives requires a path`);
      return 1;
    }
    return await cmdTeamSetup([match[1]], { agents: [agent], yes: true, ...(directives ? { directives } : {}) });
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
