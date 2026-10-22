// Gate step — interactive human review gate.
// Ported from upstream spec-kit step/gate/__init__.py @ adbd62a.
// Non-TTY (CI, pipes) pauses for later resume; interactive prompts with a
// boxed chooser. verdict_input binds a workflow input as the headless choice.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { StepBase, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";
import {
  CONTROL_CHARS,
  PERMANENT_UNAVAILABLE,
  buildGateManifest,
  currentHeadSha,
  renderGateMessage,
  safeMrLink,
  uncommittedRecords,
  validateGateContext,
} from "../gate-context.mjs";
import { out, panel, style, tint, combine, sanitize, sanitizeLines, sym, ACCENT } from "../../ui/index.mjs";

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
    if ("context" in config) {
      const contextErrors = validateGateContext(config, rid(config));
      if (contextErrors.length > 0) {
        return new StepResult({ status: StepStatus.FAILED, error: contextErrors.join(" ") });
      }
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

    // Decision manifest (ADR-391-amendment-gate-decision-context): only a
    // gate that declares `context` gets one — a gate without it keeps its
    // static message and output shape exactly. When this gate paused with a
    // manifest and HEAD has not moved since, that manifest is what the
    // approver saw and is reused verbatim; otherwise a fresh one is built.
    let manifest = null;
    let shownManifest = null;
    let shownUnavailableKind = null;
    let unavailableReason = null;
    let unavailableKind = null;
    if ("context" in config) {
      // The list comes from git history, so drafts not committed yet could
      // never be shown, and an approval would not cover them: halt instead
      // of pausing (ADR-391-amendment-3 §7).
      const dirty = uncommittedRecords(context.projectRoot, config.context.records);
      if (dirty.length > 0) {
        return new StepResult({
          status: StepStatus.FAILED,
          output,
          error: `Gate step ${rid(config)}: uncommitted drafts: ${dirty.map((p) => p.replace(CONTROL_CHARS, "")).join(", ")} — commit them before the gate.`,
        });
      }
      const previous = context.steps?.[config.id];
      shownManifest = pausedManifest(previous);
      shownUnavailableKind = shownManifest === null ? pausedUnavailableKind(previous) : null;
      if (shownManifest && currentHeadSha(context.projectRoot) === shownManifest.head_sha) {
        manifest = shownManifest;
      } else {
        const built = buildGateManifest({
          records: config.context.records,
          projectRoot: context.projectRoot,
          lastApprovedSha: context.gateRun?.lastApprovedSha ?? null,
          runStartSha: context.gateRun?.runStartSha ?? null,
        });
        unavailableReason = built.unavailable;
        unavailableKind = built.unavailable ? built.unavailable_kind : null;
        const mrLink = gateMrLink(config.context, context);
        manifest = {
          message: renderGateMessage(message, built, mrLink),
          decisions: built.decisions,
          since_sha: built.since_sha,
          no_changes: built.no_changes,
          truncated_count: built.truncated_count,
          head_sha: built.head_sha,
          // Persisted in the paused output: what the approver was shown (T2).
          ...(unavailableReason ? { unavailable_reason: unavailableReason, unavailable_kind: unavailableKind } : {}),
          ...(mrLink ? { mr_link: mrLink } : {}),
        };
      }
      Object.assign(output, manifest);
    }

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

    // A context gate's headless approval covers exactly the manifest shown at
    // its pause. With no shown manifest (verdict preset or shared with an
    // earlier gate, or the pause had no list), clear the verdict and pause
    // with the fresh manifest so the approver decides on what is actually
    // there (ADR-422: gates halt). A moved head is handled separately below
    // (ADR-391-amendment-3 §4): it halts rather than landing here.
    // Exception (S1, T2): the pause said "Decision list unavailable" for a
    // permanent, structural reason (not-a-git-repo / no-target-branch) and
    // the fresh build reports the identical kind — there is nothing more to
    // show, so the approval stands "without list" (no approved_sha; audited
    // by the engine) instead of deadlocking such projects. A transient
    // failure (`error`) or a changed kind fails closed: re-pause.
    // Caveat (S4): a context gate inside an if/loop body whose earlier step
    // commits on every re-run cannot be approved headlessly — each resume
    // re-runs that step, HEAD moves, and the gate re-pauses (livelock).
    const withoutList =
      shownUnavailableKind !== null &&
      unavailableReason !== null &&
      shownUnavailableKind === unavailableKind &&
      PERMANENT_UNAVAILABLE.includes(unavailableKind);
    // An approval answering a pause whose list was built at a head that is no
    // longer HEAD halts instead of re-pausing: nothing in the run commits
    // while it waits, so something outside it moved the branch, and a person
    // must look (ADR-391-amendment-3 §4, ADR-422; supersedes amendment-2 §7
    // for gates answered after their pause). A rejection is still honoured.
    // HEAD unknown (git could not answer) is transient: fall through and
    // re-pause, fail-closed, as before.
    const headNow = shownManifest !== null ? currentHeadSha(context.projectRoot) : null;
    if (
      "context" in config &&
      boundVerdictInput !== null &&
      headNow !== null &&
      headNow !== shownManifest.head_sha &&
      !isRejection(choice)
    ) {
      context.inputs[boundVerdictInput] = "";
      return new StepResult({
        status: StepStatus.FAILED,
        output,
        error: `Gate step ${rid(config)}: head moved since the gate paused (shown ${shortSha(shownManifest.head_sha)}, now ${shortSha(headNow)}); verdict not applied.`,
      });
    }
    if (
      "context" in config &&
      boundVerdictInput !== null &&
      manifest !== shownManifest &&
      !withoutList &&
      !isRejection(choice)
    ) {
      context.inputs[boundVerdictInput] = "";
      return new StepResult({ status: StepStatus.PAUSED, output });
    }

    if (choice === null || choice === undefined) {
      // Non-interactive: pause for later resume (the file is not read here).
      if (!process.stdin.isTTY) {
        return new StepResult({ status: StepStatus.PAUSED, output });
      }

      // Interactive: prompt the user; show_file contents are folded into the
      // displayed message so the operator can review before choosing.
      choice = await GateStep.prompt(
        GateStep.composePrompt(output.message, showFile),
        options,
      );
    }
    output.choice = choice;

    // Match rejection case-insensitively, agreeing with validate().
    if (isRejection(choice)) {
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

    // Approval pins the HEAD the shown manifest was built at, so the next
    // context gate in this run lists only records changed after it
    // (`since: last_approved`); the engine records it as last_approved_sha.
    if (manifest && manifest.head_sha) {
      output.approved_sha = manifest.head_sha;
    } else if (withoutList && boundVerdictInput !== null) {
      output.without_list = true;
      output.unavailable_reason = unavailableReason;
      output.unavailable_kind = unavailableKind;
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
    const lines = sanitizeLines(message);
    lines.push("");
    // combine(), not a template literal: a template literal would drop the
    // SafeString tag, and panel()'s asText() would then strip the ESC byte
    // and leave a literal "[36m" visible in the prompt.
    options.forEach((opt, i) => lines.push(combine(style(`[${i + 1}]`, ACCENT), " ", sanitize(opt))));
    out("");
    out(panel({ title: "Gate", lines }));

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
        rl.question(`  ${style("Choose", ACCENT)} ${tint(`[1-${options.length}]`, "gray")}: `, (answer) =>
          done({ interrupted: false, answer }),
        );
        // Ctrl-C / EOF during the question: default to the last option
        // (usually reject), mirroring upstream's EOFError/KeyboardInterrupt.
        rl.on("close", () => done({ interrupted: true }));
      });

    try {
      while (true) {
        const { interrupted, answer } = await askOnce();
        if (interrupted) {
          out("");
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
        out(`  ${style(sym.failure, "red")} ${tint(`Invalid choice. Enter 1-${options.length} or an option name.`, "gray")}`);
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
    errors.push(...validateGateContext(config, rid(config)));
    return errors;
  }
}

function isRejection(choice) {
  const c = String(choice).toLowerCase();
  return c === "reject" || c === "abort";
}

// The manifest a context gate paused with (its step result is still PAUSED
// and carries a non-empty head_sha), or null — a "Decision list unavailable"
// pause showed no list, so it counts as nothing shown.
function pausedManifest(previous) {
  const out = previous?.output;
  if (
    previous?.status !== StepStatus.PAUSED ||
    typeof out?.head_sha !== "string" ||
    out.head_sha === "" ||
    !Array.isArray(out.decisions)
  ) {
    return null;
  }
  return {
    message: out.message,
    decisions: out.decisions,
    since_sha: out.since_sha,
    no_changes: out.no_changes,
    truncated_count: out.truncated_count,
    head_sha: out.head_sha,
    ...(typeof out.mr_link === "string" && safeMrLink(out.mr_link) ? { mr_link: out.mr_link } : {}),
  };
}

// The unavailable_kind a context gate paused with when it showed "Decision
// list unavailable" (its paused output carries a manifest whose head_sha is
// null/empty), else null — the approver was shown that no list could be
// built, and why (S1, T2). A pause without a recorded kind counts as none.
function pausedUnavailableKind(previous) {
  const out = previous?.output;
  if (
    previous?.status !== StepStatus.PAUSED ||
    !Array.isArray(out?.decisions) ||
    !(out.head_sha === null || out.head_sha === undefined || out.head_sha === "")
  ) {
    return null;
  }
  return typeof out.unavailable_kind === "string" ? out.unavailable_kind : null;
}

// The gate's evaluated `context.link` when it is a safe http(s) URL, else
// null. Templated like `message`; never throws (S5).
function gateMrLink(ctx, context) {
  if (typeof ctx?.link !== "string") return null;
  try {
    const value = ctx.link.includes("{{") ? evaluateExpression(ctx.link, context) : ctx.link;
    return safeMrLink(value);
  } catch {
    return null;
  }
}

function shortSha(sha) {
  return typeof sha === "string" && sha !== "" ? sha.slice(0, 7) : "none";
}

function rid(config) {
  return `'${config.id ?? "?"}'`;
}
