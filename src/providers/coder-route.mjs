import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml } from "../utils/yaml.mjs";
import {
  validateWorkspaceConfig,
  expandWorkspaceVars,
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
    expanded = expandWorkspaceVars(wsfile, { ...process.env, ...loadSecretsEnv(projectRoot) });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  const referenced = collectReferencedVars(wsfile);
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("workspace setup");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  let name;
  try {
    name = normalizeWorkspaceName(expanded.name ?? wsfile.name ?? "default");
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  expanded.name = name;
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
    vars: redactSecrets(vars),
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  try {
    for await (const line of provider.runStream(handle, payload)) console.log(redactLogLine(line, vars));
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
  const prompt = (runArgs ?? []).filter((a) => !a.startsWith("-")).pop();
  if (!prompt) {
    console.error("Error: task is required (provider path: coder agent)");
    return 1;
  }
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("agent run");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  let handle;
  try {
    handle = await provider.provision("default");
  } catch (err) {
    console.error(`Error: coder provision failed: ${err.message}`);
    return 1;
  }
  const cleanArgs = [];
  for (let i = 0; i < (runArgs ?? []).length; i++) {
    if (runArgs[i] === "--provider") { i++; continue; }
    if (runArgs[i].startsWith("--provider=")) continue;
    cleanArgs.push(runArgs[i]);
  }
  const rawAgentVars = referencedSecretsEnv(collectReferencedVars(cleanArgs));
  const payload = JSON.stringify({
    op: "agent.run",
    args: cleanArgs,
    vars: redactSecrets(rawAgentVars),
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  const agentVars = rawAgentVars;
  try {
    for await (const line of provider.runStream(handle, payload)) console.log(redactLogLine(line, agentVars));
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
  const source = (args ?? []).find((a) => !a.startsWith("-"));
  if (!source) {
    console.error(
      "Error: workflow source required (file path, installed ID, or built-in like 'factory') (provider path: coder workflow)",
    );
    return 1;
  }
  const inputs = {};
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === "--input" || rawArgv[i] === "-i") {
      const pair = rawArgv[++i];
      if (pair === undefined || !pair.includes("=")) {
        console.error(`Error: --input expects key=value (got ${JSON.stringify(pair)})`);
        return 1;
      }
      const eq = pair.indexOf("=");
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("workflow run");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  let handle;
  try {
    handle = await provider.provision("default");
  } catch (err) {
    console.error(`Error: coder provision failed: ${err.message}`);
    return 1;
  }
  const rawWfVars = referencedSecretsEnv(collectReferencedVars(inputs));
  const payload = JSON.stringify({
    op: "workflow.run",
    source,
    inputs: scrubSecretValues(redactSecrets(inputs), rawWfVars),
    vars: redactSecrets(rawWfVars),
    env: remoteInputs(),
    hop: currentHopDepth() + 1,
  });
  const wfVars = rawWfVars;
  try {
    for await (const line of provider.runStream(handle, payload)) console.log(redactLogLine(line, wfVars));
  } catch (err) {
    console.error(`Error: remote workflow run failed: ${err.message}`);
    return 1;
  }
  return 0;
}
