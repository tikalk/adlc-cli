import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml } from "../utils/yaml.mjs";
import {
  validateWorkspaceConfig,
  expandWorkspaceVars,
  expansionEnv,
  collectReferencedVars,
  hopGuard,
  currentHopDepth,
  redactSecrets,
  loadSecretsEnv,
  normalizeWorkspaceName,
  scrubSecretValues,
  referencedSecretsEnv,
  remoteInputs,
} from "./transport.mjs";
import { createCoderProvider } from "./coder.mjs";

const WORKSPACE_FILE = ".adlc/workspace.yml";
const LIVE_MSG = "not implemented: live coder transport";

export function resolveCoderTransport() {
  const injected = globalThis.__ADLC_CODER_TRANSPORT__;
  if (injected) return { transport: injected, live: false };
  if (
    process.env.ADLC_CODER_LIVE === "1" ||
    process.env.ADLC_CODER_SSH_HOST ||
    process.env.CODER_SSH_HOST
  ) {
    return { transport: null, live: true };
  }
  return { transport: createMockTransport(), live: false };
}

function createMockTransport() {
  return {
    async provision(name) {
      return { name, host: `mock-${name}` };
    },
    async exec(handle, input) {
      return { stdout: String(input ?? ""), stderr: "", exitCode: 0 };
    },
  };
}

function redactLogLine(line, secrets = {}) {
  if (typeof line !== "string") return redactSecrets(scrubSecretValues(line, secrets));
  try {
    return JSON.stringify(redactSecrets(scrubSecretValues(JSON.parse(line), secrets)));
  } catch {
    return scrubSecretValues(line, secrets);
  }
}

// Flags whose value is a separate argument. Their values must never be
// mistaken for a positional (the workflow source, the agent task).
const VALUED_FLAGS = [
  "--provider", "--workspace", "-w", "--input", "-i",
  "-a", "--agent", "--model", "--format", "--cwd", "--timeout",
  "--require-approval", "--effort", "--skill", "-s",
];

function valuedFlagValues(rawArgv = []) {
  const values = new Set();
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    if (!arg.startsWith("-")) continue;
    for (const name of VALUED_FLAGS) {
      if (arg === name) {
        const value = rawArgv[i + 1];
        if (value !== undefined && !value.startsWith("-")) values.add(value);
        i++;
        break;
      }
      if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(name.length + 1);
        if (value !== "") values.add(value);
        break;
      }
    }
  }
  return values;
}

// The first real positional token — flag values excluded.
function firstPositional(tokens = [], rawArgv = []) {
  const consumed = valuedFlagValues(rawArgv);
  for (const token of tokens) {
    if (typeof token !== "string") continue;
    if (token.startsWith("-")) continue;
    if (consumed.has(token)) continue;
    return token;
  }
  return null;
}

// The workspace name the user asked for explicitly (--workspace), or null.
function explicitWorkspaceName(rawArgv = []) {
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    if (arg === "--workspace" || arg === "-w") {
      const value = rawArgv[i + 1];
      if (value && !value.startsWith("-")) return normalizeWorkspaceName(value);
    }
    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length);
      if (value !== "") return normalizeWorkspaceName(value);
    }
  }
  return null;
}

// The workspace name the repo's workspace file declares, when it can be
// resolved. Used as the implicit target so the exec routes address the
// workspace `workspace setup` provisioned (not a second "default" machine).
function implicitWorkspaceName(projectRoot) {
  try {
    const explicit = (process.env.ADLC_WORKSPACE_FILE || "").trim();
    const source =
      explicit || (existsSync(join(projectRoot, WORKSPACE_FILE)) ? WORKSPACE_FILE : null);
    if (!source) return null;
    const path = resolve(projectRoot, source);
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf-8");
    const parsed = parseYaml(content);
    if (!parsed || typeof parsed !== "object" || !parsed.name) return null;
    const expanded = expandWorkspaceVars(parsed, expansionEnv(projectRoot));
    return normalizeWorkspaceName(expanded.name);
  } catch {
    return null;
  }
}

// The workspace a route targets: --workspace <name> when given, else the
// workspace file's name, else "default". A named workspace reuses the
// handle persisted by `workspace setup` (.adlc/workspaces/<name>.json)
// instead of provisioning a second machine.
function workspaceName(rawArgv = []) {
  return explicitWorkspaceName(rawArgv) ?? "default";
}

// explicitWorkspaceName() throws on an unusable name — the callers report it
// as a CLI error, never a stack trace.
function tryExplicitWorkspaceName(rawArgv = []) {
  try {
    return explicitWorkspaceName(rawArgv);
  } catch (err) {
    return { error: err.message };
  }
}

// Strip the provider/workspace flags from an argument list.
function stripProviderArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider" || arg === "--workspace" || arg === "-w") {
      i++;
      continue;
    }
    if (arg.startsWith("--provider=") || arg.startsWith("--workspace=")) continue;
    out.push(arg);
  }
  return out;
}

