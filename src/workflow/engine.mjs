// Factory workflow engine — loads, validates, and executes workflow YAML.
// Full port of upstream spec-kit src/specify_cli/workflows/engine.py @ adbd62a.
// Adaptations for adlc-cli (ADR-390 + amendments): run state lives at
// .adlc/workflows/runs/<run_id>/ (namespace v3, ADR-391-amendment),
// the workflow copy is verbatim bytes, execution is async, fan-out concurrency is
// a JS sliding-window semaphore, KeyboardInterrupt → SIGINT maps to PAUSED,
// and the `integration: auto` sentinel resolves from .adlc/init-options.json.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { parseYaml } from "./yaml.mjs";
import { RunStatus, StepStatus, StepContext, typeName, repr } from "./base.mjs";
import { evaluateCondition } from "./expressions.mjs";
import { readAgent } from "../utils/init-options.mjs";
import { Lease } from "./lease.mjs";
import { pushRunRef } from "./refs.mjs";
import { getBuiltinWorkflow } from "./builtins.mjs";

export { RunStatus, StepStatus };
export { Lease, LeaseHeldError } from "./lease.mjs";

// ID format: lowercase alphanumeric with hyphens.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
// run_id charset: cannot contain path separators, "..", or NULs; first char
// must be alphanumeric so it can never read as a CLI flag.
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const RECOGNIZED_REQUIRES_KEYS = ["speckit_version", "integrations"];

// -- Workflow Definition --------------------------------------------------

export class WorkflowDefinition {
  constructor(data, sourcePath = null, sourceYaml = null) {
    this.data = data;
    this.sourcePath = sourcePath;
    // Verbatim YAML for built-in definitions (no source file on disk) —
    // the frozen run copy writes these bytes.
    this.sourceYaml = sourceYaml;

    const workflow = data.workflow && typeof data.workflow === "object" ? data.workflow : {};
    this.id = workflow.id ?? "";
    this.name = workflow.name ?? "";
    this.version = workflow.version ?? "0.0.0";
    this.author = workflow.author ?? "";
    this.description = workflow.description ?? "";
    this.schemaVersion = String(data.schema_version ?? "1.0");

    // Defaults (keep malformed values intact until validateWorkflow reports them).
    this.defaultIntegration = "integration" in workflow ? workflow.integration : undefined;
    this.defaultModel = "model" in workflow ? workflow.model : undefined;
    const rawDefaultOptions = "options" in workflow ? workflow.options : undefined;
    this.defaultOptions = rawDefaultOptions === null || rawDefaultOptions === undefined ? {} : rawDefaultOptions;

    // Advisory pre-conditions. NOT enforced at run time — no security boundary.
    this.requires = data.requires ?? {};

    this.inputs = data.inputs ?? {};
    this.steps = data.steps ?? [];
  }

  static fromYamlFile(path) {
    let data;
    try {
      data = parseYaml(readFileSync(path, "utf-8"));
    } catch (exc) {
      throw new Error(`Invalid YAML in ${path}: ${exc.message}`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Workflow YAML must be a mapping, got ${Array.isArray(data) ? "list" : typeof data}.`);
    }
    return new WorkflowDefinition(data, path);
  }

  static fromString(content) {
    const data = parseYaml(content);
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Workflow YAML must be a mapping, got ${Array.isArray(data) ? "list" : typeof data}.`);
    }
    return new WorkflowDefinition(data);
  }

  // Built-in (bundled) definition: parsed from the curated YAML string; the
  // string is retained so run copies stay verbatim.
  static fromBuiltin(id, yamlString) {
    const def = WorkflowDefinition.fromString(yamlString);
    if (def.id !== id) {
      throw new Error(`Built-in workflow id mismatch: expected '${id}', definition declares '${def.id}'.`);
    }
    return new WorkflowDefinition(def.data, null, yamlString);
  }
}

// -- Workflow Validation ---------------------------------------------------

function getValidStepTypes(registry) {
  if (registry && Object.keys(registry).length > 0) return new Set(Object.keys(registry));
  return new Set([
    "command", "shell", "prompt", "gate", "if", "slot",
    "switch", "while", "do-while", "fan-out", "fan-in",
  ]);
}

function dispatchDefaultErrors(definition) {
  const errors = [];
  if (definition.defaultIntegration !== undefined && definition.defaultIntegration !== null &&
      typeof definition.defaultIntegration !== "string") {
    errors.push(
      `'workflow.integration' must be a string or null, got ${typeName(definition.defaultIntegration)} ` +
      `(${repr(definition.defaultIntegration)}).`,
    );
  }
  if (definition.defaultModel !== undefined && definition.defaultModel !== null &&
      typeof definition.defaultModel !== "string") {
    errors.push(
      `'workflow.model' must be a string or null, got ${typeName(definition.defaultModel)} ` +
      `(${repr(definition.defaultModel)}).`,
    );
  }
  if (typeof definition.defaultOptions !== "object" || definition.defaultOptions === null ||
      Array.isArray(definition.defaultOptions)) {
    errors.push(
      `'workflow.options' must be a mapping or null, got ${typeName(definition.defaultOptions)} ` +
      `(${repr(definition.defaultOptions)}).`,
    );
  }
  return errors;
}

