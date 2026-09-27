// Parity tests ported from upstream spec-kit tests/test_workflows.py @ adbd62a
// (ADR-390: ported upstream unit tests are the correctness guard).
// Covers: expressions edge cases, gate verdict_input semantics,
// continue_on_error interactions, RunState validation, resume-with-inputs.
// Not ported (upstream-only surfaces): catalog/registry commands,
// build_exec_args, init step, custom-step loading, CLI alignment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateExpression, evaluateCondition } from "../src/factory/expressions.mjs";
import { StepContext, StepStatus, RunStatus } from "../src/factory/base.mjs";
import { WorkflowEngine, WorkflowDefinition, RunState, validateWorkflow } from "../src/factory/engine.mjs";
import { STEP_REGISTRY, getStepType } from "../src/factory/registry.mjs";
import { GateStep } from "../src/factory/steps/gate.mjs";

const ctx = (fields = {}) => new StepContext(fields);

// ── TestExpressions (ported) ─────────────────────────────────────────────

test("multi-expression: no surrounding text interpolates each (#3208)", () => {
  const c = ctx({ inputs: { issue: "23" }, runId: "47c5eb4b" });
  assert.equal(evaluateExpression("{{ context.run_id }} {{ inputs.issue }}", c), "47c5eb4b 23");
});

test("multi-expression: adjacent no separator interpolates", () => {
  const c = ctx({ inputs: { a: "foo", b: "bar" } });
  assert.equal(evaluateExpression("{{ inputs.a }}{{ inputs.b }}", c), "foobar");
});

test("single expression with literal braces preserves type", () => {
  assert.equal(evaluateExpression("{{ inputs.text | contains('{{') }}", ctx({ inputs: { text: "uses {{ jinja }} syntax" } })), true);
  assert.equal(evaluateExpression("{{ inputs.text | contains('}}') }}", ctx({ inputs: { text: "uses }} syntax" } })), true);
});

test("multi-expression with literal close brace in argument interpolates", () => {
  const c = ctx({ inputs: { name: "Bob", missing: null } });
  assert.equal(evaluateExpression("{{ inputs.name }}: {{ inputs.missing | default('}}') }}", c), "Bob: }}");
  assert.equal(evaluateExpression("{{ inputs.missing | default('}}') }} / {{ inputs.name }}", c), "}} / Bob");
});

test("multi-expression with literal open brace in argument interpolates", () => {
  const c = ctx({ inputs: { name: "Bob", missing: null } });
  assert.equal(evaluateExpression("{{ inputs.name }} {{ inputs.missing | default('{{') }}", c), "Bob {{");
});

test("ordering comparison of non-numeric strings is lexicographic", () => {
  // ISO dates compare lexicographically (correct chronological order).
  const c = ctx({ inputs: { d: "2026-01-01" } });
  assert.equal(evaluateExpression("{{ inputs.d < '2026-02-01' }}", c), true);
  assert.equal(evaluateExpression("{{ inputs.d > '2026-02-01' }}", c), false);
  // Plain string ordering.
  assert.equal(evaluateExpression("{{ inputs.name > 'alpha' }}", ctx({ inputs: { name: "beta" } })), true);
  // Two numeric strings still compare numerically ("10" > "9").
  assert.equal(evaluateExpression("{{ inputs.v > '9' }}", ctx({ inputs: { v: "10" } })), true);
  // A number vs a non-numeric string is genuinely incomparable -> False.
  assert.equal(evaluateExpression("{{ inputs.n > 'abc' }}", ctx({ inputs: { n: 5 } })), false);
});

test("list literal preserves quoted commas", () => {
  const c = ctx();
  assert.deepEqual(evaluateExpression('{{ ["a, b", "c"] }}', c), ["a, b", "c"]);
  assert.deepEqual(evaluateExpression("{{ ['a, b', 'c'] }}", c), ["a, b", "c"]);
  assert.deepEqual(evaluateExpression("{{ [] }}", c), []);
  assert.deepEqual(evaluateExpression('{{ [["a", "b"], "c"] }}', c), [["a", "b"], "c"]);
  assert.deepEqual(evaluateExpression("{{ [[1, 2], [3, 4]] }}", c), [[1, 2], [3, 4]]);
});

