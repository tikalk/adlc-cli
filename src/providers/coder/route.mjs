import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml } from "../../utils/yaml.mjs";
import {
  validateWorkspaceConfig,
  expandWorkspaceVars,
  expansionEnv,
  collectReferencedVars,
  hopGuard,
  currentHopDepth,
  isExitCode,
  redactSecrets,
  loadSecretsEnv,
  normalizeWorkspaceName,
  scrubSecretValues,
  referencedSecretsEnv,
  referencedSecretValues,
  remoteInputs,
} from "../transport.mjs";
import { createCoderProvider } from "./handle.mjs";
import { createCoderSshTransport } from "./ssh.mjs";

const WORKSPACE_FILE = ".adlc/workspace.yml";

// Transport selection.
//
// The DEFAULT is the real SSH transport: a command that asks for a remote
// workspace must never silently get a mock (a mock "succeeds" without a
// remote existing — the worst possible failure for a pilot). The mock is
// opt-in for offline contract tests: ADLC_CODER_MOCK=1, or an injected
// transport (globalThis.__ADLC_CODER_TRANSPORT__).
export function resolveCoderTransport() {
  const injected = globalThis.__ADLC_CODER_TRANSPORT__;
  if (injected) return { transport: injected, live: false };
  if (process.env.ADLC_CODER_MOCK === "1") {
    return { transport: createMockTransport(), live: false };
  }
  return { transport: createCoderSshTransport(), live: true };
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

// The positional tokens in argv, decided by POSITION rather than text
// membership. Excluding a token because its text equals some flag's value
// silently drops a legitimate positional (a task that coincides with the
// `-a` value, a workflow source that coincides with `--format json`); the
// local CLI accepts both. The scan therefore walks argv: after a two-form
// valued flag (`--flag value`) the NEXT token is consumed as the value, and
// every remaining non-flag token is a positional.
function positionalTokens(tokens = []) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const arg = tokens[i];
    if (typeof arg !== "string") continue;
    if (!arg.startsWith("-")) {
      out.push(arg);
      continue;
    }
    let valued = null;
    for (const name of VALUED_FLAGS) {
      if (arg === name || arg.startsWith(`${name}=`)) {
        valued = name;
        break;
      }
    }
    if (valued === null) continue; // boolean or unknown flag: skip the flag only
    if (!arg.includes("=")) i++; // consume the two-form value (`--flag value`)
  }
  return out;
}

// The first real positional token. Flags are skipped positionally: a token
// is a flag's value when its FIRST occurrence in rawArgv directly follows a
// valued flag — decided by argv position, not by text membership
// (`agent run opencode -a opencode` keeps the task; an --input value split
// across the (args, argv) strings never becomes the source).
function isFlagValueToken(token, rawArgv = []) {
  if (typeof token !== "string") return false;
  const i = (rawArgv ?? []).indexOf(token);
  if (i <= 0) return false;
  return VALUED_FLAGS.includes(rawArgv[i - 1]);
}

function firstPositional(tokens = [], rawArgv = []) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token !== "string") continue;
    if (token.startsWith("-")) {
      // A two-form valued flag consumes the token after it (`--format json`).
      let valued = false;
      for (const name of VALUED_FLAGS) {
        if (token === name) {
          valued = true;
          break;
        }
      }
      if (valued && !token.includes("=")) i++;
      continue;
    }
    if (isFlagValueToken(token, rawArgv)) continue;
    return token;
  }
  return null;
}

// The value of a --flag, in either `--flag value` or `--flag=value` form.
// Missing, empty, or option-like values are absent — the same rule the local
// workflow command applies, so the remote invocation behaves identically.
function optionValue(rawArgv = [], name) {
  const flag = `--${name}`;
  const index = rawArgv.indexOf(flag);
  if (index !== -1) {
    const value = rawArgv[index + 1];
    if (value === undefined || value.startsWith("-")) return null;
    return value;
  }
  const inline = rawArgv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline === undefined) return null;
  const value = inline.slice(flag.length + 1);
  return value === "" ? null : value;
}

// The workspace name the user asked for explicitly (--workspace), or null.
// A present flag with no usable value is an error, never "absent": falling
// through would silently target the implicit/default workspace.
function explicitWorkspaceName(rawArgv = []) {
  for (let i = 0; i < rawArgv.length; i++) {
    const arg = rawArgv[i];
    if (arg === "--workspace" || arg === "-w") {
      const value = rawArgv[i + 1];
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error("--workspace requires a workspace name");
      }
      return normalizeWorkspaceName(value);
    }
    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length);
      if (value === "") {
        throw new Error("--workspace requires a workspace name");
      }
      return normalizeWorkspaceName(value);
    }
  }
  return null;
}

