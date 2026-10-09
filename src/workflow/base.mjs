// Base classes for factory workflow step types.
// Ported from upstream spec-kit src/specify_cli/workflows/base.py @ adbd62a.

export const StepStatus = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
  PAUSED: "paused",
});

export const RunStatus = Object.freeze({
  CREATED: "created",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  ABORTED: "aborted",
});

export class StepContext {
  constructor(fields = {}) {
    // Resolved workflow inputs (from user prompts / defaults).
    this.inputs = fields.inputs ?? {};
    // Accumulated step results keyed by step ID. Each entry is the dict the
    // engine persists per step (type/integration/model/options/input/output/status).
    this.steps = fields.steps ?? {};
    // Current fan-out item (set only inside fan-out iterations).
    this.item = fields.item ?? null;
    // Whether the current step is executing inside a fan-out template.
    this.insideFanOut = fields.insideFanOut ?? false;
    // Fan-in aggregated results (set only for fan-in steps).
    this.fanIn = fields.fanIn ?? {};
    // Workflow-level default integration (agent) key.
    this.defaultIntegration = fields.defaultIntegration ?? null;
    // Workflow-level default model.
    this.defaultModel = fields.defaultModel ?? null;
    // Workflow-level default options.
    this.defaultOptions = fields.defaultOptions ?? {};
    // Project root path.
    this.projectRoot = fields.projectRoot ?? null;
    // Current run ID.
    this.runId = fields.runId ?? null;
    // Source directory of the workflow definition file.
    this.workflowDir = fields.workflowDir ?? null;
    // Whether the engine is re-executing the current step during resume.
    this.isResume = fields.isResume ?? false;
  }

  // Returns a shallow copy with per-fan-out-item overrides. The shared
  // `steps` dict is deliberately copied by reference so per-item writes on
  // disjoint parentId:templateId:index keys land in the run's record.
  withOverrides(overrides) {
    return new StepContext({ ...this, ...overrides });
  }
}

export class StepResult {
  constructor({ status = StepStatus.COMPLETED, output = {}, nextSteps = [], error = null } = {}) {
    this.status = status;
    this.output = output;
    this.nextSteps = nextSteps;
    this.error = error;
  }
}

export class StepBase {
  // Matches the `type:` value in workflow YAML.
  static typeKey = "";

  get typeKey() {
    return this.constructor.typeKey;
  }

  // Execute the step with the given config and context. Returns a StepResult.
  // Implementations must be stateless / side-effect-free on `this` — the
  // registry holds a single shared instance and concurrent fan-out items
  // execute() on it interleaved.
  async execute(_config, _context) {
    throw new Error("StepBase.execute() must be implemented");
  }

  // Validate step configuration and return a list of error messages.
  // An empty list means the configuration is valid. Must never throw.
  validate(config) {
    const errors = [];
    if (!("id" in config)) errors.push("Step is missing required 'id' field.");
    return errors;
  }

  // Return whether this step can be resumed from the given state.
  canResume(_state) {
    return true;
  }
}

// Python-compatible type-name helper used by ported validation messages.
export function typeName(value) {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (value instanceof Map) return "dict";
  const t = typeof value;
  if (t === "object") return "dict";
  if (t === "boolean") return "bool";
  if (t === "number") return Number.isInteger(value) ? "int" : "float";
  return t; // "string" | "undefined"
}

// Python repr()-like rendering for error messages.
export function repr(value) {
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "None";
  if (value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([k, v]) => `'${k}': ${repr(v)}`);
    return `{${entries.join(", ")}}`;
  }
  return String(value);
}