test("list literal ignores trailing and empty commas, keeps ''", () => {
  const c = ctx();
  assert.deepEqual(evaluateExpression("{{ [1, 2,] }}", c), [1, 2]);
  assert.deepEqual(evaluateExpression("{{ [1,, 2] }}", c), [1, 2]);
  assert.deepEqual(evaluateExpression("{{ ['', 'a'] }}", c), ["", "a"]);
});

test("list literal followed by index is not misparsed as one literal", () => {
  const c = ctx();
  assert.equal(evaluateExpression("{{ [1,2,3][1] }}", c), null);
  assert.equal(evaluateExpression("{{ [1,2][0] }}", c), null);
  assert.deepEqual(evaluateExpression("{{ [1, 2, 3] }}", c), [1, 2, 3]);
  assert.deepEqual(evaluateExpression("{{ ['a]', 'b'] }}", c), ["a]", "b"]);
});

test("operator splitting is quote-aware", () => {
  const c = ctx({ inputs: { mode: "read and write" } });
  assert.equal(evaluateExpression("{{ inputs.mode == 'read and write' }}", c), true);
  assert.equal(evaluateExpression("{{ inputs.mode == 'read or write' }}", c), false);
  const left = ctx({ inputs: { x: "approve or reject" } });
  assert.equal(evaluateExpression("{{ 'approve or reject' == inputs.x }}", left), true);
  assert.equal(evaluateExpression("{{ 'cat' in 'cat and dog' }}", ctx()), true);
  // literal-vs-literal equality no longer mis-strips
  assert.equal(evaluateCondition("{{ 'done' == 'failed' }}", ctx()), false);
  assert.equal(evaluateCondition("{{ 'done' == 'done' }}", ctx()), true);
  // single quoted literal containing operator text is preserved
  assert.equal(evaluateExpression("{{ 'a == b' }}", ctx()), "a == b");
  assert.equal(evaluateExpression("{{ 'x and y' }}", ctx()), "x and y");
  // regression: plain parsing still works
  const plain = ctx({ inputs: { a: 1, b: 2, mode: "read" } });
  assert.equal(evaluateExpression("{{ inputs.mode == 'read' }}", plain), true);
  assert.equal(evaluateExpression("{{ inputs.a == 1 and inputs.b == 2 }}", plain), true);
  assert.equal(evaluateExpression("{{ inputs.a == 9 or inputs.b == 2 }}", plain), true);
  assert.equal(evaluateExpression("{{ inputs.missing | default('a and b') }}", plain), "a and b");
});

test("pipe detection is quote-aware", () => {
  const c = ctx({ inputs: { x: "a|b" } });
  assert.equal(evaluateExpression("{{ inputs.x == 'a|b' }}", c), true);
  assert.equal(evaluateExpression("{{ inputs.x == 'a|b' }}", ctx({ inputs: { x: "z" } })), false);
  assert.equal(evaluateExpression("{{ 'a|b' in inputs.s }}", ctx({ inputs: { s: "x a|b y" } })), true);
  assert.equal(evaluateExpression("{{ 'a|b|c' }}", ctx()), "a|b|c");
  // real filters still work, incl. pipe inside a filter arg
  const c2 = ctx({ inputs: { items: ["a", "b"], s: "xabz" } });
  assert.equal(evaluateExpression("{{ inputs.missing | default('y') }}", c2), "y");
  assert.equal(evaluateExpression('{{ inputs.items | join("-") }}', c2), "a-b");
  assert.equal(evaluateExpression("{{ inputs.s | contains('ab') }}", c2), true);
  assert.equal(evaluateExpression("{{ inputs.missing | default('a|b') }}", c2), "a|b");
});

test("from_json rejects every malformed form", () => {
  const c = ctx({ steps: { emit: { output: { stdout: '{"a": 1}' } } } });
  const badForms = ["from_json()", "from_json('x')", "from_json ()", "from_json ('x')", "from_json)", "from_json extra", "from_json 'x'"];
  for (const bad of badForms) {
    assert.throws(
      () => evaluateExpression(`{{ steps.emit.output.stdout | ${bad} }}`, c),
      /from_json: expected/,
      bad,
    );
  }
});

test("unknown filter name raises (with and without args)", () => {
  assert.throws(() => evaluateExpression("{{ inputs.items | length }}", ctx({ inputs: { items: [1, 2, 3] } })), /unknown filter 'length'/);
  assert.throws(() => evaluateExpression("{{ inputs.text | length(2) }}", ctx({ inputs: { text: "hello" } })), /unknown filter 'length'/);
});