export function validateWorkflow(definition, registry) {
  const errors = [];

  if (definition.schemaVersion !== "1.0") {
    errors.push(`Unsupported schema_version ${repr(definition.schemaVersion)}. Expected '1.0'.`);
  }

  // Top-level fields
  if (definition.id === null || definition.id === "") {
    errors.push("Workflow is missing 'workflow.id'.");
  } else if (typeof definition.id !== "string") {
    errors.push(`'workflow.id' must be a string, got ${typeName(definition.id)} (${repr(definition.id)}).`);
  } else if (!ID_PATTERN.test(definition.id)) {
    errors.push(`Workflow ID ${repr(definition.id)} must be lowercase alphanumeric with hyphens.`);
  }

  if (definition.name === null || definition.name === "") {
    errors.push("Workflow is missing 'workflow.name'.");
  } else if (typeof definition.name !== "string") {
    errors.push(`'workflow.name' must be a string, got ${typeName(definition.name)} (${repr(definition.name)}).`);
  }

  if (definition.version === null || definition.version === "") {
    errors.push("Workflow is missing 'workflow.version'.");
  } else if (typeof definition.version !== "string") {
    errors.push(
      `'workflow.version' must be a string, got ${typeName(definition.version)} (${repr(definition.version)}) — ` +
      `quote it in YAML (version: "1.0.0").`,
    );
  } else if (!/^\d+\.\d+\.\d+$/.test(definition.version)) {
    errors.push(`Workflow version ${repr(definition.version)} is not valid semantic versioning (expected X.Y.Z).`);
  }

  errors.push(...dispatchDefaultErrors(definition));

  // Inputs
  if (typeof definition.inputs !== "object" || definition.inputs === null || Array.isArray(definition.inputs)) {
    errors.push("'inputs' must be a mapping (or omitted).");
  } else {
    for (const [inputName, inputDef] of Object.entries(definition.inputs)) {
      if (typeof inputDef !== "object" || inputDef === null || Array.isArray(inputDef)) {
        errors.push(`Input ${repr(inputName)} must be a mapping.`);
        continue;
      }
      const inputType = inputDef.type;
      if (inputType && !["string", "number", "boolean"].includes(inputType)) {
        errors.push(`Input ${repr(inputName)} has invalid type ${repr(inputType)}. Must be 'string', 'number', or 'boolean'.`);
      }

      const enumValues = "enum" in inputDef ? inputDef.enum : null;
      if (enumValues !== null && enumValues !== undefined && !Array.isArray(enumValues)) {
        errors.push(`Input ${repr(inputName)} has invalid 'enum': must be a list, got ${typeName(enumValues)}.`);
      }

      const enumIsValid = enumValues === null || enumValues === undefined || Array.isArray(enumValues);
      if ("default" in inputDef) {
        const defaultValue = inputDef.default;
        const isAutoIntegration = inputName === "integration" && defaultValue === "auto";
        let validationInputDef = inputDef;
        if ((isAutoIntegration || !enumIsValid) && "enum" in inputDef) {
          validationInputDef = Object.fromEntries(
            Object.entries(inputDef).filter(([k]) => k !== "enum"),
          );
        }
        try {
          WorkflowEngine.coerceInput(inputName, defaultValue, validationInputDef);
        } catch (exc) {
          errors.push(`Input ${repr(inputName)} has invalid default: ${exc.message}`);
        }
      }
    }
  }

  // Requires
  if (typeof definition.requires !== "object" || definition.requires === null || Array.isArray(definition.requires)) {
    errors.push("'requires' must be a mapping (or omitted).");
  } else {
    for (const key of Object.keys(definition.requires)) {
      if (key === "permissions") {
        errors.push(
          "'requires.permissions' is not a recognized or enforced capability gate — shell steps always run " +
          "with the user's privileges. Remove it and gate sensitive steps with a 'gate' step instead.",
        );
      } else if (!RECOGNIZED_REQUIRES_KEYS.includes(key)) {
        errors.push(
          `Unknown 'requires' key ${repr(key)}. Recognized keys: ${[...RECOGNIZED_REQUIRES_KEYS].sort().join(", ")}.`,
        );
      }
    }
  }

  // Steps
  if (!Array.isArray(definition.steps)) {
    errors.push("'steps' must be a list.");
    return errors;
  }
  if (definition.steps.length === 0) {
    errors.push("Workflow has no steps defined.");
  }

  const seenIds = new Set();
  const inputDefs =
    typeof definition.inputs === "object" && definition.inputs !== null && !Array.isArray(definition.inputs)
      ? { ...definition.inputs }
      : null;
  validateSteps(definition.steps, seenIds, errors, inputDefs, false, registry);

  return errors;
}

