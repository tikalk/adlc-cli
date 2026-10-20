import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumeRun } from "./transport.mjs";

export { resumeRun };
export const resume = resumeRun;

function handleFilePath(workspacesDir, name) {
  return join(workspacesDir, `${name}.json`);
}

function readHandleFile(workspacesDir, name) {
  try {
    if (!existsSync(handleFilePath(workspacesDir, name))) return null;
    return JSON.parse(readFileSync(handleFilePath(workspacesDir, name), "utf-8"));
  } catch {
    return null;
  }
}

function writeHandleFile(workspacesDir, name, handle) {
  mkdirSync(workspacesDir, { recursive: true });
  writeFileSync(handleFilePath(workspacesDir, name), JSON.stringify(handle, null, 2));
}

// Coder provider adapter: provision/reuse remote machines via injectable transport.
export function createCoderProvider({ transport, workspacesDir = ".adlc/workspaces" } = {}) {
  if (!transport) {
    throw new Error("createCoderProvider requires a transport");
  }
  const handles = new Map();

  async function provision(name) {
    if (!name) {
      throw new Error("provision requires a workspace name");
    }
    if (handles.has(name)) {
      return handles.get(name);
    }
    const cached = readHandleFile(workspacesDir, name);
    if (cached && typeof cached === "object") {
      handles.set(name, cached);
      return cached;
    }
    const handle = await transport.provision(name);
    const full =
      handle && typeof handle === "object" ? { ...handle, name: handle.name ?? name } : { name };
    const persistedPath = join(workspacesDir, `${name}.json`);
    if (!full.handlePath) {
      full.handlePath = persistedPath;
      writeHandleFile(workspacesDir, name, full);
    } else if (join(full.handlePath) !== persistedPath) {
      writeHandleFile(workspacesDir, name, full);
    }
    handles.set(name, full);
    return full;
  }

  async function run(handle, input) {
    const h = typeof handle === "string" ? handles.get(handle) ?? { name: handle } : handle;
    return transport.exec(h, input);
  }

  async function* runStream(handle, input) {
    const h = typeof handle === "string" ? handles.get(handle) ?? { name: handle } : handle;
    const res = await transport.exec(h, input);
    const stdout = String(res?.stdout ?? "");
    for (const line of stdout.split("\n")) {
      if (line !== "") yield line;
    }
  }

  return { provision, run, runStream };
}
