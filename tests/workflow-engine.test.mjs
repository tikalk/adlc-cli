// Engine + e2e tests: run → gate PAUSED → resume → COMPLETED, fan-out
// (sequential + max_concurrency), loops, validation, resume persistence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine, WorkflowDefinition, validateWorkflow, RunStatus } from "../src/factory/engine.mjs";
import { STEP_REGISTRY } from "../src/factory/registry.mjs";
import { StepStatus } from "../src/factory/base.mjs";

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "factory-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeWorkflow(dir, yaml) {
  const path = join(dir, "workflow.yml");
  writeFileSync(path, yaml, "utf-8");
  return path;
}

test("validate: full workflow passes, malformed ones fail with named errors", () => {
  const def = WorkflowDefinition.fromString(`
schema_version: "1.0"
workflow:
  id: test-wf
  name: Test
  version: "1.0.0"
steps:
  - id: a
    type: shell
    run: "true"
  - id: g
    type: gate
    message: "ok?"
    options: [approve, reject]
`);
  assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);

  const bad = WorkflowDefinition.fromString(`
schema_version: "1.0"
workflow:
  id: TestWF
  name: Bad
  version: "1.0.0"
steps:
  - id: a
    type: bogus-type
  - id: a
    type: shell
    run: "true"
`);
  const errors = validateWorkflow(bad, STEP_REGISTRY);
  assert.ok(errors.some((e) => e.includes("must be lowercase alphanumeric")));
  assert.ok(errors.some((e) => e.includes("invalid type 'bogus-type'")));
  assert.ok(errors.some((e) => e.includes("Duplicate step ID")));
});

test("e2e: shell + gate pause + resume with verdict completes", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: gate-wf
  name: Gate
  version: "1.0.0"
inputs:
  verdict:
    type: string
steps:
  - id: work
    type: shell
    run: "echo done"
  - id: review
    type: gate
    message: "Approve?"
    options: [approve, reject]
    verdict_input: verdict
  - id: after
    type: shell
    run: "echo after-{{ steps.review.output.choice }}"
`);
    const engine = new WorkflowEngine(dir);
    const def = engine.loadWorkflow(path);
    assert.deepEqual(engine.validate(def, STEP_REGISTRY), []);

    // Non-TTY (test runner has no stdin TTY) → gate pauses, process "exits".
    const state1 = await engine.execute(def, {}, null, STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);
    assert.equal(state1.currentStepId, "review");
    assert.ok(existsSync(join(dir, ".adlc", "workflows", "runs", state1.runId, "state.json")));
    assert.ok(existsSync(join(dir, ".adlc", "workflows", "runs", state1.runId, "workflow.yml")));
    // Verbatim copy: bytes equal the source file.
    assert.equal(
      readFileSync(join(dir, ".adlc", "workflows", "runs", state1.runId, "workflow.yml"), "utf-8"),
      readFileSync(path, "utf-8"),
    );

    // Resume headlessly with the verdict bound via verdict_input.
    const state2 = await engine.resume(state1.runId, { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(state2.status, RunStatus.COMPLETED);
    assert.equal(state2.stepResults.review.output.choice, "approve");
    assert.match(state2.stepResults.after.output.stdout, /after-approve/);
  } finally {
    cleanup();
  }
});

test("e2e: gate reject with on_reject=abort aborts the run", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: reject-wf
  name: Reject
  version: "1.0.0"
inputs:
  verdict:
    type: string
steps:
  - id: review
    type: gate
    message: "Approve?"
    options: [approve, reject]
    verdict_input: verdict
  - id: never
    type: shell
    run: "echo nope"
`);
    const engine = new WorkflowEngine(dir);
    const state1 = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);
    const state2 = await engine.resume(state1.runId, { verdict: "reject" }, STEP_REGISTRY);
    assert.equal(state2.status, RunStatus.ABORTED);
    assert.ok(!(("never" in state2.stepResults)));
  } finally {
    cleanup();
  }
});

test("e2e: failing shell halts; continue_on_error routes around it", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: fail-wf
  name: Fail
  version: "1.0.0"
steps:
  - id: bad
    type: shell
    run: "exit 7"
    continue_on_error: true
  - id: check
    type: if
    condition: "{{ steps.bad.output.exit_code != 0 }}"
    then:
      - id: recover
        type: shell
        run: "echo recovered"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(state.stepResults.bad.status, StepStatus.FAILED);
    assert.equal(state.stepResults.bad.output.exit_code, 7);
    assert.match(state.stepResults.recover.output.stdout, /recovered/);
  } finally {
    cleanup();
  }
});

test("e2e: fan-out sequential + fan-in aggregation", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: fan-wf
  name: Fan
  version: "1.0.0"
steps:
  - id: emit
    type: shell
    run: "node -p [1,2,3]"
    output_format: json
  - id: work
    type: fan-out
    items: "{{ steps.emit.output.data }}"
    step:
      id: unit
      type: shell
      run: "echo item-{{ item }}"
  - id: collect
    type: fan-in
    wait_for: [work]
    output:
      joined: "{{ steps.work.output.results | map('stdout') | join(',') }}"
      waited_count: "{{ fan_in.results[0].item_count }}"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(state.stepResults.work.output.results.length, 3);
    assert.match(state.stepResults.collect.output.joined, /item-1/);
    assert.match(state.stepResults.collect.output.joined, /item-3/);
    // fan_in.results holds the waited-for steps' outputs (the fan-out's own output).
    assert.equal(state.stepResults.collect.output.waited_count, 3);
  } finally {
    cleanup();
  }
});

