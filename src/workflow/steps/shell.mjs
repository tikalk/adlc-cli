// Shell step — run a local shell command.
// Ported from upstream spec-kit step/shell/__init__.py @ adbd62a.

import { exec } from "node:child_process";
import { StepBase, StepContext, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";
import { prepareStepOutput, readStepOutput, runContextEnv } from "./agent.mjs";

export class ShellStep extends StepBase {
  static typeKey = "shell";

  async execute(config, context) {
    let runCmd = config.run ?? "";
    if (typeof runCmd === "string" && runCmd.includes("{{")) {
      runCmd = evaluateExpression(runCmd, context);
    }
    runCmd = String(runCmd);

    const cwd = context.projectRoot || ".";
    const timeout = config.timeout ?? 300;
    const timeoutError = ShellStep.timeoutError(config);
    if (timeoutError !== null) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: timeoutError,
        output: { exit_code: -1, stdout: "", stderr: "invalid timeout" },
      });
    }

    // Run context + structured output (ADR-444 §5), as for agent steps. A file
    // from an earlier attempt is removed first so a retry never surfaces it.
    const runEnv = runContextEnv(context, config);
    prepareStepOutput(runEnv.ADLC_STEP_OUTPUT);
    const env = { ...process.env, ...runEnv };
    if (context.workflowDir) {
      env.ADLC_WORKFLOW_DIR = context.workflowDir;
    } else {
      delete env.ADLC_WORKFLOW_DIR;
    }

    try {
      const proc = await execAsync(runCmd, { cwd, env, timeout: timeout * 1000 });
      if (proc.interrupted) {
        return new StepResult({
          status: StepStatus.FAILED,
          error: "Shell command interrupted (SIGINT).",
          output: {
            exit_code: -1,
            stdout: proc.stdout ?? "",
            stderr: "interrupted",
            interrupted: true,
          },
        });
      }
      const err = proc.err;
      const exitCode = err ? (err.code ?? 1) : 0;
      const output = {
        exit_code: typeof exitCode === "number" ? exitCode : 1,
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? (err ? String(err.message) : ""),
      };
      if (err && err.killed) {
        return new StepResult({
          status: StepStatus.FAILED,
          error: `Shell command timed out after ${timeout} seconds.`,
          output: { exit_code: -1, stdout: output.stdout, stderr: "timeout" },
        });
      }
      if (err) {
        return new StepResult({
          status: StepStatus.FAILED,
          error: `Shell command exited with code ${output.exit_code}.${stderrTail(output.stderr)}`,
          output,
        });
      }
      if (config.output_format === "json") {
        // Opt-in structured output: expose parsed stdout under output.data.
        // A parse failure fails the step — declaring output_format: json is a contract.
        try {
          output.data = JSON.parse(proc.stdout);
        } catch (exc) {
          return new StepResult({
            status: StepStatus.FAILED,
            error: `Shell step ${reprId(config)} declared output_format: json but stdout is not valid JSON: ${exc.message}`,
            output,
          });
        }
      }
      // Never overwrite what the step itself reports (exit_code, stdout, data…).
      for (const [key, value] of Object.entries(readStepOutput(runEnv.ADLC_STEP_OUTPUT, reprId(config)))) {
        if (!(key in output)) output[key] = value;
      }
      return new StepResult({ status: StepStatus.COMPLETED, output });
    } catch (err) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Shell command failed: ${err.message}`,
        output: { exit_code: -1, stdout: "", stderr: String(err.message) },
      });
    }
  }

  static timeoutError(config) {
    if (!("timeout" in config)) return null;
    const timeout = config.timeout;
    const invalid =
      typeof timeout === "boolean" ||
      typeof timeout !== "number" ||
      !Number.isFinite(timeout) ||
      timeout <= 0;
    if (invalid) {
      return `Shell step ${reprId(config)}: 'timeout' must be a positive number of seconds, got ${JSON.stringify(timeout)}.`;
    }
    return null;
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("run" in config)) {
      errors.push(`Shell step ${reprId(config)} is missing 'run' field.`);
    } else if (typeof config.run !== "string") {
      errors.push(`Shell step ${reprId(config)}: 'run' must be a string, got ${typeName(config.run)}.`);
    }
    const outputFormat = config.output_format;
    if (outputFormat !== null && outputFormat !== undefined && outputFormat !== "json") {
      errors.push(`Shell step ${reprId(config)}: 'output_format' must be 'json' when present, got ${JSON.stringify(outputFormat)}.`);
    }
    const timeoutError = ShellStep.timeoutError(config);
    if (timeoutError !== null) errors.push(timeoutError);
    return errors;
  }
}

function reprId(config) {
  return `'${config.id ?? "?"}'`;
}

// The last stderr lines of a failed step, for its error message: the captured
// output stays in the step result, but the error is what logs and notifiers
// (Slack) show, so it is redacted before it leaves the step.
const STDERR_TAIL_CHARS = 500;
function stderrTail(stderr, env = process.env) {
  const text = redactSecrets(String(stderr ?? ""), env).trim();
  if (!text) return "";
  const tail = text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
  return ` stderr: ${tail}`;
}

// Secret-shaped env var names whose values never appear in an error message.
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
// Well-known token formats (GitLab, GitHub, Slack, Anthropic/OpenAI-style keys).
const TOKEN_PATTERNS = [
  /\bglpat-[A-Za-z0-9_-]{10,}/g,
  /\bgl(?:dt|rt|cbt|ptt|ft|imt|oas|agent|soat)-[A-Za-z0-9_-]{10,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
];

/** Mask credentials in text bound for logs or notifiers. */
export function redactSecrets(text, env = process.env) {
  let out = text
    // userinfo in URLs: https://user:token@host → https://***@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    // Authorization-style headers and key=value pairs
    .replace(/\b(authorization|private-token|x-api-key)(\s*[:=]\s*)(bearer\s+|basic\s+)?\S+/gi, "$1$2$3***");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "***");
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    out = out.split(value).join("***");
  }
  return out;
}

function execAsync(cmd, opts) {
  return new Promise((resolveP) => {
    let interrupted = false;
    const child = exec(cmd, opts, (err, stdout, stderr) => {
      process.off("SIGINT", onInt);
      resolveP({ err, stdout, stderr, interrupted });
    });
    // SIGINT while this command runs: kill the child and mark the run
    // interrupted so the engine converts the failure to PAUSED. The engine's
    // own flag still fires — this handler only owns the child's fate.
    const onInt = () => {
      interrupted = true;
      try { child.kill("SIGKILL"); } catch {}
    };
    process.on("SIGINT", onInt);
  });
}
