import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml } from "../utils/yaml.mjs";
import {
  validateWorkspaceConfig,
  expandWorkspaceVars,
  collectReferencedVars,
  checkHopDepth,
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
      return { name, host: `mock-${name}`, handlePath: `.adlc/workspaces/${name}.json` };
    },
    async exec(handle, input) {
      return { stdout: String(input ?? ""), stderr: "", exitCode: 0 };
    },
  };
}

function hopGuard() {
  const depth = Number(process.env.ADLC_HOP_DEPTH ?? 0) + 1;
  checkHopDepth(depth);
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
  console.log("provider path: coder workspace");
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
    expanded = expandWorkspaceVars(wsfile, process.env);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
  const referenced = collectReferencedVars(wsfile);
  const { transport, live } = resolveCoderTransport();
  if (live || !transport) return failLive("workspace setup");
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  const name = wsfile.name ?? "default";
  let handle;
  try {
    handle = await provider.provision(name);
  } catch (err) {
    console.error(`Error: coder provision failed: ${err.message}`);
    return 1;
  }
  const vars = {};
  for (const k of referenced) if (process.env[k] !== undefined) vars[k] = process.env[k];
  const payload = JSON.stringify({ op: "workspace.setup", config: expanded, vars });
  try {
    for await (const line of provider.runStream(handle, payload)) console.log(line);
  } catch (err) {
    console.error(`Error: remote setup failed: ${err.message}`);
    return 1;
  }
  return 0;
}

export async function cmdCoderAgentRun(runArgs, argv = []) {
  console.log("provider path: coder agent");
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
  const payload = JSON.stringify({ op: "agent.run", args: cleanArgs });
  try {
    for await (const line of provider.runStream(handle, payload)) console.log(line);
  } catch (err) {
    console.error(`Error: remote agent run failed: ${err.message}`);
    return 1;
  }
  return 0;
}

export async function cmdCoderWorkflowRun(args, flags, rawArgv = []) {
  console.log("provider path: coder workflow");
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
  const payload = JSON.stringify({ op: "workflow.run", source, inputs });
  try {
    for await (const line of provider.runStream(handle, payload)) console.log(line);
  } catch (err) {
    console.error(`Error: remote workflow run failed: ${err.message}`);
    return 1;
  }
  return 0;
}