test("e2e: fan-out max_concurrency > 1 completes with ordered results", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: fan-conc
  name: FanConc
  version: "1.0.0"
steps:
  - id: emit
    type: shell
    run: "node -p [10,20,30,40,50,60]"
    output_format: json
  - id: work
    type: fan-out
    items: "{{ steps.emit.output.data }}"
    max_concurrency: 3
    step:
      id: unit
      type: shell
      run: "echo item-{{ item }}"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    const results = state.stepResults.work.output.results;
    assert.equal(results.length, 6);
    // Results assembled in item order regardless of completion order.
    assert.match(results[0].stdout, /item-10/);
    assert.match(results[5].stdout, /item-60/);
  } finally {
    cleanup();
  }
});

test("e2e: while loop with max_iterations cap", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: loop-wf
  name: Loop
  version: "1.0.0"
steps:
  - id: spin
    type: while
    condition: "true"
    max_iterations: 3
    steps:
      - id: tick
        type: shell
        run: "echo tick"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    // Initial body run records the original id; each re-run records a
    // namespaced parentId:stepId:iteration key. Total = max_iterations.
    assert.ok("tick" in state.stepResults);
    const tickKeys = Object.keys(state.stepResults).filter((k) => k.startsWith("spin:tick"));
    assert.equal(tickKeys.length, 2); // max_iterations - 1 namespaced re-runs
    assert.equal(1 + tickKeys.length, 3);
  } finally {
    cleanup();
  }
});

test("e2e: switch dispatch on expression value", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: switch-wf
  name: Switch
  version: "1.0.0"
inputs:
  mode:
    type: string
    default: fast
steps:
  - id: emit
    type: shell
    run: "node -p \\"'{{ inputs.mode }}'\\""
  - id: route
    type: switch
    expression: "{{ steps.emit.output.stdout | default('') }}"
    cases:
      fast:
        - id: fast-path
          type: shell
          run: "echo fast"
      slow:
        - id: slow-path
          type: shell
          run: "echo slow"
    default:
      - id: fallback
        type: shell
        run: "echo fallback"
`);
    const engine = new WorkflowEngine(dir);
    // stdout of `echo fast` is "fast\n" — switch strips before matching.
    const state = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(state.stepResults.route.output.matched_case, "fast");
    assert.ok("fast-path" in state.stepResults);
    assert.ok(!("slow-path" in state.stepResults));
  } finally {
    cleanup();
  }
});

test("e2e: resume from a fresh project root (workflow copy independence)", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: cross-wf
  name: Cross
  version: "1.0.0"
inputs:
  verdict:
    type: string
steps:
  - id: review
    type: gate
    message: "Approve?"
    options: [approve, reject]
    verdict_input: verdict
  - id: fin
    type: shell
    run: "echo fin"
`);
    const engine1 = new WorkflowEngine(dir);
    const state1 = await engine1.execute(engine1.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);

    // A new engine instance (e.g. next CLI invocation) resumes from disk.
    const engine2 = new WorkflowEngine(dir);
    const state2 = await engine2.resume(state1.runId, { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(state2.status, RunStatus.COMPLETED);
    assert.ok("fin" in state2.stepResults);
  } finally {
    cleanup();
  }
});

test("required input not provided raises", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: req-wf
  name: Req
  version: "1.0.0"
inputs:
  spec:
    type: string
    required: true
steps:
  - id: a
    type: shell
    run: "echo hi"
`);
    const engine = new WorkflowEngine(dir);
    await assert.rejects(
      () => engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY),
      /Required input 'spec' not provided/,
    );
  } finally {
    cleanup();
  }
});

test("installed workflow ID resolves from .adlc/workflows/", async () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, ".adlc", "workflows", "deploy"), { recursive: true });
    writeFileSync(join(dir, ".adlc", "workflows", "deploy", "workflow.yml"), `
schema_version: "1.0"
workflow:
  id: deploy
  name: Deploy
  version: "1.0.0"
steps:
  - id: go
    type: shell
    run: "echo deploy"
`, "utf-8");
    const engine = new WorkflowEngine(dir);
    const def = engine.loadWorkflow("deploy");
    assert.equal(def.id, "deploy");
    const state = await engine.execute(def, {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
  } finally {
    cleanup();
  }
});

test("slot step skips when unfilled", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir, `
schema_version: "1.0"
workflow:
  id: slot-wf
  name: Slot
  version: "1.0.0"
steps:
  - id: post
    type: slot
    name: "Post-implementation checks"
  - id: done
    type: shell
    run: "echo done"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(path), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(state.stepResults.post.status, StepStatus.SKIPPED);
  } finally {
    cleanup();
  }
});

test("integration: auto resolves from .adlc/init-options.json", async () => {
  const { dir, cleanup } = makeProject();
  try {
    mkdirSync(join(dir, ".adlc"), { recursive: true });
    writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
    const engine = new WorkflowEngine(dir);
    const resolved = engine.resolveInputs(
      WorkflowDefinition.fromString(`
inputs:
  integration:
    type: string
    default: auto
steps: []
`),
      {},
    );
    assert.equal(resolved.integration, "opencode");
  } finally {
    cleanup();
  }
});
