// Agent commands: run a coding agent headlessly + list supported agents.

import { getRunProfile, AGENTS, RUN_PROFILES } from "../registry.mjs";
import { runTask } from "../run.mjs";
import { normalizeLine } from "../run-events.mjs";
import { renderTextEvent, handleInlineHitl } from "../render.mjs";

// ── run ────────────────────────────────────────────────────────────────
export async function cmdAgentRun(runArgs) {
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
  return code ?? (signal ? 130 : 1);
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