// The workspace name the resolved workspace file declares, when it can be
// resolved. Used as the implicit target so the exec routes address the
// workspace `workspace setup` provisioned (not a second "default" machine).
function implicitWorkspaceName(projectRoot) {
  const explicit = (process.env.ADLC_WORKSPACE_FILE || "").trim();
  const source =
    explicit || (existsSync(join(projectRoot, WORKSPACE_FILE)) ? WORKSPACE_FILE : null);
  if (!source) return null;
  const path = resolve(projectRoot, source);
  if (!existsSync(path)) {
    throw new Error(`workspace file not found at ${path}`);
  }
  const content = readFileSync(path, "utf-8");
  if (/^[ ]*\t/m.test(content)) {
    throw new Error("tab indentation is not valid YAML (use spaces)");
  }
  const parsed = parseYaml(content);
  if (!parsed || typeof parsed !== "object" || !parsed.name) return null;
  const expanded = expandWorkspaceVars(parsed, expansionEnv(projectRoot));
  return normalizeWorkspaceName(expanded.name);
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
  let index = 0;
  for (const value of values ?? []) {
    if (typeof value === "string" && value.length >= 3) out[`payload:${index++}`] = value;
  }
  return out;
}

// Scrub needles for the `--input key=value` pairs. A long value is a needle
// by itself. A short one must never be a bare needle: 1-2-char values would
// redact innocent text across the whole stream. Their echo travels as the
// pair the CLI forwards (`key=value`), so the PAIR is the needle instead —
// specific enough at any value length, and it never corrupts output.
function scrubValuePairs(inputs) {
  const out = {};
  let index = 0;
  for (const [key, value] of Object.entries(inputs ?? {})) {
    if (typeof value !== "string" || value === "") continue;
    if (value.length >= 3) out[`payload:${index++}`] = value;
    else out[`payload:${index++}`] = `${key}=${value}`;
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
  let implicit;
  try {
    implicit = implicitWorkspaceName(process.cwd());
  } catch (err) {
    return {
      ok: false,
      error: `Error: cannot resolve the workspace name from the workspace file: ${err.message}`,
    };
  }
  const name = implicit ?? "default";
  let hasHandle;
  try {
    hasHandle = provider.hasHandle(name);
  } catch (err) {
    return { ok: false, error: `Error: ${err.message}` };
  }
  if (!hasHandle) {
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
  const result = step.value;
  if (!result || typeof result !== "object" || !isExitCode(result.exitCode)) {
    throw new Error("streaming transport returned no exit code — refusing to report success");
  }
  const exitCode = Number(result.exitCode);
  const stderr = String(result.stderr ?? "");
  if (stderr.trim() !== "") console.error(redactLogLine(stderr, secrets));
  if (exitCode !== 0) {
    console.error(`Error: remote command failed (exit ${exitCode})`);
  }
  return { exitCode, stderr };
}

async function loadWorkspaceSource(source, projectRoot) {
  if (/^https?:\/\//.test(source)) {
    if (/^http:\/\//i.test(source)) {
      console.error(`Warning: workspace file source uses plaintext http (prefer https): ${source}`);
    }
    let res;
    try {
      res = await fetch(source);
    } catch (err) {
      console.error(`Error: failed to fetch workspace file from ${source}: ${err.message}`);
      return null;
    }
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
  // A remote dry-run is NOT a local preview: implementing one would still have
  // to provision (or reuse) a workspace and read its state. Refuse before any
  // provider call instead of pretending the plan is authoritative.
  if (flags?.dryRun) {
    console.error(
      "Error: --dry-run is not supported with --provider coder; refusing to provision a remote workspace. Run without --dry-run, or use the local workspace setup for a preview.",
    );
    return 1;
  }
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
  // Parse BEFORE expanding. Expanding raw YAML text lets a process-env value
  // containing a newline or `:` inject new keys into the document that the
  // remote setup then executes. Expand the parsed values instead, and send
  // the resulting object to the remote as JSON.
  let parsed;
  try {
    if (content.trim().startsWith("{")) {
      parsed = JSON.parse(content);
    } else {
      if (/^[ ]*\t/m.test(content)) {
        throw new Error("tab indentation is not valid YAML (use spaces)");
      }
      parsed = parseYaml(content);
    }
    validateWorkspaceConfig(parsed);
  } catch (err) {
    console.error(`Error: invalid workspace file: ${err.message}`);
    return 1;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.schema_version) {
    console.error(`Error: workspace file missing schema_version (${source})`);
    return 1;
  }
  // The references come from the ORIGINAL file: after expansion the
  // placeholders are gone, and nothing would be forwarded to the remote.
  const referenced = collectReferencedVars(parsed);
  let expanded;
  try {
    expanded = expandWorkspaceVars(parsed, expansionEnv(projectRoot));
    validateWorkspaceConfig(expanded);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  if (!expanded || typeof expanded !== "object" || !expanded.schema_version) {
    console.error(`Error: workspace file missing schema_version (${source})`);
    return 1;
  }
  const { transport } = resolveCoderTransport();
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  const requestedRaw = tryExplicitWorkspaceName(argv ?? []);
  const requested = typeof requestedRaw === "string" ? requestedRaw : null;
  if (requestedRaw && typeof requestedRaw === "object" && "error" in requestedRaw) {
    console.error(`Error: ${requestedRaw.error}`);
    return 1;
  }
  let name;
  try {
    name = normalizeWorkspaceName(expanded.name ?? "default");
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
  const secretValues = referencedSecretValues(referenced, projectRoot);
  const scrubVars = secretValues;
  // Forward the operator's agent selection to the remote local-setup command;
  // otherwise a `-a` on the provider invocation would be silently dropped.
  const remoteArgs = [];
  if (Array.isArray(flags?.agents) && flags.agents[0]) {
    remoteArgs.push("-a", flags.agents[0]);
  }
  const payload = JSON.stringify({
    op: "workspace.setup",
    args: remoteArgs,
    config: expanded,
    vars,
    secretKeys: Object.keys(secretValues),
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, scrubVars);
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
  // The provider/workspace flags are not part of the task: strip them before
  // the task is read, or the provider name is mistaken for the task.
  const cleanArgs = stripProviderArgs(runArgs ?? []);
  // The task is the last positional token — decided by POSITION, not by
  // value membership (`agent run opencode -a opencode` keeps the task).
  const positionals = positionalTokens(cleanArgs);
  let prompt = positionals.pop();
  let args = cleanArgs;
  if (prompt === undefined && cleanArgs.includes("-")) {
    // The documented stdin form: read the task from stdin and SEND it — the
    // remote agent must receive the task text, not the "-" marker.
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
    args = cleanArgs.map((a) => (a === "-" ? prompt : a));
  }
  if (!prompt) {
    console.error("Error: task is required (provider path: coder agent)");
    return 1;
  }
  const { transport } = resolveCoderTransport();
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
  const referenced = collectReferencedVars(cleanArgs);
  const rawAgentVars = referencedSecretsEnv(referenced);
  const payload = JSON.stringify({
    op: "agent.run",
    args,
    task: prompt,
    vars: rawAgentVars,
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  // The outbound stream is redacted: secret values, the task text and the
  // workspace name never reach the operator's terminal verbatim. Ordinary
  // referenced values (e.g. BRANCH=main) are not scrub needles.
  const agentVars = { ...referencedSecretValues(referenced), ...scrubValues([prompt]) };
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, agentVars);
    if (exitCode !== 0) return exitCode || 1;
  } catch (err) {
    console.error(`Error: remote agent run failed: ${err.message}`);
    return 1;
  }
  return 0;
}

export async function cmdCoderWorkflowResume(args, flags, rawArgv = []) {
  console.error("provider path: coder workflow resume");
  try {
    hopGuard();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  const runId = firstPositional(args ?? [], rawArgv ?? []);
  if (!runId) {
    console.error("Error: run ID required (provider path: coder workflow resume)");
    return 1;
  }
  const inputs = {};
  for (let i = 0; i < (rawArgv ?? []).length; i++) {
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
      console.error("Error: --input expects key=value");
      return 1;
    }
    const eq = pair.indexOf("=");
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const { transport } = resolveCoderTransport();
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  const target = await resolveTargetWorkspace(provider, rawArgv ?? [], "workflow resume");
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
  const remoteArgs = [];
  const format = optionValue(rawArgv ?? [], "format");
  if (format !== null) remoteArgs.push("--format", format);
  const rawVars = referencedSecretsEnv(collectReferencedVars(inputs));
  const payload = JSON.stringify({
    op: "workflow.resume",
    args: remoteArgs,
    runId,
    inputs,
    vars: rawVars,
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  const resumeVars = { ...referencedSecretValues(collectReferencedVars(inputs)), ...scrubValuePairs(inputs) };
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, resumeVars);
    if (exitCode !== 0) return exitCode || 1;
  } catch (err) {
    console.error(`Error: remote workflow resume failed: ${err.message}`);
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
      console.error("Error: --input expects key=value");
      return 1;
    }
    const eq = pair.indexOf("=");
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const { transport } = resolveCoderTransport();
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
  // Forward execution flags. --input stays in its dedicated channel so its
  // values keep the base64-safe transport; --format/--headless are plain
  // argv flags and must reach the remote workflow runner, not be dropped.
  const remoteArgs = [];
  const format = optionValue(rawArgv ?? [], "format");
  if (format !== null) remoteArgs.push("--format", format);
  if ((rawArgv ?? []).includes("--headless")) remoteArgs.push("--headless");
  const wfReferenced = collectReferencedVars(inputs);
  const rawWfVars = referencedSecretsEnv(wfReferenced);
  const payload = JSON.stringify({
    op: "workflow.run",
    args: remoteArgs,
    source,
    inputs,
    vars: rawWfVars,
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  const wfVars = { ...referencedSecretValues(wfReferenced), ...scrubValuePairs(inputs) };
  try {
    const { exitCode } = await streamRemote(provider, handle, payload, wfVars);
    if (exitCode !== 0) return exitCode || 1;
  } catch (err) {
    console.error(`Error: remote workflow run failed: ${err.message}`);
    return 1;
  }
  return 0;
}