// The values the payload carries that must never be echoed verbatim:
// input values and the task text. Keyed by a synthetic name so the existing
// scrub machinery can use them as needles.
function scrubValues(values) {
  const out = {};
  for (const value of values ?? []) {
    if (typeof value === "string" && value.length >= 3) out[`payload:${out.length}`] = value;
  }
  return out;
}

// Which workspace a route addresses, and whether that is allowed.
//   --workspace <name>  → explicit intent: provision-or-reuse that workspace
//   otherwise           → the workspace file's name; it must ALREADY have a
//                          handle, otherwise the route would silently create
//                          a second machine next to the provisioned one.
async function resolveTargetWorkspace(provider, rawArgv, what) {
  const explicit = tryExplicitWorkspaceName(rawArgv);
  if (typeof explicit === "object" && explicit !== null && "error" in explicit) {
    return { ok: false, error: `Error: ${explicit.error}` };
  }
  if (explicit) return { ok: true, name: explicit };
  const implicit = implicitWorkspaceName(process.cwd());
  const name = implicit ?? "default";
  if (!provider.hasHandle(name)) {
    return {
      ok: false,
      error:
        `Error: no workspace handle for '${name}' — run ` +
        "`adlc-cli workspace setup --provider coder` first, or pass --workspace <name>` " +
        `(provider path: coder ${what})`,
    };
  }
  return { ok: true, name };
}

// Stream the remote's output and report its verdict. A remote failure is a
// local failure: the exit code and stderr are surfaced, never swallowed.
async function streamRemote(provider, handle, payload, secrets = {}) {
  const iter = provider.runStream(handle, payload);
  let step = await iter.next();
  while (!step.done) {
    console.log(redactLogLine(step.value, secrets));
    step = await iter.next();
  }
  const result = step.value ?? { exitCode: 0, stderr: "" };
  const exitCode = Number(result.exitCode ?? 0);
  const stderr = String(result.stderr ?? "");
  if (exitCode !== 0) {
    if (stderr.trim() !== "") console.error(redactLogLine(stderr, secrets));
    console.error(`Error: remote command failed (exit ${exitCode})`);
  }
  return { exitCode, stderr };
}

function liveRequired(argv = []) {
  if (argv.includes("--live")) return true;
  return false;
}

function failLive(what) {
  console.error(`${LIVE_MSG} (${what} requires live SSH)`);
  return 1;
}

async function loadWorkspaceSource(source, projectRoot) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      console.error(`Error: failed to fetch workspace file from ${source} (HTTP ${res.status})`);
      return null;
    }
    return res.text();
  }
  const path = resolve(projectRoot, source);
  if (!existsSync(path)) {
    console.error(`Error: workspace file not found at ${path}`);
    return null;
  }
  return readFileSync(path, "utf-8");
}

