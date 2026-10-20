// Agent-dispatch steps: prompt (arbitrary inline prompt) and command
// (invoke a factory skill/command). Adapted from upstream spec-kit
// step/prompt + step/command @ adbd62a: dispatch targets agent CLIs via
// adlc-cli's run.mjs profiles (registry.mjs) instead of the specify
// integration CLI — the ADR-390 adaptation.

import { StepBase, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";
import { runTask } from "../../run.mjs";
import { getRunProfile } from "../../registry.mjs";
import { readAgent } from "../../utils/init-options.mjs";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const rid = (config) => `'${config.id ?? "?"}'`;

// Resolve the agent key: step > workflow default (context) > project default
// (.adlc/init-options.json). Returns null when nothing resolves — the step
// then fails with a clear message.
//
// The third tier was documented here but never implemented: any workflow
// relying on the project default alone (e.g. the bundled `factory` built-in,
// which sets neither a step nor a workflow integration) failed every agent
// step with "no agent/integration configured", even though .adlc/init-
// options.json had `agent` set to exactly what the error suggested setting.
function resolveAgent(config, context) {
  return config.integration ?? context.defaultIntegration ?? readAgent(context.projectRoot) ?? null;
}

async function runAgentStep({ agentKey, model, prompt, context, config, timeoutSec }) {
  if (!agentKey) {
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Step ${rid(config)}: no agent/integration configured. Set step 'integration:', workflow 'workflow.integration:', or .adlc/init-options.json agent.`,
      output: { integration: null, model: model ?? null, input: prompt, stdout: "", stderr: "", exit_code: -1 },
    });
  }
  let profile;
  try {
    profile = getRunProfile(agentKey);
  } catch {
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Step ${rid(config)}: unknown agent/integration ${JSON.stringify(agentKey)}. Run 'adlc-cli agent list' for supported keys.`,
      output: { integration: agentKey, model: model ?? null, input: prompt, stdout: "", stderr: "", exit_code: -1 },
    });
  }

  // Run context (ADR-444): who the step is and where it may leave a small
  // structured result. A file from an earlier attempt is removed first so a
  // retried step can never surface a stale value.
  const runEnv = runContextEnv(context, config);
  if (runEnv.ADLC_STEP_OUTPUT) {
    try { rmSync(runEnv.ADLC_STEP_OUTPUT, { force: true }); } catch {}
  }

  // runTask streams lines; collect them as the step's stdout.
  let stdout = "";
  let exit = { code: null, signal: null };
  let timedOut = false;
  let timer = null;

  const { promise, kill } = runTask({
    profile,
    prompt,
    model,
    cwd: context.projectRoot || process.cwd(),
    env: runEnv,
    onLine: (line) => {
      stdout += line + "\n";
    },
  });

  if (timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, timeoutSec * 1000);
    if (timer.unref) timer.unref();
  }

  const onInt = () => {
    timedOut = false;
    kill("SIGKILL");
  };
  process.on("SIGINT", onInt);

  try {
    exit = await promise;
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onInt);
  }

  const output = {
    integration: agentKey,
    model: model ?? null,
    input: prompt,
    stdout,
    stderr: "",
    exit_code: exit.code,
  };

  if (process.listenerCount("SIGINT") > 0 && exit.signal === "SIGINT") {
    output.interrupted = true;
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Agent step ${rid(config)} interrupted (SIGINT).`,
      output,
    });
  }
  if (exit.code !== 0) {
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Agent step ${rid(config)} exited with code ${exit.code ?? "signal " + exit.signal}.`,
      output,
    });
  }
  Object.assign(output, readStepOutput(runEnv.ADLC_STEP_OUTPUT, rid(config)));
  return new StepResult({ status: StepStatus.COMPLETED, output });
}

// ── run context + structured step output (ADR-444) ─────────────────────────

const RESERVED_OUTPUT_KEYS = new Set(["integration", "model", "input", "stdout", "stderr", "exit_code", "interrupted"]);
const OUTPUT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_OUTPUT_ENTRIES = 16;
const MAX_OUTPUT_VALUE = 2048;
// Generous bound on the raw file; any valid object is far smaller.
const MAX_OUTPUT_FILE = 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function runContextEnv(context, config) {
  const env = {};
  const runId = typeof context.runId === "string" ? context.runId : null;
  const stepId = typeof config.id === "string" ? config.id : null;
  if (runId) env.ADLC_RUN_ID = runId;
  if (stepId) env.ADLC_STEP_ID = stepId;
  // Path-safe ids only: the file is deleted before the step and read after it.
  if (runId && stepId && SAFE_ID.test(runId) && SAFE_ID.test(stepId) && context.projectRoot) {
    env.ADLC_STEP_OUTPUT = join(context.projectRoot, ".adlc", "workflows", "runs", runId, "steps", `${stepId}.output.json`);
  }
  const issueRef = context.inputs?.issue_ref;
  if (typeof issueRef === "string" && issueRef !== "") env.ADLC_ISSUE_REF = issueRef;
  return env;
}

