// Agent-dispatch steps: prompt (arbitrary inline prompt) and command
// (invoke a factory skill/command). Adapted from upstream spec-kit
// step/prompt + step/command @ adbd62a: dispatch targets agent CLIs via
// adlc-cli's run.mjs profiles (registry.mjs) instead of the specify
// integration CLI — the ADR-390 adaptation.

import { StepBase, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";
import { runTask } from "../../run.mjs";
import { getRunProfile } from "../../registry.mjs";

const rid = (config) => `'${config.id ?? "?"}'`;

// Resolve the agent key: step > workflow default (context) > project default
// (.adlc/init-options.json). Returns null when nothing resolves — the step
// then fails with a clear message.
function resolveAgent(config, context) {
  return config.integration ?? context.defaultIntegration ?? null;
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
  return new StepResult({ status: StepStatus.COMPLETED, output });
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
