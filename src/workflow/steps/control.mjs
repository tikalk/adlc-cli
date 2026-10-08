// Control-flow steps: if/then/else, switch, while, do-while, fan-out, fan-in, slot.
// Ported from upstream spec-kit step/*/__init__.py @ adbd62a.

import { StepBase, StepResult, StepStatus, typeName } from "../base.mjs";
import {
  evaluateCondition,
  evaluateExpression,
  conditionIsNeverEvaluated,
  conditionHasMalformedExpressionBlock,
  conditionIsInterpolatedToText,
} from "../expressions.mjs";

const rid = (config) => `'${config.id ?? "?"}'`;

// Shared condition validation (while/do-while/if share the same three faults).
function validateCondition(errors, config, stepKind) {
  const condition = config.condition;
  if (typeof condition !== "string" && typeof condition !== "boolean") {
    errors.push(
      `${stepKind} step ${rid(config)}: 'condition' must be a string or boolean, got ${typeName(condition)}.`,
    );
    return;
  }
  if (typeof condition === "string") {
    if (conditionIsNeverEvaluated(condition)) {
      errors.push(
        `${stepKind} step ${rid(config)}: 'condition' ${JSON.stringify(condition)} is not a single complete ` +
        `'{{ }}' block, so it is never evaluated as an expression and is always true. ` +
        `Wrap it as "{{ <expression> }}" (or use the literal true/false).`,
      );
    } else if (conditionHasMalformedExpressionBlock(condition)) {
      errors.push(
        `${stepKind} step ${rid(config)}: 'condition' ${JSON.stringify(condition)} opens a '{{' the ` +
        `interpolator cannot close, so it falls back to the first raw '}}' and evaluates a truncated ` +
        `expression instead of the one written. Balance the delimiters and quotes.`,
      );
    } else if (conditionIsInterpolatedToText(condition)) {
      errors.push(
        `${stepKind} step ${rid(config)}: 'condition' ${JSON.stringify(condition)} holds more than one ` +
        `'{{ }}' block, or text around one, so it is substituted into a string and coerced by bool() ` +
        `instead of being evaluated. Put the whole expression inside a single '{{ }}' block.`,
      );
    }
  }
}

// ── if ───────────────────────────────────────────────────────────────────

export class IfThenStep extends StepBase {
  static typeKey = "if";

  async execute(config, context) {
    const condition = "condition" in config ? config.condition : false;
    const result = evaluateCondition(condition, context);

    let branchName;
    let branch;
    if (result) {
      branchName = "then";
      branch = "then" in config ? config.then : [];
    } else {
      branchName = "else";
      branch = "else" in config ? config.else : [];
    }

    if (!Array.isArray(branch)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `If step ${rid(config)}: '${branchName}' must be a list of steps, got ${typeName(branch)}.`,
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { condition, branch_taken: branchName, result },
      nextSteps: branch,
    });
  }

  validate(config) {
    const errors = super.validate(config);
    if ("condition" in config) {
      validateCondition(errors, config, "If");
    }
    if (!("then" in config)) {
      errors.push(`If step ${rid(config)} is missing 'then' field.`);
    }
    const thenBranch = "then" in config ? config.then : [];
    if (!Array.isArray(thenBranch)) {
      errors.push(`If step ${rid(config)}: 'then' must be a list of steps.`);
    }
    const elseBranch = config.else;
    if (elseBranch !== null && elseBranch !== undefined && !Array.isArray(elseBranch)) {
      errors.push(`If step ${rid(config)}: 'else' must be a list of steps.`);
    }
    return errors;
  }
}

// ── switch ───────────────────────────────────────────────────────────────

export class SwitchStep extends StepBase {
  static typeKey = "switch";

