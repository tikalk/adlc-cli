// Agent commands: run a coding agent headlessly + list supported agents.

import { getRunProfile, AGENTS, RUN_PROFILES } from "../registry.mjs";
import { classifyAgentExit } from "../exit-codes.mjs";
import { runTask } from "../run.mjs";
import { normalizeLine } from "../run-events.mjs";
import { renderTextEvent, handleInlineHitl } from "../render.mjs";
import { appendFileSync } from "node:fs";
import { spawnCompat } from "../utils/spawn.mjs";

// ── run ────────────────────────────────────────────────────────────────
export async function cmdAgentRun(runArgs) {
  // Mock-agent seam (e2e hardening): when ADLC_MOCK_AGENT is set, record args
  // to a stub file and return 0 without spawning a live agent. Lets
  // workspace agent-led paths (init/link, commands, goal) run deterministically.
  if (process.env.ADLC_MOCK_AGENT && process.env.ADLC_MOCK_AGENT !== "0") {
    const file =
      process.env.ADLC_MOCK_AGENT_FILE ||
      process.env.ADLC_AGENT_STUB_FILE ||
      "./mock-agent.log";
    appendFileSync(file, JSON.stringify({ args: runArgs }) + "\n");
    return 0;
  }

  const { agent, model, format, requireApproval, prompt: rawPrompt, cwd, timeout } = parseRunArgs(runArgs);

  let prompt = rawPrompt;
  if (prompt === "__STDIN__") {
    const chunks = [];
    await new Promise((r) => {
      process.stdin.on("data", (c) => chunks.push(c)).on("end", r);
    });
    prompt = Buffer.concat(chunks).toString();
  }

  if (!prompt) {
    console.error("Error: task is required (pass a string, or '-' for stdin)");
    return 1;
  }

  let profile;
  try {
    profile = getRunProfile(agent);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  let timeoutHandle;
  const { promise, kill } = runTask({
    profile,
    prompt,
    model,
    requireApproval,
    cwd: cwd ?? process.cwd(),
    onLine: async (line) => {
      const events = normalizeLine(line, profile.outputFormat);
      for (const event of events) {
        if (format === "json") {
          process.stdout.write(JSON.stringify(event) + "\n");
        } else if (event.type === "permission_request" && process.stdin.isTTY) {
          await handleInlineHitl(event, kill);
        } else {
          renderTextEvent(event);
        }
      }
    },
  });

  if (timeout) {
    timeoutHandle = setTimeout(() => {
      console.error(`[run] timeout: killing agent after ${timeout}s`);
      kill("SIGTERM");
    }, timeout * 1000);
  }

  const { code, signal } = await promise;
  if (timeoutHandle) clearTimeout(timeoutHandle);
  return classifyAgentExit({ code, signal }).exitCode;
}

// ── interactive (TTY) handoff ──────────────────────────────────────────
// Launch the agent's interactive UI with the prompt seeded, instead of a
// headless one-shot run. Skills that are interactive wizards (e.g.
// /team-setup: mode selection + confirm) cannot complete headlessly — the
// model prints the question and the run exits.
// Returns the exit code, or null when the profile has no interactive form
// (caller falls back to headless).
export async function runAgentInteractive(agentKey, prompt, { cwd } = {}) {
  let profile;
  try {
    profile = getRunProfile(agentKey);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const spec = profile.interactive;
  if (!spec) return null;

  const env = { ...process.env, PWD: cwd ?? process.cwd() };
  if (profile.envVars) Object.assign(env, profile.envVars);

  return new Promise((resolvePromise) => {
    const child = spawnCompat(profile.binary, [...(spec.args ?? []), prompt], {
      cwd: cwd ?? process.cwd(),
      env,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      console.error(`[interactive] spawn error: ${err.message}`);
      resolvePromise(1);
    });
    child.on("exit", (code, signal) => {
      resolvePromise(classifyAgentExit({ code, signal }).exitCode);
    });
  });
}

function parseRunArgs(argv) {
  let agent = "opencode";
  let model = null;
  let format = "text";
  let requireApproval = null;
  let prompt = null;
  let cwd = null;
  let timeout = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-a" || arg === "--agent") {
      agent = argv[++i];
    } else if (arg === "--model") {
      model = argv[++i];
    } else if (arg === "--format") {
      format = argv[++i];
    } else if (arg === "--require-approval") {
      requireApproval = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--cwd") {
      cwd = argv[++i];
    } else if (arg === "--timeout") {
      timeout = parseInt(argv[++i], 10);
    } else if (arg === "-") {
      prompt = "__STDIN__";
    } else if (!arg.startsWith("-")) {
      prompt = arg;
    }
  }

  return { agent, model, format, requireApproval, prompt, cwd, timeout };
}

// ── list ───────────────────────────────────────────────────────────────
export function cmdAgentList() {
  console.log("Supported agents:\n");
  console.log("Key                 Name                Commands dir                    Format   Events  Run   Npx agent");
  console.log("─────────────────── ─────────────────── ─────────────────────────────── ──────── ─────── ───── ─────────────");

  for (const [key, agent] of Object.entries(AGENTS)) {
    if (key === "generic") continue;
    const hasRun = RUN_PROFILES[key] ? "yes" : "—";
    console.log(
      `${key.padEnd(20)}${agent.name.padEnd(20)}${(agent.commands_dir || "—").padEnd(31)}${agent.format.padEnd(9)}${(agent.events ? "yes" : "no").padEnd(8)}${hasRun.padEnd(6)}${agent.npx_agent || "universal"}`,
    );
  }

  console.log("\nUse -a <key> with 'skill add' or 'agent run'.");
  return 0;
}
