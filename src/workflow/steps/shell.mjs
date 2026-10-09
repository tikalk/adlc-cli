// Shell step — run a local shell command.
// Ported from upstream spec-kit step/shell/__init__.py @ adbd62a.

import { exec } from "node:child_process";
import { StepBase, StepContext, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";

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

    const env = { ...process.env };
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
          error: `Shell command exited with code ${output.exit_code}.`,
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