test("filter argument type guards raise ValueError-shaped errors", () => {
  assert.throws(() => evaluateExpression("{{ inputs.rows | map(5) }}", ctx({ inputs: { rows: [{}] } })), /map: expected a string attribute name/);
  assert.throws(() => evaluateExpression("{{ inputs.tags | join(5) }}", ctx({ inputs: { tags: ["a"] } })), /join: expected a string separator/);
  assert.throws(() => evaluateExpression("{{ inputs.text | contains(5) }}", ctx({ inputs: { text: "x" } })), /contains: expected a string argument/);
  // non-string arg on a list is legitimate membership
  assert.equal(evaluateExpression("{{ inputs.items | contains(5) }}", ctx({ inputs: { items: [1, 2, 5] } })), true);
});

test("filter call with trailing tokens fails loudly", () => {
  assert.throws(() => evaluateExpression("{{ inputs.missing | default('7') > '5' }}", ctx({})), /unsupported form/);
  assert.throws(() => evaluateExpression("{{ inputs.tags | join(',') extra }}", ctx({ inputs: { tags: ["a", "b"] } })), /unsupported form/);
});

test("filter on a comparison operand is refused (ambiguous precedence)", () => {
  const c = ctx({ inputs: { count: 10, name: "x" } });
  assert.throws(() => evaluateExpression("{{ inputs.count > inputs.limit | default(5) }}", c), /ambiguous filter precedence/);
  assert.throws(() => evaluateExpression('{{ inputs.name == inputs.other | default("x") }}', c), /ambiguous filter precedence/);
  assert.throws(() => evaluateExpression("{{ inputs.a and inputs.b | default(1) }}", c), /ambiguous filter precedence/);
});

test("filter after a unary not is refused", () => {
  assert.throws(
    () => evaluateExpression("{{ not inputs.missing | default(1) }}", ctx({})),
    /ambiguous filter precedence/,
  );
});

test("chained filters apply left-to-right; error in later link raises", () => {
  const c = ctx({ inputs: { rows: [{ name: "a" }, { name: "b" }] } });
  assert.equal(evaluateExpression("{{ inputs.rows | map('name') | join(',') }}", c), "a,b");
  assert.throws(() => evaluateExpression("{{ inputs.rows | map('name') | bogus }}", c), /unknown filter 'bogus'/);
});

test("condition strips captured command output; whitespace-only stays truthy", () => {
  assert.equal(evaluateCondition("{{ steps.check.output.stdout }}", ctx({ steps: { check: { output: { stdout: "false\n" } } } })), false);
  for (const raw of ["false\n", "false\r\n", " false", "false ", "FALSE\n"]) {
    assert.equal(evaluateCondition(raw, ctx()), false, raw);
  }
  for (const raw of ["true\n", " true ", "TRUE\r\n"]) {
    assert.equal(evaluateCondition(raw, ctx()), true, raw);
  }
  // only the keyword special case is stripped
  assert.equal(evaluateCondition("   ", ctx()), true);
  assert.equal(evaluateCondition("falsey", ctx()), true);
});

test("context.run_id string interpolation and default", () => {
  assert.equal(evaluateExpression("run {{ context.run_id }}", ctx({ runId: "47c5eb4b" })), "run 47c5eb4b");
  assert.equal(evaluateExpression("{{ context.run_id }}", ctx({ runId: null })), "");
});

// ── TestGateStep (ported, non-TTY paths) ─────────────────────────────────

const GATE_CONFIG = {
  id: "review",
  type: "gate",
  message: "Review the spec.",
  options: ["approve", "reject"],
  on_reject: "abort",
  verdict_input: "spec_verdict",
};

test("gate: non-TTY pauses with structured output", async () => {
  const step = new GateStep();
  const result = await step.execute(GATE_CONFIG, ctx({ inputs: {} }));
  assert.equal(result.status, StepStatus.PAUSED);
  assert.equal(result.output.message, "Review the spec.");
  assert.deepEqual(result.output.options, ["approve", "reject"]);
  assert.equal(result.output.choice, null);
});

test("gate: missing/empty verdict input keeps pause behavior", async () => {
  const step = new GateStep();
  for (const inputs of [{}, { spec_verdict: "" }]) {
    const result = await step.execute(GATE_CONFIG, ctx({ inputs }));
    assert.equal(result.status, StepStatus.PAUSED);
    assert.equal(result.output.choice, null);
  }
});

