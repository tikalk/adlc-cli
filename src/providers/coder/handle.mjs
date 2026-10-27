import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resumeRun, normalizeWorkspaceName, isExitCode } from "../transport.mjs";

export { resumeRun };
export const resume = resumeRun;

// The name is used as a handle filename — normalize so it can never
// traverse outside the workspaces directory.
function handleFilePath(workspacesDir, name) {
  return join(workspacesDir, `${normalizeWorkspaceName(name)}.json`);
}

function readHandleFile(workspacesDir, name) {
  const path = handleFilePath(workspacesDir, name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("handle file does not contain a workspace object");
    }
    return parsed;
  } catch (err) {
    // A corrupt handle is not "no handle" — re-provisioning would silently
    // create a second machine. Fail loudly instead.
    throw new Error(
      `workspace handle at ${path} is unreadable (${err.message}) — refusing to provision a second workspace`
    );
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
    const persistedPath = handleFilePath(workspacesDir, name);
    if (!full.handlePath) full.handlePath = persistedPath;
    writeHandleFile(workspacesDir, name, full);
    handles.set(name, full);
    return full;
  }

  async function run(handle, input) {
    const h = typeof handle === "string" ? handles.get(handle) ?? { name: handle } : handle;
    return transport.exec(h, input);
  }

  async function* runStream(handle, input) {
    const h = typeof handle === "string" ? handles.get(handle) ?? { name: handle } : handle;
    if (typeof transport.execStream === "function") {
      const iterator = transport.execStream(h, input);
      let step = await iterator.next();
      while (!step.done) {
        if (typeof step.value === "string" && step.value !== "") yield step.value;
        step = await iterator.next();
      }
      const res = step.value;
      if (!res || typeof res !== "object" || !isExitCode(res.exitCode)) {
        throw new Error(
          "streaming transport returned no exit code — the remote result cannot be trusted"
        );
      }
      return {
        exitCode: Number(res.exitCode),
        stderr: String(res.stderr ?? ""),
      };
    }
    // Mock/injected transports only implement exec; preserve the contract by
    // replaying its buffered stdout line by line.
    const res = await transport.exec(h, input);
    if (!res || typeof res !== "object") {
      throw new Error("transport returned no result — the remote call cannot be trusted");
    }
    const stdout = String(res?.stdout ?? "");
    for (const line of stdout.split("\n")) {
      if (line !== "") yield line;
    }
    // The remote's exit code and stderr are the caller's verdict: a remote
    // failure must never read as a local success.
    if (!isExitCode(res.exitCode)) {
      throw new Error(
        "transport returned no exit code — the remote result cannot be trusted"
      );
    }
    return {
      exitCode: Number(res.exitCode),
      stderr: String(res.stderr ?? ""),
    };
  }

  function hasHandle(name) {
    // A corrupt handle must fail loudly: treating it as "no handle" would
    // provision a second machine and hide the corrupt file.
    return readHandleFile(workspacesDir, name) !== null;
  }

  return { provision, run, runStream, hasHandle };
}