function validateSteps(steps, seenIds, errors, inputDefs, insideFanOut, registry) {
  for (const stepConfig of steps) {
    if (typeof stepConfig !== "object" || stepConfig === null || Array.isArray(stepConfig)) {
      errors.push(`Step must be a mapping, got ${typeName(stepConfig)}.`);
      continue;
    }

    const stepId = stepConfig.id;
    if (stepId === null || stepId === undefined || stepId === "") {
      errors.push("Step is missing 'id' field.");
      continue;
    }
    if (typeof stepId !== "string") {
      errors.push(`Step ID must be a string, got ${typeName(stepId)} (${repr(stepId)}).`);
      continue;
    }

    if (stepId.includes(":")) {
      errors.push(`Step ID ${repr(stepId)} contains ':' which is reserved for engine-generated nested IDs (parentId:childId).`);
    }

    if (seenIds.has(stepId)) {
      errors.push(`Duplicate step ID ${repr(stepId)}.`);
    }
    seenIds.add(stepId);

    const stepType = stepConfig.type ?? "command";
    if (typeof stepType !== "string") {
      errors.push(`Step ${repr(stepId)}: 'type' must be a string, got ${typeName(stepType)} (${repr(stepType)}).`);
      continue;
    }
    const validTypes = getValidStepTypes(registry);
    if (!validTypes.has(stepType)) {
      errors.push(`Step ${repr(stepId)} has invalid type ${repr(stepType)}.`);
      continue;
    }

    // Delegate to step-specific validation
    const stepImpl = registry?.[stepType];
    if (stepImpl) {
      errors.push(...stepImpl.validate(stepConfig));
    }

    if (stepType === "slot" && insideFanOut) {
      errors.push(`Slot step ${repr(stepId)} is not supported inside fan-out templates because overlays cannot address runtime-multiplied templates.`);
    }

    if ("continue_on_error" in stepConfig) {
      const coe = stepConfig.continue_on_error;
      if (typeof coe !== "boolean") {
        errors.push(`Step ${repr(stepId)}: 'continue_on_error' must be a boolean, got ${typeName(coe)}.`);
      }
    }

    if (stepType === "fan-in") {
      const waitFor = stepConfig.wait_for;
      if (Array.isArray(waitFor)) {
        for (const wid of waitFor) {
          if (typeof wid !== "string") {
            errors.push(`Fan-in step ${repr(stepId)}: 'wait_for' entries must be step-id strings, got ${typeName(wid)} (${repr(wid)}).`);
          } else if (wid === stepId) {
            errors.push(`Fan-in step ${repr(stepId)}: 'wait_for' references itself; a fan-in cannot wait for its own results.`);
          } else if (!seenIds.has(wid)) {
            errors.push(`Fan-in step ${repr(stepId)}: 'wait_for' references unknown or not-yet-declared step id ${repr(wid)}.`);
          }
        }
      }
    }

    if (stepType === "gate") {
      const verdictInput = stepConfig.verdict_input;
      if (typeof verdictInput === "string" && verdictInput) {
        if (insideFanOut) {
          errors.push(`Gate step ${repr(stepId)}: 'verdict_input' is not supported inside fan-out templates.`);
        } else if (inputDefs !== null && !(verdictInput in inputDefs)) {
          errors.push(`Gate step ${repr(stepId)}: 'verdict_input' references undeclared input ${repr(verdictInput)}.`);
        } else if (inputDefs !== null) {
          const verdictDef = inputDefs[verdictInput];
          const enumValues =
            typeof verdictDef === "object" && verdictDef !== null && !Array.isArray(verdictDef)
              ? verdictDef.enum
              : null;
          if (stepConfig.on_reject === "retry" && Array.isArray(enumValues) && !enumValues.includes("")) {
            errors.push(
              `Gate step ${repr(stepId)}: on_reject='retry' resets verdict input ${repr(verdictInput)} to '' when the ` +
              `gate is rejected, but that input's 'enum' does not allow ''. Add '' to the enum or use on_reject='abort'/'skip'.`,
            );
          }
        }
      }
    }

    // Recursively validate nested steps
    for (const nestedKey of ["then", "else", "steps"]) {
      const nested = stepConfig[nestedKey];
      if (Array.isArray(nested)) {
        validateSteps(nested, seenIds, errors, inputDefs, insideFanOut, registry);
      }
    }

    const cases = stepConfig.cases;
    if (cases && typeof cases === "object" && !Array.isArray(cases)) {
      for (const caseSteps of Object.values(cases)) {
        if (Array.isArray(caseSteps)) {
          validateSteps(caseSteps, seenIds, errors, inputDefs, insideFanOut, registry);
        }
      }
    }

    const defaultBranch = stepConfig.default;
    if (Array.isArray(defaultBranch)) {
      validateSteps(defaultBranch, seenIds, errors, inputDefs, insideFanOut, registry);
    }

    // Fan-out nested step (template — not added to seen_ids; engine generates
    // parentId:templateId:index at runtime).
    const fanStep = stepConfig.step;
    if (fanStep && typeof fanStep === "object" && !Array.isArray(fanStep)) {
      const fanErrors = [];
      validateSteps([fanStep], new Set(), fanErrors, inputDefs, true, registry);
      errors.push(...fanErrors);
    }
  }
}

// -- Headless validation (ADR-391-amendment) -------------------------------
// CI-executed workflows must declare verdict_input on every gate — a gate
// without it cannot be resumed headless. Walks all nested step containers.

export function headlessGateErrors(definition) {
  const errors = [];
  const visit = (steps, where) => {
    for (const stepConfig of steps ?? []) {
      if (typeof stepConfig !== "object" || stepConfig === null || Array.isArray(stepConfig)) continue;
      const stepId = stepConfig.id ?? "?";
      const stepType = stepConfig.type ?? "command";
      if (stepType === "gate") {
        const verdict = stepConfig.verdict_input;
        if (typeof verdict !== "string" || verdict === "") {
          errors.push(
            `Gate step '${stepId}'${where ? ` (${where})` : ""} has no 'verdict_input' — it cannot be ` +
            `resumed headless. Declare verdict_input (bound to an input whose enum admits the reject choice).`,
          );
        }
      }
      for (const key of ["then", "else", "steps", "default"]) {
        if (Array.isArray(stepConfig[key])) visit(stepConfig[key], `${where ? where + " → " : ""}${stepId}:${key}`);
      }
      if (stepConfig.cases && typeof stepConfig.cases === "object" && !Array.isArray(stepConfig.cases)) {
        for (const [caseKey, caseSteps] of Object.entries(stepConfig.cases)) {
          if (Array.isArray(caseSteps)) visit(caseSteps, `${where ? where + " → " : ""}${stepId}:case '${caseKey}'`);
        }
      }
      if (stepConfig.step && typeof stepConfig.step === "object" && !Array.isArray(stepConfig.step)) {
        visit([stepConfig.step], `${where ? where + " → " : ""}${stepId}:fan-out template`);
      }
    }
  };
  if (Array.isArray(definition.steps)) visit(definition.steps, "");
  return errors;
}

// -- Run State Persistence -------------------------------------------------

export class RunState {
  constructor({
    runId = null,
    workflowId = "",
    projectRoot = null,
    installedWorkflowId = null,
    installedRegistryRoot = null,
    installedOriginTracked = true,
  } = {}) {
    this.runId = runId === null ? randomUUID().slice(0, 8) : runId;
    RunState.validateRunId(this.runId);
    this.workflowId = workflowId;
    this.projectRoot = projectRoot ?? ".";
    this.installedWorkflowId = installedWorkflowId ?? null;
    this.installedRegistryRoot = installedRegistryRoot ?? null;
    this.installedOriginTracked = installedOriginTracked;
    this.status = RunStatus.CREATED;
    this.currentStepIndex = 0;
    this.currentStepId = null;
    this.stepResults = {};
    this.inputs = {};
    this.workflowDir = null;
    const now = new Date().toISOString();
    this.createdAt = now;
    this.updatedAt = now;
    this.logEntries = [];
    this.error = null;
    // Async mutex serializing save()/appendLog file writes — the JS analogue
    // of upstream's _lock/_log_lock pair (single-threaded JS needs it only
    // across await points during concurrent fan-out).
    this._writeQueue = Promise.resolve();
  }