test("gate: verdict input uses canonical option spelling", async () => {
  const step = new GateStep();
  const result = await step.execute(
    { ...GATE_CONFIG, options: ["Approve", "Reject"] },
    ctx({ inputs: { spec_verdict: "approve" } }),
  );
  assert.equal(result.status, StepStatus.COMPLETED);
  assert.equal(result.output.choice, "Approve"); // canonical spelling, not the raw input
});

test("gate: invalid verdict input value fails with named error", async () => {
  const step = new GateStep();
  for (const [value, fragment] of [["bogus", "does not match any configured option"], [5, "must be a string"]]) {
    const result = await step.execute(GATE_CONFIG, ctx({ inputs: { spec_verdict: value } }));
    assert.equal(result.status, StepStatus.FAILED, String(value));
    assert.ok(result.error.includes(fragment), `${result.error} =~ ${fragment}`);
  }
});

test("gate: verdict_input fails inside fan-out context", async () => {
  const step = new GateStep();
  const result = await step.execute(GATE_CONFIG, ctx({ inputs: { spec_verdict: "approve" }, insideFanOut: true }));
  assert.equal(result.status, StepStatus.FAILED);
  assert.ok(result.error.includes("'verdict_input' is not supported inside fan-out"));
});

test("gate: failed gate persists error in step results", async () => {
  // Upstream test_command variant: a malformed verdict value (number, not
  // string) fails the gate at coercion — run FAILED (not aborted: the gate
  // never reached a choice), step result carries the error.
  const dir = mkdtempSync(join(tmpdir(), "gate-persist-"));
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: gate-fail-wf
  name: GF
  version: "1.0.0"
inputs:
  spec_verdict:
    type: number
    default: 42
steps:
  - id: review
    type: gate
    message: "Review the spec."
    options: [approve, reject]
    on_reject: abort
    verdict_input: spec_verdict
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    const stepData = state.stepResults.review;
    assert.equal(stepData.status, "failed");
    assert.ok((stepData.error ?? "").includes("must be a string"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate: reject with verdict_input preserves each on_reject behavior", async () => {
  const step = new GateStep();
  const cases = [
    ["abort", "failed", true],
    ["skip", "completed", false],
    ["retry", "paused", false],
  ];
  for (const [onReject, expectedStatus, aborted] of cases) {
    const context = ctx({ inputs: { spec_verdict: "reject" } });
    const result = await step.execute({ ...GATE_CONFIG, on_reject: onReject }, context);
    assert.equal(result.status, expectedStatus, onReject);
    assert.equal(result.output.aborted ?? false, aborted, onReject);
    // retry resets the bound input to "" so the next resume re-asks
    assert.equal(context.inputs.spec_verdict, onReject === "retry" ? "" : "reject", onReject);
  }
});

test("gate: invalid on_reject values fail loudly, never silently complete", async () => {
  const step = new GateStep();
  for (const bad of ["Abort", "fail", "stop", "SKIP", null, 5, ["abort"]]) {
    const result = await step.execute({ ...GATE_CONFIG, on_reject: bad }, ctx({ inputs: { spec_verdict: "reject" } }));
    assert.equal(result.status, StepStatus.FAILED, JSON.stringify(bad));
    assert.ok(result.error.includes("'on_reject' must be"), JSON.stringify(bad));
  }
});

test("gate: validate rejects non-string options without raising", () => {
  const step = new GateStep();
  for (const bad of [5, ["a", 5], "options"]) {
    const errors = step.validate({ ...GATE_CONFIG, options: bad });
    assert.ok(errors.length > 0, JSON.stringify(bad));
    assert.ok(errors.every((e) => typeof e === "string"), JSON.stringify(bad));
  }
});

test("gate: engine abort is case-insensitive on reject", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-case-"));
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: gate-case-wf
  name: GC
  version: "1.0.0"
inputs:
  verdict: {type: string}
steps:
  - id: review
    type: gate
    message: "Review"
    options: [Approve, Reject]
    on_reject: abort
    verdict_input: verdict
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), { verdict: "Reject" }, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.ABORTED); // case-insensitive reject matched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TestContinueOnError (ported) ─────────────────────────────────────────

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "coe-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("continue_on_error: gate abort still halts (not overridden)", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: coe-gate-abort
  name: CGA
  version: "1.0.0"
inputs:
  verdict: {type: string}
steps:
  - id: review
    type: gate
    message: "Abort even with continue_on_error?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
    continue_on_error: true
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), { verdict: "reject" }, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.ABORTED);
  } finally {
    cleanup();
  }
});