  async execute(config, context) {
    const expression = config.expression ?? "";
    const value = evaluateExpression(expression, context);

    // String-coerce for matching, stripping surrounding whitespace first —
    // the value a switch dispatches on is most often captured command output
    // stored verbatim ("approve\n" would otherwise match no case.
    const strValue = value !== null && value !== undefined ? String(value).trim() : "";

    const cases = "cases" in config ? config.cases : {};
    if (typeof cases !== "object" || cases === null || Array.isArray(cases)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Switch step ${rid(config)}: 'cases' must be a mapping, got ${typeName(cases)}.`,
        output: { matched_case: null, expression_value: value },
      });
    }
    for (const [caseKey, caseSteps] of Object.entries(cases)) {
      if (String(caseKey) === strValue) {
        if (!Array.isArray(caseSteps)) {
          return SwitchStep.nonListBranchFailure(config, `case ${JSON.stringify(String(caseKey))}`, caseSteps, value);
        }
        return new StepResult({
          status: StepStatus.COMPLETED,
          output: { matched_case: String(caseKey), expression_value: value },
          nextSteps: caseSteps,
        });
      }
    }

    const defaultSteps = "default" in config ? config.default : [];
    if (defaultSteps !== null && defaultSteps !== undefined && !Array.isArray(defaultSteps)) {
      return SwitchStep.nonListBranchFailure(config, "'default'", defaultSteps, value);
    }
    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { matched_case: "__default__", expression_value: value },
      nextSteps: Array.isArray(defaultSteps) ? defaultSteps : [],
    });
  }

  static nonListBranchFailure(config, branchLabel, branch, value) {
    return new StepResult({
      status: StepStatus.FAILED,
      output: { matched_case: null, expression_value: value },
      error: `Switch step ${rid(config)}: ${branchLabel} must be a list of steps, got ${typeName(branch)}.`,
    });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("expression" in config)) {
      errors.push(`Switch step ${rid(config)} is missing 'expression' field.`);
    }
    if (!("cases" in config)) {
      errors.push(`Switch step ${rid(config)} is missing 'cases' field.`);
    }
    const cases = "cases" in config ? config.cases : {};
    if (typeof cases !== "object" || cases === null || Array.isArray(cases)) {
      errors.push(`Switch step ${rid(config)}: 'cases' must be a mapping.`);
    } else {
      for (const [key, val] of Object.entries(cases)) {
        if (!Array.isArray(val)) {
          errors.push(`Switch step ${rid(config)}: case ${JSON.stringify(key)} must be a list of steps.`);
        }
      }
    }
    const def = config.default;
    if (def !== null && def !== undefined && !Array.isArray(def)) {
      errors.push(`Switch step ${rid(config)}: 'default' must be a list of steps.`);
    }
    return errors;
  }
}

// ── while ────────────────────────────────────────────────────────────────

export class WhileStep extends StepBase {
  static typeKey = "while";

  async execute(config, context) {
    const condition = "condition" in config ? config.condition : false;
    const maxIterations = config.max_iterations ?? 10;
    const nestedSteps = "steps" in config ? config.steps : [];

    if (!Array.isArray(nestedSteps)) {
      return new StepResult({
        status: StepStatus.FAILED,
        output: { condition, max_iterations: maxIterations, loop_type: "while" },
        error: `While step ${rid(config)}: 'steps' must be a list of steps, got ${typeName(nestedSteps)}.`,
      });
    }

    const result = evaluateCondition(condition, context);
    if (!result) {
      return new StepResult({
        status: StepStatus.COMPLETED,
        output: { condition, max_iterations: maxIterations, loop_type: "while", iterations: 0 },
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { condition, max_iterations: maxIterations, loop_type: "while" },
      nextSteps: nestedSteps,
    });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("condition" in config)) {
      errors.push(`While step ${rid(config)} is missing 'condition' field.`);
    } else {
      validateCondition(errors, config, "While");
    }
    const maxIter = config.max_iterations;
    if (maxIter !== null && maxIter !== undefined) {
      if (typeof maxIter === "boolean" || !Number.isInteger(maxIter) || maxIter < 1) {
        errors.push(`While step ${rid(config)}: 'max_iterations' must be an integer >= 1.`);
      }
    }
    if (!("steps" in config)) {
      errors.push(`While step ${rid(config)} is missing 'steps' field.`);
    }
    const nested = "steps" in config ? config.steps : [];
    if (!Array.isArray(nested)) {
      errors.push(`While step ${rid(config)}: 'steps' must be a list.`);
    }
    return errors;
  }
}

// ── do-while ─────────────────────────────────────────────────────────────

export class DoWhileStep extends StepBase {
  static typeKey = "do-while";

  async execute(config, context) {
    const maxIterations = config.max_iterations ?? 10;
    const nestedSteps = "steps" in config ? config.steps : [];
    const condition = "condition" in config ? config.condition : "false";

    if (!Array.isArray(nestedSteps)) {
      return new StepResult({
        status: StepStatus.FAILED,
        output: { condition, max_iterations: maxIterations, loop_type: "do-while" },
        error: `Do-while step ${rid(config)}: 'steps' must be a list of steps, got ${typeName(nestedSteps)}.`,
      });
    }

    // Always execute body at least once; the engine layer evaluates
    // condition after each iteration to decide whether to loop.
    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { condition, max_iterations: maxIterations, loop_type: "do-while" },
      nextSteps: nestedSteps,
    });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("condition" in config)) {
      errors.push(`Do-while step ${rid(config)} is missing 'condition' field.`);
    } else {
      validateCondition(errors, config, "Do-while");
    }
    const maxIter = config.max_iterations;
    if (maxIter !== null && maxIter !== undefined) {
      if (typeof maxIter === "boolean" || !Number.isInteger(maxIter) || maxIter < 1) {
        errors.push(`Do-while step ${rid(config)}: 'max_iterations' must be an integer >= 1.`);
      }
    }
    if (!("steps" in config)) {
      errors.push(`Do-while step ${rid(config)} is missing 'steps' field.`);
    }
    const nested = "steps" in config ? config.steps : [];
    if (!Array.isArray(nested)) {
      errors.push(`Do-while step ${rid(config)}: 'steps' must be a list.`);
    }
    return errors;
  }
}

// ── fan-out ──────────────────────────────────────────────────────────────

export class FanOutStep extends StepBase {
  static typeKey = "fan-out";

  async execute(config, context) {
    const itemsExpr = "items" in config ? config.items : "[]";
    const items = evaluateExpression(itemsExpr, context);
    const maxConcurrency = "max_concurrency" in config ? config.max_concurrency : 1;
    const stepTemplate = "step" in config ? config.step : {};

    if (typeof stepTemplate !== "object" || stepTemplate === null || Array.isArray(stepTemplate)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Fan-out step ${rid(config)}: 'step' must be a mapping (nested step template), got ${typeName(stepTemplate)}.`,
        output: { items: [], max_concurrency: maxConcurrency, step_template: {}, item_count: 0 },
      });
    }

    if (!Array.isArray(items)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Fan-out step ${rid(config)}: 'items' must resolve to a list, got ${typeName(items)} from ${JSON.stringify(itemsExpr)}.`,
        output: { items: [], max_concurrency: maxConcurrency, step_template: stepTemplate, item_count: 0 },
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: {
        items,
        max_concurrency: maxConcurrency,
        step_template: stepTemplate,
        item_count: items.length,
      },
    });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("items" in config)) {
      errors.push(`Fan-out step ${rid(config)} is missing 'items' field.`);
    }
    if (!("step" in config)) {
      errors.push(`Fan-out step ${rid(config)} is missing 'step' field (nested step template).`);
    } else if (typeof config.step !== "object" || config.step === null || Array.isArray(config.step)) {
      errors.push(`Fan-out step ${rid(config)}: 'step' must be a mapping.`);
    }
    return errors;
  }
}

// ── fan-in ───────────────────────────────────────────────────────────────

export class FanInStep extends StepBase {
  static typeKey = "fan-in";

  async execute(config, context) {
    const waitFor = "wait_for" in config ? config.wait_for : [];
    let outputConfig = config.output;
    if (outputConfig === null || outputConfig === undefined) {
      outputConfig = {};
    } else if (typeof outputConfig !== "object" || Array.isArray(outputConfig)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Fan-in step ${rid(config)}: 'output' must be a mapping of key -> expression, got ${typeName(outputConfig)}.`,
        output: { results: [] },
      });
    }

    if (!Array.isArray(waitFor)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Fan-in step ${rid(config)}: 'wait_for' must be a list of step IDs, got ${typeName(waitFor)}.`,
        output: { results: [] },
      });
    }

    const badEntries = waitFor.filter((w) => typeof w !== "string");
    if (badEntries.length > 0) {
      const first = badEntries[0];
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Fan-in step ${rid(config)}: 'wait_for' entries must be step-id strings, got ${typeName(first)} (${JSON.stringify(first)}).`,
        output: { results: [] },
      });
    }

    const results = [];
    for (const stepId of waitFor) {
      const stepData = context.steps[stepId] ?? {};
      results.push(stepData.output ?? {});
    }

    // Resolve output expressions with fan_in in context.
    const prevFanIn = context.fanIn;
    context.fanIn = { results };
    const resolvedOutput = { results };

    try {
      for (const [key, expr] of Object.entries(outputConfig)) {
        if (typeof expr === "string" && expr.includes("{{")) {
          resolvedOutput[key] = evaluateExpression(expr, context);
        } else {
          resolvedOutput[key] = expr;
        }
      }
    } finally {
      context.fanIn = prevFanIn;
    }

    return new StepResult({ status: StepStatus.COMPLETED, output: resolvedOutput });
  }

  validate(config) {
    const errors = super.validate(config);
    const waitFor = "wait_for" in config ? config.wait_for : [];
    if (!Array.isArray(waitFor) || waitFor.length === 0) {
      errors.push(`Fan-in step ${rid(config)}: 'wait_for' must be a non-empty list of step IDs.`);
    }
    const output = config.output;
    if (output !== null && output !== undefined &&
        (typeof output !== "object" || Array.isArray(output))) {
      errors.push(`Fan-in step ${rid(config)}: 'output' must be a mapping of key -> expression, got ${typeName(output)}.`);
    }
    return errors;
  }
}

// ── slot ─────────────────────────────────────────────────────────────────

export class SlotStep extends StepBase {
  static typeKey = "slot";

  async execute(config, context) {
    if (context.insideFanOut) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Slot step ${rid(config)} is not supported inside fan-out templates because overlays cannot address runtime-multiplied templates.`,
      });
    }
    return new StepResult({
      status: StepStatus.SKIPPED,
      output: { slot: config.name },
    });
  }

  validate(config) {
    const errors = super.validate(config);
    const name = config.name;
    if (name === null || name === undefined) {
      errors.push(`Slot step ${rid(config)} requires a 'name' field (the slot label).`);
    } else if (typeof name !== "string" || name.trim() === "") {
      errors.push(`Slot step ${rid(config)}: 'name' must be a non-blank string.`);
    }
    return errors;
  }
}