  get runsDir() {
    return join(this.projectRoot, ".adlc", "workflows", "runs", this.runId);
  }

  static validateRunId(runId) {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      throw new Error(
        `Invalid run_id ${repr(runId)}: must be alphanumeric with hyphens/underscores only ` +
        `(and must start with an alphanumeric character).`,
      );
    }
  }

  recordStepResult(stepId, data) {
    this.stepResults[stepId] = data;
  }

  setStepOutput(stepId, output) {
    if (stepId in this.stepResults) {
      this.stepResults[stepId].output = output;
    }
  }

  save() {
    return this._enqueueWrite(async () => {
      mkdirSync(this.runsDir, { recursive: true });
      this.updatedAt = new Date().toISOString();
      const stateData = {
        run_id: this.runId,
        workflow_id: this.workflowId,
        installed_workflow_id: this.installedWorkflowId,
        installed_registry_root: this.installedRegistryRoot,
        status: this.status,
        current_step_index: this.currentStepIndex,
        current_step_id: this.currentStepId,
        step_results: this.stepResults,
        workflow_dir: this.workflowDir,
        created_at: this.createdAt,
        updated_at: this.updatedAt,
        error: this.error,
      };
      atomicWriteJson(join(this.runsDir, "state.json"), stateData);
      atomicWriteJson(join(this.runsDir, "inputs.json"), { inputs: this.inputs });
    });
  }

  appendLog(entry) {
    return this._enqueueWrite(async () => {
      entry.timestamp = new Date().toISOString();
      mkdirSync(this.runsDir, { recursive: true });
      this.logEntries.push(entry);
      const fd = openSync(join(this.runsDir, "log.jsonl"), "a");
      try {
        writeFileSync(fd, JSON.stringify(entry) + "\n");
      } finally {
        closeSync(fd);
      }
    });
  }

  _enqueueWrite(fn) {
    const next = this._writeQueue.then(fn, fn);
    // Keep the queue from swallowing rejections: surface to caller, reset chain.
    this._writeQueue = next.then(() => {}, () => {});
    return next;
  }

  static load(runId, projectRoot) {
    RunState.validateRunId(runId);
    const runsDir = join(projectRoot, ".adlc", "workflows", "runs", runId);
    const statePath = join(runsDir, "state.json");

    if (!existsSync(statePath)) {
      throw new Error(`Run state not found: ${statePath}`);
    }
    let stateData;
    try {
      stateData = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch (exc) {
      throw new Error(`Invalid run state: ${exc.message}`);
    }
    if (typeof stateData !== "object" || stateData === null || Array.isArray(stateData)) {
      throw new Error("Invalid run state: expected a JSON object");
    }
    const missingFields = ["run_id", "workflow_id", "status"].filter((f) => !(f in stateData));
    if (missingFields.length > 0) {
      throw new Error(`Invalid run state: missing required field(s): ${missingFields.join(", ")}`);
    }
    if (stateData.run_id !== runId) {
      throw new Error(`Invalid run state: stored run_id ${repr(stateData.run_id)} does not match requested run_id ${repr(runId)}`);
    }

    const workflowId = stateData.workflow_id;
    if (typeof workflowId !== "string" || !ID_PATTERN.test(workflowId)) {
      throw new Error("Invalid run state: 'workflow_id' must be a lowercase alphanumeric workflow ID with hyphens");
    }

    const hasInstalledWorkflowId = "installed_workflow_id" in stateData;
    const hasInstalledRegistryRoot = "installed_registry_root" in stateData;
    if (hasInstalledWorkflowId !== hasInstalledRegistryRoot) {
      throw new Error("Invalid run state: installed workflow origin fields must either both be present or both be absent");
    }

    const stepResults = stateData.step_results ?? {};
    if (typeof stepResults !== "object" || stepResults === null || Array.isArray(stepResults)) {
      throw new Error("Invalid run state: 'step_results' must be a JSON object");
    }
    for (const result of Object.values(stepResults)) {
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("Invalid run state: step_results records must be JSON objects");
      }
    }

    const state = new RunState({
      runId: stateData.run_id,
      workflowId,
      projectRoot,
      installedWorkflowId: stateData.installed_workflow_id ?? null,
      installedRegistryRoot: stateData.installed_registry_root ?? null,
      installedOriginTracked: hasInstalledWorkflowId,
    });
    state.status = stateData.status;

    const currentStepIndex = stateData.current_step_index ?? 0;
    if (typeof currentStepIndex === "boolean" || !Number.isInteger(currentStepIndex) || currentStepIndex < 0) {
      throw new Error(`Invalid run state: 'current_step_index' must be a non-negative integer, got ${repr(currentStepIndex)}`);
    }
    state.currentStepIndex = currentStepIndex;
    state.currentStepId = stateData.current_step_id ?? null;
    state.stepResults = stepResults;
    state.workflowDir = stateData.workflow_dir ?? null;
    state.createdAt = stateData.created_at ?? "";
    state.updatedAt = stateData.updated_at ?? "";
    state.error = stateData.error ?? null;

    const inputsPath = join(runsDir, "inputs.json");
    if (existsSync(inputsPath)) {
      const inputsData = JSON.parse(readFileSync(inputsPath, "utf-8"));
      if (typeof inputsData !== "object" || inputsData === null || Array.isArray(inputsData)) {
        throw new Error("Invalid run inputs: expected a JSON object");
      }
      const inputs = inputsData.inputs ?? {};
      if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
        throw new Error("Invalid run inputs: 'inputs' must be a JSON object");
      }
      state.inputs = inputs;
    }

    return state;
  }
}