test("continue_on_error: truthy non-bool is ignored by the engine", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: coe-string-true
  name: CST
  version: "1.0.0"
steps:
  - id: flaky
    type: shell
    run: "exit 1"
    continue_on_error: "true"
`);
    const engine = new WorkflowEngine(dir);
    const def = engine.loadWorkflow(wfPath);
    // Validation reports it; the engine (unvalidated path) must NOT honor it.
    assert.ok(engine.validate(def, STEP_REGISTRY).some((e) => e.includes("continue_on_error") && e.includes("boolean")));
    const state = await engine.execute(def, {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
  } finally {
    cleanup();
  }
});

test("unknown step type sets run error", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: unknown-type
  name: UT
  version: "1.0.0"
steps:
  - id: weird
    type: not-a-type
`);
    const engine = new WorkflowEngine(dir);
    // Unvalidated execute (engine does not auto-validate): unknown type sets error.
    const state = await engine.execute(WorkflowDefinition.fromString(
      (await import("node:fs")).readFileSync(wfPath, "utf-8").replace("not-a-type", "not-a-type"),
    ), {}, null, { ...STEP_REGISTRY });
    assert.equal(state.status, RunStatus.FAILED);
    assert.ok((state.error ?? "").includes("Unknown step type"));
  } finally {
    cleanup();
  }
});

// ── TestRunState (ported) ────────────────────────────────────────────────

test("RunState: save and load round-trip", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const state = new RunState({ runId: "abc123", workflowId: "wf-x", projectRoot: dir });
    state.status = RunStatus.PAUSED;
    state.currentStepIndex = 2;
    state.currentStepId = "review";
    state.recordStepResult("a", { type: "shell", status: "completed", output: {} });
    await state.save();

    const loaded = RunState.load("abc123", dir);
    assert.equal(loaded.runId, "abc123");
    assert.equal(loaded.status, RunStatus.PAUSED);
    assert.equal(loaded.currentStepIndex, 2);
    assert.equal(loaded.currentStepId, "review");
    assert.ok("a" in loaded.stepResults);
  } finally {
    cleanup();
  }
});

test("RunState: load rejects run_id mismatch, not-found, bad index", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const state = new RunState({ runId: "aaa111", workflowId: "wf-x", projectRoot: dir });
    await state.save();
    assert.throws(() => RunState.load("nope999", dir), /Run state not found/);

    // Tampered state: mismatched run_id.
    const statePath = join(dir, ".adlc", "workflows", "runs", "aaa111", "state.json");
    const raw = JSON.parse(readFileSync(statePath, "utf-8"));
    raw.run_id = "zzz999";
    writeFileSync(statePath, JSON.stringify(raw));
    assert.throws(() => RunState.load("aaa111", dir), /does not match requested run_id/);

    // Tampered index.
    const raw2 = JSON.parse(readFileSync(statePath, "utf-8"));
    raw2.run_id = "aaa111";
    raw2.current_step_index = -1;
    writeFileSync(statePath, JSON.stringify(raw2));
    assert.throws(() => RunState.load("aaa111", dir), /non-negative integer/);
  } finally {
    cleanup();
  }
});

test("RunState: rejects path traversal in run_id", () => {
  const { dir, cleanup } = makeProject();
  try {
    // load() validates before path interpolation — malicious IDs throw.
    for (const malicious of ["../escape", "..\\escape", "a/b", "a;b", "-flag", "", null, 5]) {
      assert.throws(() => RunState.load(malicious, dir), /Invalid run_id/, JSON.stringify(malicious));
    }
    // Constructor: malformed explicit IDs throw; null auto-generates (API).
    for (const bad of ["../escape", "a/b", "-flag", "", 5]) {
      assert.throws(() => new RunState({ runId: bad }), /Invalid run_id/, JSON.stringify(bad));
    }
    const auto = new RunState({ runId: null, workflowId: "wf", projectRoot: dir });
    assert.match(auto.runId, /^[0-9a-f]{8}$/);
  } finally {
    cleanup();
  }
});

