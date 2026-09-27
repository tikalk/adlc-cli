// Event stream + built-in definition + git-refs tests (ADR-390/391/393
// amendments). Event shapes are the container/HITL contract — pinned here
// before any container work consumes them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  WorkflowEngine,
  WorkflowDefinition,
  validateWorkflow,
  headlessGateErrors,
  RunStatus,
} from "../src/factory/engine.mjs";
import { STEP_REGISTRY } from "../src/factory/registry.mjs";
import { BUILTIN_WORKFLOWS } from "../src/factory/builtins.mjs";

function makeProject({ git = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wf-events-"));
  if (git) {
    execSync("git init -q", { cwd: dir });
    execSync("git config user.email t@t.local", { cwd: dir });
    execSync("git config user.name t", { cwd: dir });
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeGateWorkflow(dir, { verdictDeclared = true } = {}) {
  const path = join(dir, "wf.yml");
  writeFileSync(path, `
schema_version: "1.0"
workflow:
  id: evt-wf
  name: Evt
  version: "1.0.0"
inputs:
  verdict: {type: string}
steps:
  - id: prep
    type: shell
    run: "echo prep"
  - id: review
    type: gate
    message: "Approve?"
    options: [approve, reject]
    ${verdictDeclared ? "verdict_input: verdict" : ""}
  - id: fin
    type: shell
    run: "echo fin"
`, "utf-8");
  return path;
}

function captureEvents(engine) {
  const events = [];
  engine.onEvent = (event) => events.push(event);
  return events;
}

test("event stream: run lifecycle + step events with exact shapes", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeGateWorkflow(dir);
    const engine = new WorkflowEngine(dir);
    const events = captureEvents(engine);

    const state1 = await engine.execute(engine.loadWorkflow(path), { verdict: "" }, "ee000001", STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      "run_started",
      "step_started",
      "step_completed",
      "step_started",
      "step_completed",
      "gate_paused",
      "permission_request",
      "run_paused",
    ]);

    // Shape pins.
    const runStarted = events[0];
    assert.equal(runStarted.run_id, "ee000001");
    assert.equal(runStarted.workflow_id, "evt-wf");
    assert.ok(runStarted.ts);

    const stepStarted = events[1];
    assert.deepEqual(
      { run_id: stepStarted.run_id, step_id: stepStarted.step_id, step_type: stepStarted.step_type },
      { run_id: "ee000001", step_id: "prep", step_type: "shell" },
    );

    const stepCompleted = events[2];
    assert.equal(stepCompleted.status, "completed");

    const gatePaused = events[5];
    assert.equal(gatePaused.step_id, "review");
    assert.equal(gatePaused.message, "Approve?");
    assert.deepEqual(gatePaused.options, ["approve", "reject"]);
    assert.equal(gatePaused.verdict_input, "verdict");
    assert.equal(gatePaused.run_id, "ee000001");

    // Normalized permission_request (container HITL reuse, ADR-390-amendment).
    const perm = events[6];
    assert.equal(perm.type, "permission_request");
    assert.equal(perm.tool, "workflow-gate");
    assert.equal(perm.request_id, "ee000001:review");
    assert.deepEqual(perm.options, ["approve", "reject"]);
    assert.equal(perm.verdict_input, "verdict");

    const runPaused = events[7];
    assert.equal(runPaused.current_step_id, "review");

    // Resume completes: run_started(resumed) → gate re-executes → fin → run_completed.
    events.length = 0;
    const state2 = await engine.resume("ee000001", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(state2.status, RunStatus.COMPLETED);
    assert.deepEqual(events.map((e) => e.type), [
      "run_started",
      "step_started",
      "step_completed",
      "step_started",
      "step_completed",
      "run_completed",
    ]);
    assert.equal(events[0].resumed, true);
  } finally {
    cleanup();
  }
});

test("event stream: failure path emits run_failed", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = join(dir, "wf.yml");
    writeFileSync(path, `
schema_version: "1.0"
workflow:
  id: fail-wf
  name: F
  version: "1.0.0"
steps:
  - id: bad
    type: shell
    run: "exit 9"
`);
    const engine = new WorkflowEngine(dir);
    const events = captureEvents(engine);
    const state = await engine.execute(engine.loadWorkflow(path), {}, "ee000002", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    const last = events[events.length - 1];
    assert.equal(last.type, "run_failed");
    assert.ok((last.error ?? "").includes("code 9"));
  } finally {
    cleanup();
  }
});

// ── built-ins ────────────────────────────────────────────────────────────

test("built-in factory: loads, validates, headless-valid", () => {
  const { dir, cleanup } = makeProject();
  try {
    const engine = new WorkflowEngine(dir);
    const def = engine.loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.sourceYaml, BUILTIN_WORKFLOWS.factory.yaml);
    assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
    assert.deepEqual(headlessGateErrors(def), []);
    // Every gate declares verdict_input; stages are command steps.
    const gates = def.steps.filter((s) => s.type === "gate");
    const commands = def.steps.filter((s) => s.type !== "gate");
    assert.equal(gates.length, 3);
    assert.ok(gates.every((g) => g.verdict_input === "verdict"));
    assert.ok(commands.every((c) => c.type === "command" && typeof c.command === "string"));
  } finally {
    cleanup();
  }
});

