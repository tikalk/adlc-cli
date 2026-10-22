// Headless task runner: spawns a coding agent CLI with a prompt, streams
// stdout lines, forwards signals to the child process group, propagates exit.
// Ported from agentic-container/packages/runtime/src/engine/agent-registry.ts
// and process.ts (invocation + spawn half; normalization lives in run-events.mjs).

import { createInterface } from "node:readline";
import { spawnCompat, isWindows } from "./utils/spawn.mjs";
import { getRunProfile } from "./registry.mjs";
import { err, tint } from "./ui/index.mjs";

export function buildRunCommand(agentKey, prompt, opts = {}) {
  const profile = getRunProfile(agentKey);
  return buildCommandFromProfile(profile, prompt, opts);
}

function buildCommandFromProfile(profile, prompt, { model, requireApproval } = {}) {
  const args = [...profile.args];

  if (requireApproval?.length > 0) {
    const skipIdx = args.indexOf("--dangerously-skip-permissions");
    if (skipIdx !== -1) args.splice(skipIdx, 1);
  }

  if (model && profile.modelFlag) {
    args.push(profile.modelFlag, model);
  }

  if (profile.promptPosition === "arg") {
    args.push(prompt);
  }

  if (profile.permissionMode === "allowed-tools" && profile.allowedTools) {
    args.push("--allowedTools", profile.allowedTools.join(","));
  }

  const env = { ...process.env };
  if (profile.envVars) Object.assign(env, profile.envVars);

  return { cmd: profile.binary, args, env };
}

export function runTask({ profile, prompt, model, requireApproval, cwd, onLine }) {
  const { cmd, args, env } = buildCommandFromProfile(profile, prompt, { model, requireApproval });

  const childCwd = cwd ?? process.cwd();
  // Sync PWD with the spawn cwd — agents that resolve their project directory
  // from env.PWD (e.g. opencode) would otherwise land in the parent's cwd
  // (docker WORKDIR) instead of the requested workspace.
  env.PWD = childCwd;

  // Windows: agent binaries are .cmd/.bat npm shims (claude, gemini, ...) —
  // CreateProcess can't exec them directly (ENOENT); spawnCompat routes through
  // cmd.exe there. POSIX stays a direct exec.
  // detached is POSIX-only: it powers the kill(-pid) group signal below, but on
  // Windows shell:true + detached:true (DETACHED_PROCESS) drops the child's
  // stdout pipe — and negative-pid kills never worked there anyway.
  const child = spawnCompat(cmd, args, {
    cwd: childCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });

  const promise = new Promise((resolve) => {
    let resolved = false;

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      // Serialize line processing so an async onLine (e.g. HITL prompt)
      // blocks subsequent lines — same pattern as the container's adapter.
      let lineQueue = Promise.resolve();
      rl.on("line", (line) => {
        lineQueue = lineQueue
          .then(() => onLine(line))
          .catch((cause) => err(`${tint("[run]", "gray")} ${tint("line error:", "red")} ${cause}`));
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      err(`${tint("[run]", "gray")} ${tint("spawn error:", "red")} ${err.message}`);
      resolve({ code: 1, signal: null });
    });

    child.on("exit", (code, signal) => {
      if (resolved) return;
      resolved = true;
      resolve({ code, signal });
    });
  });

  const kill = (signal = "SIGTERM") => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // process group may not exist
    }
    setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, 5000).unref();
  };

  const onTerm = () => kill("SIGTERM");
  const onInt = () => kill("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  promise.then(() => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  });

  return { promise, kill };
}
