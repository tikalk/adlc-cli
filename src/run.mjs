// Headless task runner: spawns a coding agent CLI with a prompt, streams
// stdout lines, forwards signals to the child process group, propagates exit.
// Ported from agentic-container/packages/runtime/src/engine/agent-registry.ts
// and process.ts (invocation + spawn half; normalization lives in run-events.mjs).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { getRunProfile } from "./registry.mjs";

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

  const child = spawn(cmd, args, {
    cwd: cwd ?? process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
          .catch((err) => console.error("[run] line error:", err));
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }

    child.on("error", (err) => {
      if (resolved) return;
      resolved = true;
      console.error(`[run] spawn error: ${err.message}`);
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
