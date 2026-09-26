// Gate step — interactive human review gate.
// Ported from upstream spec-kit step/gate/__init__.py @ adbd62a.
// Non-TTY (CI, pipes) pauses for later resume; interactive prompts with a
// boxed chooser. verdict_input binds a workflow input as the headless choice.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { StepBase, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";

// Control characters except tab: C0 (incl. LF), DEL, C1 (incl. CSI). Stripped
// from anything derived from a show_file before it is printed — file contents
// and the path itself cannot inject ANSI/terminal escapes.
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

export class GateStep extends StepBase {
  static typeKey = "gate";

  // Maximum number of show_file lines rendered at the prompt.
  static MAX_SHOW_FILE_LINES = 200;

  async execute(config, context) {
    // Python get(key, default) substitutes only for an ABSENT key — an
    // explicit null must survive to the guards below and fail loudly
    // (upstream comment: a bare ``on_reject:`` yields None and must not
    // silently walk past the review). `??` would wrongly default nulls.
    const has = (k, d) => (k in config ? config[k] : d);

    let message = has("message", "Review required.");
    if (typeof message === "string" && message.includes("{{")) {
      message = evaluateExpression(message, context);
    }

    const options = has("options", ["approve", "reject"]);
    const onReject = has("on_reject", "abort");
    const hasVerdictInput = "verdict_input" in config;
    const verdictInput = config.verdict_input;

    // Fail loudly on malformed config (engine does not auto-validate before execute).
    if (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string")) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${rid(config)}: 'options' must be a non-empty list of strings, got ${typeName(options)}.`,
        output: { message, options, on_reject: onReject, choice: null },
      });
    }
    if (!["abort", "skip", "retry"].includes(onReject)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${rid(config)}: 'on_reject' must be 'abort', 'skip', or 'retry', got ${JSON.stringify(onReject)}.`,
        output: { message, options, on_reject: onReject, choice: null },
      });
    }
    if (hasVerdictInput && (typeof verdictInput !== "string" || verdictInput === "")) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${rid(config)}: 'verdict_input' must be a non-empty string.`,
      });
    }
    if (hasVerdictInput && context.insideFanOut) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Gate step ${rid(config)}: 'verdict_input' is not supported inside fan-out templates.`,
      });
    }

    let showFile = "show_file" in config ? config.show_file : undefined;
    if (typeof showFile === "string" && showFile.includes("{{")) {
      showFile = evaluateExpression(showFile, context);
    }
    if (showFile !== null && showFile !== undefined) {
      showFile = String(showFile);
    }

    const output = {
      message,
      options,
      on_reject: onReject,
      show_file: showFile,
      choice: null,
    };

    let choice = null;
    let boundVerdictInput = null;
    if (verdictInput !== null && verdictInput !== undefined) {
      const value = context.inputs[verdictInput];
      if (value !== null && value !== undefined && value !== "") {
        if (typeof value !== "string") {
          return new StepResult({
            status: StepStatus.FAILED,
            output,
            error: `Gate step ${rid(config)}: verdict input ${JSON.stringify(verdictInput)} must be a string, got ${typeName(value)}.`,
          });
        }
        choice = options.find((option) => option.toLowerCase() === value.toLowerCase()) ?? null;
        if (choice === null || choice === undefined) {
          return new StepResult({
            status: StepStatus.FAILED,
            output,
            error: `Gate step ${rid(config)}: verdict input ${JSON.stringify(verdictInput)} value ${JSON.stringify(value)} does not match any configured option.`,
          });
        }
        boundVerdictInput = verdictInput;
      }
    }

    if (choice === null || choice === undefined) {
      // Non-interactive: pause for later resume (the file is not read here).
      if (!process.stdin.isTTY) {
        return new StepResult({ status: StepStatus.PAUSED, output });
      }

      // Interactive: prompt the user; show_file contents are folded into the
      // displayed message so the operator can review before choosing.
      choice = await GateStep.prompt(
        GateStep.composePrompt(message, showFile),
        options,
      );
    }
    output.choice = choice;

    // Match rejection case-insensitively, agreeing with validate().
    if (choice.toLowerCase() === "reject" || choice.toLowerCase() === "abort") {
      if (onReject === "abort") {
        output.aborted = true;
        return new StepResult({
          status: StepStatus.FAILED,
          output,
          error: `Gate rejected by user at step ${rid(config)}`,
        });
      }
      if (onReject === "retry") {
        // Pause so the next resume re-executes this gate.
        if (boundVerdictInput !== null) {
          context.inputs[boundVerdictInput] = "";
        }
        return new StepResult({ status: StepStatus.PAUSED, output });
      }
      // on_reject === "skip" → completed, downstream steps decide.
      return new StepResult({ status: StepStatus.COMPLETED, output });
    }

    return new StepResult({ status: StepStatus.COMPLETED, output });
  }

  static composePrompt(message, showFile) {
    const text = String(message);
    if (!showFile) return text;
    const header = `${String(showFile).replace(CONTROL_CHARS, "")}:`;
    const body = [header, ...GateStep.readShowFile(showFile).map((line) => `  ${line}`)].join("\n");
    return `${text}\n\n${body}`;
  }

  static async prompt(message, options) {
    console.log("\n  ┌─ Gate ─────────────────────────────────────");
    for (const line of message.split("\n")) {
      console.log(line ? `  │ ${line}` : "  │");
    }
    console.log("  │");
    options.forEach((opt, i) => console.log(`  │  [${i + 1}] ${opt}`));
    console.log("  └────────────────────────────────────────────");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const askOnce = () =>
      new Promise((resolveP) => {
        let settled = false;
        const done = (v) => {
          if (!settled) {
            settled = true;
            resolveP(v);
          }
        };
        rl.question(`  Choose [1-${options.length}]: `, (answer) => done({ interrupted: false, answer }));
        // Ctrl-C / EOF during the question: default to the last option
        // (usually reject), mirroring upstream's EOFError/KeyboardInterrupt.
        rl.on("close", () => done({ interrupted: true }));
      });

    try {
      while (true) {
        const { interrupted, answer } = await askOnce();
        if (interrupted) {
          console.log();
          return options[options.length - 1];
        }
        const raw = answer.trim();
        if (/^\d+$/.test(raw) && 1 <= parseInt(raw, 10) && parseInt(raw, 10) <= options.length) {
          return options[parseInt(raw, 10) - 1];
        }
        const lower = raw.toLowerCase();
        if (options.some((o) => o.toLowerCase() === lower)) {
          return options.find((o) => o.toLowerCase() === lower);
        }
        console.log(`  Invalid choice. Enter 1-${options.length} or an option name.`);
      }
    } finally {
      rl.close();
    }
  }

  static readShowFile(showFile) {
    const lines = [];
    let truncated = false;
    try {
      const content = readFileSync(showFile, "utf-8");
      for (const line of content.split("\n")) {
        if (lines.length >= GateStep.MAX_SHOW_FILE_LINES) {
          truncated = true;
          break;
        }
        lines.push(line.replace(/\r?\n$/, "").replace(CONTROL_CHARS, ""));
      }
    } catch (exc) {
      return [`(could not read file: ${String(exc.message ?? exc).replace(CONTROL_CHARS, "")})`];
    }
    if (lines.length === 0 && !truncated) return ["(file is empty)"];
    if (truncated) {
      lines.push(`… (output truncated at ${GateStep.MAX_SHOW_FILE_LINES} lines)`);
    }
    return lines;
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("message" in config)) {
      errors.push(`Gate step ${rid(config)} is missing 'message' field.`);
    }
    const options = config.options ?? ["approve", "reject"];
    if (!Array.isArray(options) || options.length === 0) {
      errors.push(`Gate step ${rid(config)}: 'options' must be a non-empty list.`);
    } else if (!options.every((o) => typeof o === "string")) {
      errors.push(`Gate step ${rid(config)}: all options must be strings.`);
    }
    const onReject = config.on_reject ?? "abort";
    if (!["abort", "skip", "retry"].includes(onReject)) {
      errors.push(`Gate step ${rid(config)}: 'on_reject' must be 'abort', 'skip', or 'retry'.`);
    }
    if ("verdict_input" in config && (typeof config.verdict_input !== "string" || config.verdict_input === "")) {
      errors.push(`Gate step ${rid(config)}: 'verdict_input' must be a non-empty string.`);
    }
    if (
      (onReject === "abort" || onReject === "retry") &&
      Array.isArray(options) &&
      options.every((o) => typeof o === "string")
    ) {
      const rejectChoices = ["reject", "abort"];
      if (!options.some((o) => rejectChoices.includes(o.toLowerCase()))) {
        errors.push(`Gate step ${rid(config)}: on_reject=${JSON.stringify(onReject)} but options has no 'reject' or 'abort' choice.`);
      }
    }
    return errors;
  }
}

function rid(config) {
  return `'${config.id ?? "?"}'`;
}