test("built-in factory: run copies sourceYaml verbatim into the run dir", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const engine = new WorkflowEngine(dir);
    const def = engine.loadWorkflow("factory");
    // Execute with a stub registry so command steps don't spawn agents:
    // replace command steps with a no-op shell to reach the first gate.
    const stubDef = new WorkflowDefinition({
      ...def.data,
      steps: def.steps.map((s) =>
        s.type === "command" ? { id: s.id, type: "shell", run: `echo ${s.id}` } : s,
      ),
    }, null, def.sourceYaml);
    // NOTE: frozen copy uses the ORIGINAL builtin yaml (sourceYaml), which is
    // what we assert — the stub only changes execution.
    const events = [];
    const eng = new WorkflowEngine(dir);
    eng.onEvent = (event) => events.push(event);
    const state = await eng.execute(stubDef, { verdict: "" }, "ee000003", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    assert.equal(state.currentStepId, "gate-product");

    const runCopy = join(dir, ".adlc", "workflows", "runs", "ee000003", "workflow.yml");
    assert.equal(readFileSync(runCopy, "utf-8"), BUILTIN_WORKFLOWS.factory.yaml);

    // gate_paused fired for the factory stage gate.
    const gate = events.find((e) => e.type === "gate_paused");
    assert.equal(gate.step_id, "gate-product");
    assert.equal(gate.verdict_input, "verdict");
  } finally {
    cleanup();
  }
});

// ── git-refs Tier-3 at engine exit points (ADR-393) ─────────────────────

test("git-refs: engine pause and completion land refs/factory-runs/<run_id>", async () => {
  const { dir, cleanup } = makeProject({ git: true });
  try {
    const path = writeGateWorkflow(dir);
    const engine = new WorkflowEngine(dir);
    const state1 = await engine.execute(engine.loadWorkflow(path), { verdict: "" }, "ee000004", STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);

    const ref = execSync("git rev-parse refs/factory-runs/ee000004", { cwd: dir, encoding: "utf-8" }).trim();
    assert.match(ref, /^[0-9a-f]{40}$/);
    const files = execSync("git ls-tree -r --name-only refs/factory-runs/ee000004", { cwd: dir, encoding: "utf-8" });
    assert.match(files, /state\.json/);
    assert.match(files, /workflow\.yml/);

    const state2 = await engine.resume("ee000004", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(state2.status, RunStatus.COMPLETED);
    const finalState = JSON.parse(
      execSync("git show refs/factory-runs/ee000004:state.json", { cwd: dir, encoding: "utf-8" }),
    );
    assert.equal(finalState.status, "completed");

    // main history untouched (unborn branch or zero commits).
    let mainLog = "";
    try {
      mainLog = execSync("git log --oneline", { cwd: dir, encoding: "utf-8" }).trim();
    } catch {}
    assert.equal(mainLog, "");
  } finally {
    cleanup();
  }
});

test("git-refs: skipped silently outside a git repo", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = join(dir, "wf.yml");
    writeFileSync(path, `
schema_version: "1.0"
workflow:
  id: norepo-wf
  name: N
  version: "1.0.0"
steps:
  - id: a
    type: shell
    run: "true"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(path), {}, "ee000005", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED); // no crash, no ref
  } finally {
    cleanup();
  }
});

// ── validate --headless ──────────────────────────────────────────────────

test("headless validation: gates without verdict_input are rejected (recursively)", () => {
  const { dir, cleanup } = makeProject();
  try {
    // Top-level gate without verdict_input.
    const path = writeGateWorkflow(dir, { verdictDeclared: false });
    const engine = new WorkflowEngine(dir);
    const def = engine.loadWorkflow(path);
    assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []); // structurally valid
    const errors = headlessGateErrors(def);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("Gate step 'review'"));
    assert.ok(errors[0].includes("cannot be resumed headless"));

    // Gate nested inside an if branch.
    const nested = WorkflowDefinition.fromString(`
schema_version: "1.0"
workflow:
  id: nested-wf
  name: NW
  version: "1.0.0"
steps:
  - id: branch
    type: if
    condition: "{{ inputs.go }}"
    then:
      - id: inner-gate
        type: gate
        message: "nested gate without verdict"
        options: [approve, reject]
`);
    const nestedErrors = headlessGateErrors(nested);
    assert.equal(nestedErrors.length, 1);
    assert.ok(nestedErrors[0].includes("branch:then"));
    assert.ok(nestedErrors[0].includes("inner-gate"));
  } finally {
    cleanup();
  }
});