test("RunState: error persists across save/load; resume clears stale error", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    // Fails on the first execution (creates the marker), succeeds on resume.
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: err-wf
  name: E
  version: "1.0.0"
steps:
  - id: flaky
    type: shell
    run: "test -f marker && exit 0 || (touch marker && exit 3)"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), {}, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.ok((state.error ?? "").includes("code 3"));

    const loaded = RunState.load(state.runId, dir);
    assert.ok((loaded.error ?? "").includes("code 3"));

    // Resume: the command now succeeds; stale error cleared, run completes.
    const resumed = await engine.resume(state.runId, null, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.equal(resumed.error, null);
  } finally {
    cleanup();
  }
});

// ── TestResumeWithInputs (ported) ────────────────────────────────────────

test("resume with input re-runs step with new value", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: resume-cmd-wf
  name: RC
  version: "1.0.0"
inputs:
  cmd: {type: string}
steps:
  - id: doit
    type: shell
    run: "{{ inputs.cmd }}"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), { cmd: "exit 1" }, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    const resumed = await engine.resume(state.runId, { cmd: "exit 0" }, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.equal(resumed.inputs.cmd, "exit 0");
  } finally {
    cleanup();
  }
});

test("resume without input preserves inputs", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: resume-preserve-wf
  name: RP
  version: "1.0.0"
inputs:
  cmd: {type: string}
steps:
  - id: doit
    type: shell
    run: "{{ inputs.cmd }}"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), { cmd: "exit 1" }, null, STEP_REGISTRY);
    const resumed = await engine.resume(state.runId, null, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.FAILED); // still "exit 1"
    assert.equal(resumed.inputs.cmd, "exit 1");
  } finally {
    cleanup();
  }
});

test("resume merges and coerces typed input", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const wfPath = join(dir, "wf.yml");
    writeFileSync(wfPath, `
schema_version: "1.0"
workflow:
  id: resume-coerce-wf
  name: RCO
  version: "1.0.0"
inputs:
  count:
    type: number
  verdict:
    type: string
steps:
  - id: review
    type: gate
    message: "Waiting"
    options: [approve, reject]
    verdict_input: verdict
  - id: report
    type: shell
    run: "echo count={{ inputs.count }}"
`);
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wfPath), { count: "3", verdict: "" }, null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    const resumed = await engine.resume(state.runId, { count: "5", verdict: "approve" }, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.equal(resumed.inputs.count, 5); // "5" coerced string → number
    // inputs.json on disk carries the coerced value
    const inputsFile = JSON.parse(readFileSync(join(dir, ".adlc", "workflows", "runs", resumed.runId, "inputs.json"), "utf-8"));
    assert.equal(inputsFile.inputs.count, 5);
    assert.match(resumed.stepResults.report.output.stdout, /count=5/);
  } finally {
    cleanup();
  }
});

// ── TestGateVerdictInputValidation (ported, engine-level) ────────────────