export async function cmdCoderWorkspaceSetup(args, flags, argv = []) {
  console.error("provider path: coder workspace");
  try {
    hopGuard();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  if (liveRequired(argv)) return failLive("workspace setup");
  const projectRoot = process.cwd();
  const explicit = (args ?? []).find((a) => !a.startsWith("-"));
  const envFile = (process.env.ADLC_WORKSPACE_FILE || "").trim();
  const source =
    explicit ||
    (envFile !== "" ? envFile : null) ||
    (existsSync(join(projectRoot, WORKSPACE_FILE)) ? WORKSPACE_FILE : null);
  if (!source) {
    console.error(
      "Error: no workspace file found. Pass a path/URL, set ADLC_WORKSPACE_FILE, or create .adlc/workspace.yml (provider path: coder workspace)",
    );
    return 1;
  }
  let content;
  try {
    content = await loadWorkspaceSource(source, projectRoot);
  } catch (err) {
    console.error(`Error: failed to load workspace file: ${err.message}`);
    return 1;
  }
  if (content === null) return 1;
  let wsfile;
  try {
    if (/^[ ]*\t/m.test(content)) throw new Error("tab indentation is not valid YAML (use spaces)");
    wsfile = parseYaml(content);
    validateWorkspaceConfig(wsfile);
  } catch (err) {
    console.error(`Error: invalid workspace file: ${err.message}`);
    return 1;
  }
  if (!wsfile || typeof wsfile !== "object" || !wsfile.schema_version) {
    console.error(`Error: workspace file missing schema_version (${source})`);
    return 1;
  }
  let expanded;
  try {
    expanded = expandWorkspaceVars(wsfile, expansionEnv(projectRoot));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  const referenced = collectReferencedVars(wsfile);
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("workspace setup");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  const requestedRaw = tryExplicitWorkspaceName(argv ?? []);
  const requested = typeof requestedRaw === "string" ? requestedRaw : null;
  if (requestedRaw && typeof requestedRaw === "object" && "error" in requestedRaw) {
    console.error(`Error: ${requestedRaw.error}`);
    return 1;
  }
  let name;
  try {
    name = normalizeWorkspaceName(expanded.name ?? wsfile.name ?? "default");
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  expanded.name = name;
  if (requested && requested !== name) {
    console.error(
      `Error: --workspace ${requested} conflicts with the workspace file's name ${name} — ` +
        "workspace setup uses the file's name; --workspace targets an existing workspace"
    );
    return 1;
  }
  let handle;
  try {
    handle = await provider.provision(name);
  } catch (err) {
    console.error(`Error: coder provision failed: ${err.message}`);
    return 1;
  }
  const vars = referencedSecretsEnv(referenced, projectRoot);
  const payload = JSON.stringify({
    op: "workspace.setup",
    config: expanded,
    vars,
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, vars);
    if (exitCode !== 0) return exitCode || 1;
  } catch (err) {
    console.error(`Error: remote setup failed: ${err.message}`);
    return 1;
  }
  return 0;
}

export async function cmdCoderAgentRun(runArgs, argv = []) {
  console.error("provider path: coder agent");
  try {
    hopGuard();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  if (liveRequired(argv ?? runArgs ?? [])) return failLive("agent run");
  // The provider/workspace flags are not part of the task: strip them before
  // the task is read, or the provider name is mistaken for the task.
  const cleanArgs = stripProviderArgs(runArgs ?? []);
  // The task is the first positional that is not the value of a valued flag
  // (`-a opencode`, `--model x`, …) — otherwise a flag value is dispatched
  // as the prompt and a taskless run looks successful.
  const taskValues = valuedFlagValues(runArgs ?? []);
  const positionals = cleanArgs.filter(
    (a) => !a.startsWith("-") && !taskValues.has(a)
  );
  let prompt = positionals.pop();
  if (prompt === undefined && cleanArgs.includes("-")) {
    // The documented stdin form: read the task from stdin.
    try {
      prompt = readFileSync(0, "utf-8");
    } catch (err) {
      console.error(`Error: could not read the task from stdin: ${err.message}`);
      return 1;
    }
    if (prompt.trim() === "") {
      console.error("Error: task is required (stdin was empty; provider path: coder agent)");
      return 1;
    }
  }
  if (!prompt) {
    console.error("Error: task is required (provider path: coder agent)");
    return 1;
  }
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("agent run");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  const target = await resolveTargetWorkspace(provider, argv ?? [], "agent run");
  if (!target.ok) {
    console.error(target.error);
    return 1;
  }
  let handle;
  try {
    handle = await provider.provision(target.name);
  } catch (err) {
    console.error(`Error: coder provision failed: ${err.message}`);
    return 1;
  }
  const rawAgentVars = referencedSecretsEnv(collectReferencedVars(cleanArgs));
  const payload = JSON.stringify({
    op: "agent.run",
    args: cleanArgs,
    vars: rawAgentVars,
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  // The outbound stream is redacted: referenced values, the task text and
  // the workspace name never reach the operator's terminal verbatim.
  const agentVars = { ...rawAgentVars, ...scrubValues([prompt]) };
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, agentVars);
    if (exitCode !== 0) return exitCode || 1;
  } catch (err) {
    console.error(`Error: remote agent run failed: ${err.message}`);
    return 1;
  }
  return 0;
}

export async function cmdCoderWorkflowRun(args, flags, rawArgv = []) {
  console.error("provider path: coder workflow");
  try {
    hopGuard();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  if (liveRequired(rawArgv)) return failLive("workflow run");
  // The source is the first real positional — an --input/--provider value is
  // never the source.
  const source = firstPositional(args ?? [], rawArgv ?? []);
  if (!source) {
    console.error(
      "Error: workflow source required (file path, installed ID, or built-in like 'factory') (provider path: coder workflow)",
    );
    return 1;
  }
  const inputs = {};
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    let pair;
    if (arg === "--input" || arg === "-i") {
      pair = rawArgv[++i];
    } else if (arg.startsWith("--input=")) {
      pair = arg.slice("--input=".length);
    } else {
      continue;
    }
    if (pair === undefined || !pair.includes("=")) {
      console.error(`Error: --input expects key=value (got ${JSON.stringify(pair)})`);
      return 1;
    }
    const eq = pair.indexOf("=");
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("workflow run");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  const target = await resolveTargetWorkspace(provider, rawArgv ?? [], "workflow run");
  if (!target.ok) {
    console.error(target.error);
    return 1;
  }
  let handle;
  try {
    handle = await provider.provision(target.name);
  } catch (err) {
    console.error(`Error: coder provision failed: ${err.message}`);
    return 1;
  }
  const rawWfVars = referencedSecretsEnv(collectReferencedVars(inputs));
  const payload = JSON.stringify({
    op: "workflow.run",
    source,
    inputs,
    vars: rawWfVars,
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  const wfVars = { ...rawWfVars, ...scrubValues(Object.values(inputs)) };
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, wfVars);
    if (exitCode !== 0) return exitCode || 1;
  } catch (err) {
    console.error(`Error: remote workflow run failed: ${err.message}`);
    return 1;
  }
  return 0;
}