// The step's structured result: a flat object of short strings, merged only
// when every entry is valid — otherwise nothing (and a log line). The values
// are untrusted; renderers sanitise them (links: safeMrLink).
function readStepOutput(path, stepRef) {
  if (!path || !existsSync(path)) return {};
  const reject = (why) => {
    console.error(`[workflow] step ${stepRef}: step output ignored (${why})`);
    return {};
  };
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return reject(`unreadable: ${err.message}`);
  }
  if (raw.length > MAX_OUTPUT_FILE) return reject("file too large");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return reject("not JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return reject("not a JSON object");
  const entries = Object.entries(data);
  if (entries.length > MAX_OUTPUT_ENTRIES) return reject(`more than ${MAX_OUTPUT_ENTRIES} fields`);
  for (const [key, value] of entries) {
    if (!OUTPUT_KEY.test(key)) return reject(`invalid key ${JSON.stringify(key)}`);
    if (RESERVED_OUTPUT_KEYS.has(key)) return reject(`reserved key ${JSON.stringify(key)}`);
    if (typeof value !== "string") return reject(`field ${key} is not a string`);
    if (value.length > MAX_OUTPUT_VALUE) return reject(`field ${key} exceeds ${MAX_OUTPUT_VALUE} characters`);
  }
  return Object.fromEntries(entries);
}

// ── prompt ───────────────────────────────────────────────────────────────

export class PromptStep extends StepBase {
  static typeKey = "prompt";

  async execute(config, context) {
    let prompt = config.prompt ?? "";
    if (typeof prompt === "string" && prompt.includes("{{")) {
      prompt = evaluateExpression(prompt, context);
    }
    prompt = String(prompt);

    const agentKey = resolveAgent(config, context);
    const model = config.model ?? context.defaultModel ?? null;
    const timeout = config.timeout ?? 3600;

    return runAgentStep({ agentKey, model, prompt, context, config, timeoutSec: timeout });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("prompt" in config)) {
      errors.push(`Prompt step ${rid(config)} is missing 'prompt' field.`);
    } else if (typeof config.prompt !== "string") {
      errors.push(`Prompt step ${rid(config)}: 'prompt' must be a string, got ${typeName(config.prompt)}.`);
    }
    if ("timeout" in config) {
      const t = config.timeout;
      if (typeof t === "boolean" || typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
        errors.push(`Prompt step ${rid(config)}: 'timeout' must be a positive number of seconds, got ${JSON.stringify(t)}.`);
      }
    }
    return errors;
  }
}

// ── command ──────────────────────────────────────────────────────────────

export class CommandStep extends StepBase {
  static typeKey = "command";

  async execute(config, context) {
    // In the factory port, `command:` names a factory skill/command — the
    // prompt is the command identifier plus resolved input args. The agent
    // resolves the command from its installed skills.
    const command = config.command ?? "";
    if (typeof command !== "string" || command === "") {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Command step ${rid(config)}: 'command' must be a non-empty string.`,
        output: { command: null, input: {}, stdout: "", stderr: "", exit_code: -1 },
      });
    }

    // Resolve input values (args + arbitrary keys) through expressions.
    const rawInput = config.input ?? {};
    const input = {};
    if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      for (const [key, value] of Object.entries(rawInput)) {
        if (typeof value === "string" && value.includes("{{")) {
          input[key] = evaluateExpression(value, context);
        } else {
          input[key] = value;
        }
      }
    }

    const agentKey = resolveAgent(config, context);
    const model = config.model ?? context.defaultModel ?? null;
    const options = config.options ?? {};
    const timeout = config.timeout ?? 3600;

    // Compose the dispatch prompt: "/<command> <args>" style — agents with
    // installed factory skills resolve the slash form natively.
    const args = input.args !== undefined ? String(input.args) : "";
    const extraOptions = Object.entries(options)
      .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${String(v)}`))
      .join(" ");
    const prompt = [`/${command}`, extraOptions, args].filter((s) => s !== "").join(" ");

    return runAgentStep({ agentKey, model, prompt, context, config, timeoutSec: timeout });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("command" in config)) {
      errors.push(`Command step ${rid(config)} is missing 'command' field.`);
    } else if (typeof config.command !== "string") {
      errors.push(`Command step ${rid(config)}: 'command' must be a string, got ${typeName(config.command)}.`);
    }
    const input = config.input;
    if (input !== null && input !== undefined &&
        (typeof input !== "object" || Array.isArray(input))) {
      errors.push(`Command step ${rid(config)}: 'input' must be a mapping, got ${typeName(input)}.`);
    }
    if ("timeout" in config) {
      const t = config.timeout;
      if (typeof t === "boolean" || typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
        errors.push(`Command step ${rid(config)}: 'timeout' must be a positive number of seconds, got ${JSON.stringify(t)}.`);
      }
    }
    return errors;
  }
}