test("gate verdict_input validation: undeclared input, retry/enum interplay", () => {
  const dir = mkdtempSync(join(tmpdir(), "verdict-val-"));
  try {
    const base = `
schema_version: "1.0"
workflow:
  id: verdict-val
  name: VV
  version: "1.0.0"
inputs:
  verdict:
    type: string
    enum: [approve, reject]
steps:
  - id: review
    type: gate
    message: "m"
    options: [approve, reject]
    on_reject: retry
    verdict_input: verdict
`;
    // retry resets verdict to "" — enum must allow ""
    const errors = validateWorkflow(WorkflowDefinition.fromString(base), STEP_REGISTRY);
    assert.ok(errors.some((e) => e.includes("enum") && e.includes("''")), errors.join("; "));

    // Undeclared verdict input reference.
    const bad = base.replace("verdict_input: verdict", "verdict_input: nonexistent");
    const errors2 = validateWorkflow(WorkflowDefinition.fromString(bad), STEP_REGISTRY);
    assert.ok(errors2.some((e) => e.includes("undeclared input")), errors2.join("; "));

    // Enum admitting "" validates clean.
    const good = base.replace("enum: [approve, reject]", "enum: ['', approve, reject]");
    assert.deepEqual(validateWorkflow(WorkflowDefinition.fromString(good), STEP_REGISTRY), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── TestStepRegistry (ported) ────────────────────────────────────────────

test("registry: all builtin step types registered; lookup works", () => {  const expected = [
    "command", "do-while", "fan-in", "fan-out", "gate", "if",
    "prompt", "shell", "slot", "switch", "while",
  ];
  for (const key of expected) {
    assert.ok(key in STEP_REGISTRY, key);
    assert.equal(getStepType(key).typeKey, key);
  }
  assert.equal(getStepType("nope"), null);
  // init + catalog are deliberately NOT ported (ADR-390)
  assert.ok(!("init" in STEP_REGISTRY));
});

// ── TestWorkflowValidation (ported, selected) ────────────────────────────

test("validation: requires block rejects unknown keys and permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "requires-"));
  try {
    const mk = (requires) => `
schema_version: "1.0"
workflow:
  id: req-wf
  name: R
  version: "1.0.0"
requires: ${requires}
steps:
  - id: a
    type: shell
    run: "true"
`;
    let errors = validateWorkflow(WorkflowDefinition.fromString(mk("{permissions: {}}")), STEP_REGISTRY);
    assert.ok(errors.some((e) => e.includes("requires.permissions") && e.includes("gate")));

    errors = validateWorkflow(WorkflowDefinition.fromString(mk("{bogus_key: 1}")), STEP_REGISTRY);
    assert.ok(errors.some((e) => e.includes("Unknown 'requires' key")));

    assert.deepEqual(validateWorkflow(WorkflowDefinition.fromString(mk("{speckit_version: '1.0'}")), STEP_REGISTRY), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation: step id with ':' rejected (reserved for nested ids)", () => {
  const errors = validateWorkflow(WorkflowDefinition.fromString(`
schema_version: "1.0"
workflow:
  id: colon-wf
  name: C
  version: "1.0.0"
steps:
  - id: parent:child
    type: shell
    run: "true"
`), STEP_REGISTRY);
  assert.ok(errors.some((e) => e.includes("contains ':'")));
});

test("validation: input default checked against enum and type", () => {
  const errors = validateWorkflow(WorkflowDefinition.fromString(`
schema_version: "1.0"
workflow:
  id: enum-def-wf
  name: ED
  version: "1.0.0"
inputs:
  mode:
    type: string
    default: bogus
    enum: [fast, slow]
  n:
    type: number
    default: not-a-number
steps:
  - id: a
    type: shell
    run: "true"
`), STEP_REGISTRY);
  assert.ok(errors.some((e) => e.includes("invalid default") && e.includes("bogus")));
  assert.ok(errors.some((e) => e.includes("expected a number")));
});

// ── Explicit-null config regression (port bug found by this parity port) ─
// Python config.get(k, default) substitutes only for ABSENT keys; an
// explicit null must reach the runtime guards and fail loudly. The JS `??`
// operator wrongly defaulted nulls — these tests pin the corrected behavior.

test("explicit null config values fail loudly, never silently default", async () => {
  const { FanOutStep } = await import("../src/factory/steps/control.mjs");
  const { IfThenStep } = await import("../src/factory/steps/control.mjs");

  // fan-out: explicit `step: null` FAILS (upstream: get() does not default it).
  let result = await new FanOutStep().execute(
    { id: "fo", type: "fan-out", items: "{{ [1] }}", step: null },
    ctx(),
  );
  assert.equal(result.status, StepStatus.FAILED);
  assert.ok(result.error.includes("'step' must be a mapping"));

  // gate: bare `on_reject:` (null) FAILS, not silently "abort".
  result = await new GateStep().execute(
    { id: "g", type: "gate", message: "m", options: ["approve", "reject"], on_reject: null },
    ctx({ inputs: {} }),
  );
  assert.equal(result.status, StepStatus.FAILED);
  assert.ok(result.error.includes("'on_reject' must be"));

  // gate: explicit null options FAIL (not defaulted to [approve, reject]).
  result = await new GateStep().execute(
    { id: "g2", type: "gate", message: "m", options: null },
    ctx({ inputs: {} }),
  );
  assert.equal(result.status, StepStatus.FAILED);
  assert.ok(result.error.includes("'options' must be a non-empty list"));

  // if: explicit null `then:` FAILS on the unvalidated path.
  result = await new IfThenStep().execute(
    { id: "iff", type: "if", condition: "true", then: null },
    ctx(),
  );
  assert.equal(result.status, StepStatus.FAILED);
  assert.ok(result.error.includes("'then' must be a list"));
});