function atomicWriteJson(path, data) {
  // basename() is platform-aware — a manual split("/") leaves the full
  // Windows path (backslashes) in the name and the write fails (CI: win32).
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

// -- Workflow Engine -------------------------------------------------------

export class WorkflowEngine {
  constructor(projectRoot = null) {
    this.projectRoot = projectRoot ?? ".";
    this.onStepStart = null; // (stepId, label) => void
    // Structured event sink (stepId-agnostic lifecycle telemetry): the CLI
    // installs a JSONL emitter under --format json; library default silent.
    this.onEvent = null; // (type, payload) => void
    // Set by the CLI on SIGINT/SIGTERM: the engine pauses cleanly at the
    // next boundary (JS analogue of upstream's KeyboardInterrupt handler).
    this.interrupted = false;
  }

  // Emit a lifecycle event when a sink is installed (no-op otherwise).
  // The event object is built here — sinks receive one argument and can
  // never clobber the lifecycle `type` with a payload field.
  emit(type, payload = {}) {
    if (this.onEvent !== null) {
      try {
        this.onEvent({ type, ...payload, ts: new Date().toISOString() });
      } catch {
        // A telemetry sink must never break the run.
      }
    }
  }

  loadWorkflow(source) {
    // Load from an installed ID (`.adlc/workflows/<id>/workflow.yml`), a
    // bundled built-in (e.g. `factory`), or a local YAML path.
    const path = resolve(source);
    if (/\.(yml|yaml)$/i.test(path) && existsSync(path)) {
      return WorkflowDefinition.fromYamlFile(path);
    }
    const installedPath = join(this.projectRoot, ".adlc", "workflows", String(source), "workflow.yml");
    if (existsSync(installedPath)) {
      return WorkflowDefinition.fromYamlFile(installedPath);
    }
    const builtin = getBuiltinWorkflow(String(source));
    if (builtin !== null) {
      return WorkflowDefinition.fromBuiltin(String(source), builtin.yaml);
    }
    throw new Error(`Workflow not found: ${source}`);
  }

  validate(definition, registry) {
    return validateWorkflow(definition, registry);
  }

  async execute(definition, inputs = null, runId = null, registry) {
    let effectiveRunId = runId;
    if (effectiveRunId === null || effectiveRunId === undefined) {
      const envRunId = (process.env.ADLC_WORKFLOW_RUN_ID || "").trim();
      if (envRunId) effectiveRunId = envRunId;
    }

    const state = new RunState({
      runId: effectiveRunId,
      workflowId: definition.id,
      projectRoot: this.projectRoot,
    });
    const lease = new Lease(state.runsDir, { runId: state.runId });
    lease.acquire();

    // Persist a verbatim copy of the workflow definition so resume can
    // reload it even if the original source is no longer available.
    mkdirSync(state.runsDir, { recursive: true });
    if (definition.sourcePath && existsSync(definition.sourcePath)) {
      copyFileSync(definition.sourcePath, join(state.runsDir, "workflow.yml"));
    } else if (definition.sourceYaml) {
      writeFileSync(join(state.runsDir, "workflow.yml"), definition.sourceYaml);
    } else {
      writeFileSync(join(state.runsDir, "workflow.yml"), "# serialized from string source\n" + JSON.stringify(definition.data, null, 2));
    }

    const resolvedInputs = this.resolveInputs(definition, inputs ?? {});
    state.inputs = resolvedInputs;
    const workflowDir = definition.sourcePath ? dirname(resolve(definition.sourcePath)) : null;
    state.workflowDir = workflowDir;
    state.status = RunStatus.RUNNING;
    await state.save();
    this.emit("run_started", { run_id: state.runId, workflow_id: definition.id });

    const context = new StepContext({
      inputs: resolvedInputs,
      defaultIntegration: definition.defaultIntegration ?? null,
      defaultModel: definition.defaultModel ?? null,
      defaultOptions: definition.defaultOptions,
      projectRoot: String(this.projectRoot),
      runId: state.runId,
      workflowDir,
    });

    try {
      await this.executeSteps(definition.steps, context, state, registry, 0, lease);
    } catch (exc) {
      if (this.interrupted) {
        state.status = RunStatus.PAUSED;
        await state.appendLog({ event: "workflow_interrupted" });
        await state.save();
        this.finishSession(state, lease);
        return state;
      }
      state.status = RunStatus.FAILED;
      state.error = String(exc?.message ?? exc);
      await state.appendLog({ event: "workflow_failed", error: state.error });
      await state.save();
      this.finishSession(state, lease);
      throw exc;
    }

    if (state.status === RunStatus.RUNNING) {
      state.status = RunStatus.COMPLETED;
    }
    await state.appendLog({ event: "workflow_finished", status: state.status });
    await state.save();
    this.finishSession(state, lease);
    return state;
  }

  // Session-end bookkeeping shared by every exit path: run-level event,
  // git-refs Tier-3 push (pause and terminal states), lease release —
  // exit-and-resume semantics make the run claimable by any executor.
  finishSession(state, lease) {
    if (state.status === RunStatus.PAUSED) {
      this.emit("run_paused", { run_id: state.runId, current_step_id: state.currentStepId });
    } else if (state.status === RunStatus.COMPLETED) {
      this.emit("run_completed", { run_id: state.runId });
    } else if (state.status === RunStatus.FAILED || state.status === RunStatus.ABORTED) {
      this.emit("run_failed", { run_id: state.runId, error: state.error, status: state.status });
    }
    try {
      pushRunRef(this.projectRoot, state.runId, state.runsDir);
    } catch {}
    if (lease) lease.release();
  }

  async resume(runId, inputs = null, registry) {
    const state = RunState.load(runId, this.projectRoot);
    // A `running` run is resumable when its lease is free: the previous
    // session ended at a step boundary (helper advance/pause, or a crash) —
    // the strict lease below is the guard, not the status field (ADR-395).
    if (state.status !== RunStatus.PAUSED && state.status !== RunStatus.FAILED && state.status !== RunStatus.RUNNING) {
      throw new Error(`Cannot resume run ${repr(runId)} with status ${repr(state.status)}.`);
    }

    // Strict lease: refuse when another live session holds this run.
    const lease = new Lease(state.runsDir, { runId: state.runId });
    lease.acquire();

    // Load the workflow definition — the persisted copy in the run directory
    // first so resume works even if the original source is gone.
    const runCopy = join(state.runsDir, "workflow.yml");
    let definition;
    if (existsSync(runCopy)) {
      try {
        definition = WorkflowDefinition.fromYamlFile(runCopy);
      } catch {
        // Serialized-from-string copies fall back to JSON reconstruction.
        const raw = JSON.parse(readFileSync(runCopy, "utf-8").replace(/^# serialized from string source\n/, ""));
        definition = new WorkflowDefinition(raw);
      }
    } else {
      definition = this.loadWorkflow(state.workflowId);
    }

    const dispatchErrors = dispatchDefaultErrors(definition);
    if (dispatchErrors.length > 0) {
      throw new Error(dispatchErrors.join(" "));
    }

    if (inputs) {
      const merged = { ...state.inputs, ...inputs };
      state.inputs = this.resolveInputs(definition, merged);
    }

    const context = new StepContext({
      inputs: state.inputs,
      steps: state.stepResults,
      defaultIntegration: definition.defaultIntegration ?? null,
      defaultModel: definition.defaultModel ?? null,
      defaultOptions: definition.defaultOptions,
      projectRoot: String(this.projectRoot),
      runId: state.runId,
      workflowDir: state.workflowDir,
    });
    context.isResume = true;

    if (state.currentStepIndex >= definition.steps.length) {
      throw new Error(
        `Invalid run state: 'current_step_index' (${state.currentStepIndex}) is out of range for workflow ` +
        `${repr(state.workflowId)} with ${definition.steps.length} step(s).`,
      );
    }

    state.error = null;
    state.status = RunStatus.RUNNING;
    await state.save();
    this.emit("run_started", { run_id: state.runId, workflow_id: definition.id, resumed: true });

    // Resume from the current step — re-execute it so gates can prompt again.
    const remainingSteps = definition.steps.slice(state.currentStepIndex);
    const stepOffset = state.currentStepIndex;

    try {
      await this.executeSteps(remainingSteps, context, state, registry, stepOffset, lease);
    } catch (exc) {
      if (this.interrupted) {
        state.status = RunStatus.PAUSED;
        await state.appendLog({ event: "workflow_interrupted" });
        await state.save();
        this.finishSession(state, lease);
        return state;
      }
      state.status = RunStatus.FAILED;
      state.error = String(exc?.message ?? exc);
      await state.appendLog({ event: "resume_failed", error: state.error });
      await state.save();
      this.finishSession(state, lease);
      throw exc;
    }

    if (state.status === RunStatus.RUNNING) {
      state.status = RunStatus.COMPLETED;
    }
    await state.appendLog({ event: "workflow_finished", status: state.status });
    await state.save();
    this.finishSession(state, lease);
    return state;
  }

  async executeSteps(steps, context, state, registry, stepOffset = 0, lease = null) {
    for (let i = 0; i < steps.length; i++) {
      const stepConfig = steps[i];
      if (this.interrupted) {
        state.status = RunStatus.PAUSED;
        await state.save();
        return;
      }

      const stepId = stepConfig.id ?? `step-${i}`;
      const stepType = stepConfig.type ?? "command";

      state.currentStepId = stepId;
      if (stepOffset >= 0) {
        state.currentStepIndex = stepOffset + i;
      }
      await state.save();
      if (lease) lease.renew();
      this.emit("step_started", { run_id: state.runId, step_id: stepId, step_type: stepType });

      await state.appendLog({ event: "step_started", step_id: stepId, type: stepType });

      const label = stepConfig.command || stepType;
      if (this.onStepStart !== null) {
        this.onStepStart(stepId, label);
      }

      const stepImpl = registry[stepType];
      if (!stepImpl) {
        state.status = RunStatus.FAILED;
        state.error = `Unknown step type: ${repr(stepType)}`;
        await state.appendLog({ event: "step_failed", step_id: stepId, error: state.error });
        await state.save();
        return;
      }

      const result = await stepImpl.execute(stepConfig, context);

      const stepData = {
        type: stepType,
        integration: result.output.integration ?? stepConfig.integration ?? context.defaultIntegration ?? null,
        model: result.output.model ?? stepConfig.model ?? context.defaultModel ?? null,
        options: result.output.options ?? stepConfig.options ?? {},
        input: result.output.input ?? stepConfig.input ?? {},
        output: result.output,
        status: result.status,
        error: result.error,
      };
      this.recordResult(context, state, stepId, stepData);

      await state.appendLog({ event: "step_completed", step_id: stepId, status: result.status });
      this.emit("step_completed", { run_id: state.runId, step_id: stepId, step_type: stepType, status: result.status });

      if (result.status === StepStatus.PAUSED) {
        state.status = RunStatus.PAUSED;
        await state.save();
        if (stepType === "gate") {
          // Container gate identification (ADR-390-amendment): the gate
          // payload plus its normalized permission_request shape, reusing
          // the agentic container's existing HITL pipeline verbatim.
          this.emit("gate_paused", {
            run_id: state.runId,
            step_id: stepId,
            message: result.output.message,
            options: result.output.options,
            on_reject: result.output.on_reject,
            verdict_input: stepConfig.verdict_input ?? null,
          });
          this.emit("permission_request", {
            tool: "workflow-gate",
            request_id: `${state.runId}:${stepId}`,
            run_id: state.runId,
            step_id: stepId,
            message: result.output.message,
            options: result.output.options,
            verdict_input: stepConfig.verdict_input ?? null,
          });
        }
        return;
      }

      if (result.status === StepStatus.FAILED) {
        // Engine interrupt (e.g. SIGINT mid-shell-command): pause, don't fail.
        if (this.interrupted && result.output.interrupted) {
          state.status = RunStatus.PAUSED;
          await state.appendLog({ event: "workflow_interrupted" });
          await state.save();
          return;
        }

        if (result.output.aborted) {
          state.status = RunStatus.ABORTED;
          state.error = result.error;
          await state.appendLog({ event: "workflow_aborted", step_id: stepId });
          await state.save();
          return;
        }

        if (stepConfig.continue_on_error === true) {
          await state.appendLog({ event: "step_continue_on_error", step_id: stepId, error: result.error });
          await state.save();
          continue;
        }

        state.status = RunStatus.FAILED;
        state.error = result.error;
        await state.appendLog({ event: "step_failed", step_id: stepId, error: result.error });
        await state.save();
        return;
      }

      // Nested steps from control flow. step_offset=-1 so they don't update
      // current_step_index; a nested pause re-runs the parent body on resume.
      if (result.nextSteps && result.nextSteps.length > 0) {
        await this.executeSteps(result.nextSteps, context, state, registry, -1, lease);
        if ([RunStatus.PAUSED, RunStatus.FAILED, RunStatus.ABORTED].includes(state.status)) {
          return;
        }

        // Loop iteration: while/do-while re-evaluate after body.
        if (stepType === "while" || stepType === "do-while") {
          let maxIters = stepConfig.max_iterations;
          if (typeof maxIters === "boolean" || !Number.isInteger(maxIters) || maxIters < 1) {
            maxIters = 10;
          }
          const condition = stepConfig.condition ?? false;
          for (let loopIter = 0; loopIter < maxIters - 1; loopIter++) {
            if (!evaluateCondition(condition, context)) break;
            if (this.interrupted) {
              state.status = RunStatus.PAUSED;
              await state.save();
              return;
            }
            // Namespace nested step IDs per iteration; alias each result back
            // to the unprefixed key so the loop condition sees latest values.
            for (let nsIdx = 0; nsIdx < result.nextSteps.length; nsIdx++) {
              const ns = result.nextSteps[nsIdx];
              const nsCopy = { ...ns };
              const orig = nsCopy.id;
              const baseId = orig || `step-${nsIdx}`;
              nsCopy.id = `${stepId}:${baseId}:${loopIter + 1}`;
              await this.executeSteps([nsCopy], context, state, registry, -1, lease);
              if ([RunStatus.PAUSED, RunStatus.FAILED, RunStatus.ABORTED].includes(state.status)) {
                return;
              }
              if (orig && nsCopy.id in context.steps) {
                this.recordResult(context, state, orig, context.steps[nsCopy.id]);
              }
            }
          }
        }
      }

      // Fan-out: execute the nested step template once per item.
      if (stepType === "fan-out") {
        const items = result.output.items ?? [];
        const template = result.output.step_template ?? {};
        if (template && Object.keys(template).length > 0 && items.length > 0) {
          const fanOutResults = await this.runFanOut(
            items, template, stepId, context, state, registry,
            result.output.max_concurrency ?? 1, lease,
          );
          context.item = null;
          const fanOutOutput = { ...result.output, results: fanOutResults };
          state.setStepOutput(stepId, fanOutOutput);
          if ([RunStatus.PAUSED, RunStatus.FAILED, RunStatus.ABORTED].includes(state.status)) {
            return;
          }
        } else {
          result.output.results = [];
          state.setStepOutput(stepId, result.output);
        }
      }
    }
  }

  recordResult(context, state, stepId, data) {
    if (context.steps !== state.stepResults) {
      context.steps[stepId] = data;
    }
    state.recordStepResult(stepId, data);
  }

  async runFanOut(items, template, stepId, context, state, registry, maxConcurrency, lease = null) {
    // Run a fan-out template once per item; return per-item outputs in item
    // order. max_concurrency <= 1 (default) runs sequentially; > 1 runs a
    // bounded sliding window. On a halt, the returned prefix is the items up
    // to and including the first halting item in item order.
    if (items.length === 0) return [];

    const halting = [RunStatus.PAUSED, RunStatus.FAILED, RunStatus.ABORTED];
    let workers = 1;
    const n = Number(maxConcurrency);
    if (Number.isFinite(n)) workers = Math.max(1, Math.trunc(n));
    workers = Math.min(workers, items.length);

    const baseId = template.id ?? "item";
    const itemId = (idx) => `${stepId}:${baseId}:${idx}`;

    const runItem = async (idx, itemCtx) => {
      const itemStep = { ...template, id: itemId(idx) };
      await this.executeSteps([itemStep], itemCtx, state, registry, -1, lease);
      return itemCtx.steps[itemStep.id]?.output ?? {};
    };

    // Sequential path — identical to historical behavior.
    if (workers <= 1) {
      const results = [];
      const previousItem = context.item;
      const previousInsideFanOut = context.insideFanOut;
      context.insideFanOut = true;
      try {
        for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
          context.item = items[itemIdx];
          results.push(await runItem(itemIdx, context));
          if (halting.includes(state.status)) break;
          if (this.interrupted) {
            state.status = RunStatus.PAUSED;
            await state.save();
            break;
          }
        }
      } finally {
        context.item = previousItem;
        context.insideFanOut = previousInsideFanOut;
      }
      return results;
    }

    // Concurrent path — bounded sliding window; results in item order.
    const slots = new Array(items.length).fill(null);
    const itemHaltStatus = (idx) => {
      const rec = context.steps[itemId(idx)];
      if (rec === undefined || rec === null) {
        return halting.includes(state.status) ? state.status : null;
      }
      if (rec.status === StepStatus.PAUSED) return RunStatus.PAUSED;
      if (rec.status === StepStatus.FAILED) {
        const out = rec.output ?? {};
        if (out.aborted) return RunStatus.ABORTED;
        if (template.continue_on_error !== true) return RunStatus.FAILED;
      }
      return null;
    };

    const runIsolated = (idx) =>
      runItem(
        idx,
        context.withOverrides({ item: items[idx], insideFanOut: true }),
      );

    let halt = null; // [idx, status]
    let collected = 0;
    const inFlight = new Map(); // idx -> promise
    let nextSubmit = 0;

    for (let idx = 0; idx < items.length; idx++) {
      // Refill the window: keep <= workers in flight; stop launching once
      // the run is halting or interrupted.
      while (
        nextSubmit < items.length &&
        inFlight.size < workers &&
        !halting.includes(state.status) &&
        !this.interrupted
      ) {
        const submitIdx = nextSubmit++;
        inFlight.set(submitIdx, runIsolated(submitIdx).then(
          (v) => { slots[submitIdx] = v; },
          (err) => { slots[submitIdx] = { __error: String(err?.message ?? err) }; },
        ));
      }

      const fut = inFlight.get(idx);
      if (fut === undefined) break; // safety net: nothing in flight for this index
      inFlight.delete(idx);
      await fut;
      collected = idx + 1;
      const haltStatus = itemHaltStatus(idx);
      if (haltStatus !== null) {
        halt = [idx, haltStatus];
        break;
      }
    }

    if (inFlight.size > 0) {
      // Let already-running items finish; their outputs are ignored.
      await Promise.allSettled([...inFlight.values()]);
    }

    if (halt !== null) {
      const [haltedAt, haltedStatus] = halt;
      state.status = haltedStatus;
      const haltRec = context.steps[itemId(haltedAt)];
      if (haltRec && typeof haltRec === "object") {
        state.error = haltRec.error ?? null;
      }
      return slots.slice(0, haltedAt + 1);
    }
    return slots.slice(0, collected);
  }

  resolveInputs(definition, provided) {
    const resolved = {};
    if (typeof definition.inputs !== "object" || definition.inputs === null || Array.isArray(definition.inputs)) {
      return {};
    }
    for (const [name, inputDef] of Object.entries(definition.inputs)) {
      if (typeof inputDef !== "object" || inputDef === null || Array.isArray(inputDef)) continue;
      let value;
      if (name in provided) {
        value = this.resolveDefault(name, provided[name]);
      } else if ("default" in inputDef) {
        value = this.resolveDefault(name, inputDef.default);
      } else if (inputDef.required === true) {
        throw new Error(`Required input ${repr(name)} not provided.`);
      } else {
        continue;
      }

      let coerceInputDef = inputDef;
      if (name === "integration" && value === "auto" && Array.isArray(inputDef.enum)) {
        coerceInputDef = Object.fromEntries(Object.entries(inputDef).filter(([k]) => k !== "enum"));
      }
      resolved[name] = WorkflowEngine.coerceInput(name, value, coerceInputDef);
    }
    return resolved;
  }

  resolveDefault(name, defaultValue) {
    // `integration: auto` resolves to the agent recorded in
    // .adlc/init-options.json so workflows dispatch to the agent the
    // project was actually set up with.
    if (name === "integration" && defaultValue === "auto") {
      const resolved = readAgent(this.projectRoot);
      if (resolved !== null) return resolved;
    }
    return defaultValue;
  }

  static coerceInput(name, value, inputDef) {
    const inputType = inputDef.type ?? "string";
    const enumValues = inputDef.enum ?? null;

    if (enumValues !== null && !Array.isArray(enumValues)) {
      throw new Error(`Input ${repr(name)} has invalid 'enum': must be a list, got ${typeName(enumValues)}.`);
    }

    if (inputType === "number") {
      if (typeof value === "boolean" || value === null || value === undefined) {
        throw new Error(`Input ${repr(name)} expected a number, got ${repr(value)}.`);
      }
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) {
        throw new Error(`Input ${repr(name)} expected a number, got ${repr(value)}.`);
      }
      value = num;
    } else if (inputType === "boolean") {
      if (typeof value === "string") {
        const lower = value.toLowerCase();
        if (["true", "1", "yes"].includes(lower)) value = true;
        else if (["false", "0", "no"].includes(lower)) value = false;
        else throw new Error(`Input ${repr(name)} expected a boolean, got ${repr(value)}.`);
      } else if (typeof value !== "boolean") {
        throw new Error(`Input ${repr(name)} expected a boolean, got ${repr(value)}.`);
      }
    } else if (inputType === "string") {
      if (typeof value !== "string") {
        throw new Error(`Input ${repr(name)} expected a string, got ${repr(value)}.`);
      }
    }

    if (enumValues !== null && !enumValues.some((v) => looseEqForInput(v, value))) {
      throw new Error(`Input ${repr(name)} value ${repr(value)} not in allowed values: ${JSON.stringify(enumValues)}.`);
    }

    return value;
  }

  listRuns() {
    const runsDir = join(this.projectRoot, ".adlc", "workflows", "runs");
    if (!existsSync(runsDir)) return [];
    const runs = [];
    for (const entry of readdirSync(runsDir).sort()) {
      const runDir = join(runsDir, entry);
      let isDir = false;
      try { isDir = statSync(runDir).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      const statePath = join(runDir, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const stateData = JSON.parse(readFileSync(statePath, "utf-8"));
        if (typeof stateData === "object" && stateData !== null && "run_id" in stateData) {
          runs.push(stateData);
        }
      } catch {
        continue;
      }
    }
    return runs;
  }
}

function looseEqForInput(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return a === b;
}
