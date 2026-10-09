// State helpers — the LLM-executor librarian API (ADR-395 §3).
// The skill executor never hand-writes state.json; it drives runs through
// these operations. Each call is a session boundary: lease-checked write,
// save, git-refs Tier-3 push, and lease release on session end (pause or
// terminal status).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowEngine, WorkflowDefinition, RunState, RunStatus } from "./engine.mjs";
import { STEP_REGISTRY } from "./registry.mjs";
import { Lease } from "./lease.mjs";
import { pushRunRef } from "./refs.mjs";

// start: create a run (status running, index 0) from a workflow source.
// Returns the run state. Does NOT execute steps — the LLM executor drives.
export async function stateStart({ projectRoot = process.cwd(), workflowSource, runId = null, inputs = {} } = {}) {
  const engine = new WorkflowEngine(projectRoot);
  const definition = engine.loadWorkflow(workflowSource);
  const errors = engine.validate(definition, STEP_REGISTRY);
  if (errors.length > 0) {
    throw new Error(`Workflow validation failed:\n  ${errors.join("\n  ")}`);
  }

  const state = new RunState({ runId, workflowId: definition.id, projectRoot });
  const lease = new Lease(state.runsDir, { runId: state.runId });
  lease.acquire();
  const releaseCommandScoped = () => {
    if (!lease.persistent) lease.release();
  };

  // Frozen workflow copy (deterministic CLI-side resume, ADR-395 §5).
  const { copyFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(state.runsDir, { recursive: true });
  if (definition.sourcePath && existsSync(definition.sourcePath)) {
    copyFileSync(definition.sourcePath, join(state.runsDir, "workflow.yml"));
  } else if (definition.sourceYaml) {
    writeFileSync(join(state.runsDir, "workflow.yml"), definition.sourceYaml);
  } else {
    writeFileSync(join(state.runsDir, "workflow.yml"), "# serialized from string source\n" + JSON.stringify(definition.data, null, 2));
  }

  state.inputs = engine.resolveInputs(definition, inputs);
  state.status = RunStatus.RUNNING;
  state.currentStepIndex = 0;
  state.currentStepId = definition.steps[0]?.id ?? null;
  await state.save();
  pushRunRef(projectRoot, state.runId, state.runsDir);
  releaseCommandScoped();
  return state;
}

// Load a run + its workflow definition (frozen copy first) for helper ops.
function loadForHelper(runId, projectRoot) {
  const state = RunState.load(runId, projectRoot);
  const runCopy = join(state.runsDir, "workflow.yml");
  let definition;
  if (existsSync(runCopy)) {
    definition = WorkflowDefinition.fromYamlFile(runCopy);
  } else {
    definition = new WorkflowEngine(projectRoot).loadWorkflow(state.workflowId);
  }
  return { state, definition, lease: new Lease(state.runsDir, { runId }) };
}

function stepIndex(definition, stepId) {
  const idx = definition.steps.findIndex((s) => s && s.id === stepId);
  if (idx === -1) {
    const valid = definition.steps.map((s) => s?.id).filter(Boolean).join(", ");
    throw new Error(`Unknown step '${stepId}' in workflow '${definition.id}'. Steps: ${valid}.`);
  }
  return idx;
}

// advance: record a step result and move the program counter.
// --status completed|failed; on the LAST step completing, the run completes.
export async function stateAdvance({
  projectRoot = process.cwd(),
  runId,
  stepId,
  status,
  output = null,
  error = null,
} = {}) {
  const { state, definition, lease } = loadForHelper(runId, projectRoot);
  lease.renew();

  if (![RunStatus.RUNNING, RunStatus.PAUSED, RunStatus.FAILED].includes(state.status)) {
    throw new Error(`Run '${runId}' is ${state.status}; advance requires an active (running/paused/failed) run.`);
  }

  const idx = stepIndex(definition, stepId);
  const stepConfig = definition.steps[idx];
  const stepType = stepConfig.type ?? "command";

  state.recordStepResult(stepId, {
    type: stepType,
    integration: stepConfig.integration ?? null,
    model: stepConfig.model ?? null,
    options: stepConfig.options ?? {},
    input: stepConfig.input ?? {},
    output: output ?? {},
    status,
    error,
  });
  state.currentStepId = stepId;
  state.currentStepIndex = idx;
  state.error = status === "failed" ? error : null;

  const isLast = idx === definition.steps.length - 1;
  if (status === "completed" && isLast) {
    state.status = RunStatus.COMPLETED;
  } else if (status === "completed") {
    state.status = RunStatus.RUNNING;
    state.currentStepIndex = idx + 1;
    state.currentStepId = definition.steps[idx + 1]?.id ?? null;
  } else {
    state.status = RunStatus.FAILED;
  }

  await state.save();
  pushRunRef(projectRoot, runId, state.runsDir);
  if (state.status === RunStatus.COMPLETED || !lease.persistent) lease.release();
  return state;
}

// pause: park the run at a step (gate hit / human checkpoint). Releases the
// lease — exit-and-resume semantics; any executor may pick the run up.
export async function statePause({ projectRoot = process.cwd(), runId, stepId } = {}) {
  const { state, definition, lease } = loadForHelper(runId, projectRoot);
  lease.renew();
  const idx = stepIndex(definition, stepId);
  state.status = RunStatus.PAUSED;
  state.currentStepIndex = idx;
  state.currentStepId = stepId;
  await state.save();
  pushRunRef(projectRoot, runId, state.runsDir);
  lease.release();
  return state;
}

// fail: terminal failure with an error message. Releases the lease.
export async function stateFail({ projectRoot = process.cwd(), runId, error } = {}) {
  const { state, lease } = loadForHelper(runId, projectRoot);
  lease.renew();
  state.status = RunStatus.FAILED;
  state.error = error ?? "failed";
  await state.save();
  pushRunRef(projectRoot, runId, state.runsDir);
  lease.release();
  return state;
}

// show: read-only state access.
export function stateShow({ projectRoot = process.cwd(), runId } = {}) {
  return RunState.load(runId, projectRoot);
}
