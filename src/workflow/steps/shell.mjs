// Shell step — run a local shell command.
// Ported from upstream spec-kit step/shell/__init__.py @ adbd62a.

import { exec } from "node:child_process";
import { StepBase, StepContext, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";
import { prepareStepOutput, readStepOutput, runContextEnv } from "./agent.mjs";
import { redactSecrets } from "../redact.mjs";

// Re-exported for existing consumers/tests; the implementation lives in
// ../redact.mjs so the refs transport can redact without importing a step.
export { redactSecrets } from "../redact.mjs";

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

    // `env:` — values the script needs from inputs or earlier steps, handed
    // over as environment variables. A templated value placed in `run` becomes
    // shell source (a quote in it ends the string, and the rest runs as a
    // command); a value placed here is only ever data: the script reads
    // "$NAME". Use it for anything an agent or a person wrote.
    const envError = ShellStep.envError(config);
    if (envError !== null) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: envError,
        output: { exit_code: -1, stdout: "", stderr: "invalid env" },
      });
    }
    const stepEnv = {};
    for (const [name, raw] of Object.entries(config.env ?? {})) {
      const value = typeof raw === "string" && raw.includes("{{") ? evaluateExpression(raw, context) : raw;
      stepEnv[name] = envText(value);
    }

    // Run context + structured output (ADR-444 §5), as for agent steps. A file
    // from an earlier attempt is removed first so a retry never surfaces it.
    // The run context wins over `env:` (ADLC_* names are refused there).
    const runEnv = runContextEnv(context, config);
    prepareStepOutput(runEnv.ADLC_STEP_OUTPUT);
    const env = { ...process.env, ...stepEnv, ...runEnv };
    if (context.workflowDir) {
      env.ADLC_WORKFLOW_DIR = context.workflowDir;
    } else {
      delete env.ADLC_WORKFLOW_DIR;
    }

    try {
      const proc = await execAsync(runCmd, { cwd, env, timeout: timeout * 1000 });
      // Redact before the streams enter the step result: it is saved to
      // state.json, which parkRun pushes to refs/factory-runs/<run_id> on the
      // remote, and its error reaches the pod log and Slack.
      if (proc.stdout != null) proc.stdout = redactSecrets(String(proc.stdout), env);
      if (proc.stderr != null) proc.stderr = redactSecrets(String(proc.stderr), env);
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
        stderr: proc.stderr ?? (err ? redactSecrets(String(err.message), env) : ""),
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
          error: `Shell command exited with code ${output.exit_code}.${stderrTail(output.stderr, env)}`,
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
        if (!(key in output)) output[key] = redactSecrets(value, env);
      }
      return new StepResult({ status: StepStatus.COMPLETED, output });
    } catch (err) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Shell command failed: ${redactSecrets(String(err.message))}`,
        output: { exit_code: -1, stdout: "", stderr: redactSecrets(String(err.message)) },
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

  // `env` must be a mapping of plain variable names to scalars. ADLC_* names
  // belong to the run context the engine sets (ADLC_RUN_ID, ADLC_STEP_OUTPUT,
  // ADLC_ISSUE_REF, …) and cannot be overridden from a workflow file.
  static envError(config) {
    if (!("env" in config) || config.env === null || config.env === undefined) return null;
    const env = config.env;
    if (typeof env !== "object" || Array.isArray(env)) {
      return `Shell step ${reprId(config)}: 'env' must be a mapping of variable names to values, got ${typeName(env)}.`;
    }
    for (const [name, value] of Object.entries(env)) {
      if (!ENV_NAME.test(name)) {
        return `Shell step ${reprId(config)}: 'env' name ${JSON.stringify(name)} must match ${ENV_NAME.source}.`;
      }
      if (/^ADLC_/i.test(name)) {
        return `Shell step ${reprId(config)}: 'env' name ${JSON.stringify(name)} is reserved (ADLC_* is set by the engine).`;
      }
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        return `Shell step ${reprId(config)}: 'env' value of ${JSON.stringify(name)} must be a string, number or boolean, got ${typeName(value)}.`;
      }
    }
    return null;
  }

  validate(config) {
    const errors = super.validate(config);
    const envError = ShellStep.envError(config);
    if (envError !== null) errors.push(envError);
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

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// An evaluated `env:` value as the text a process environment can hold. A
// missing value (an earlier step that reported nothing) is the empty string.
function envText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// The last stderr lines of a failed step, for its error message (what logs
// and notifiers such as Slack show). Redacted again here so the error is safe
// even for a caller passing raw text.
const STDERR_TAIL_CHARS = 500;
function stderrTail(stderr, env = process.env) {
  const text = redactSecrets(String(stderr ?? ""), env).trim();
  if (!text) return "";
  const tail = text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
  return ` stderr: ${tail}`;
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
