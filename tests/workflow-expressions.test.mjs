// Expression evaluator tests — ported from upstream expressions.py semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateExpression,
  evaluateCondition,
  conditionIsNeverEvaluated,
  conditionHasMalformedExpressionBlock,
  conditionIsInterpolatedToText,
} from "../src/workflow/expressions.mjs";

const ctx = (fields = {}) => ({
  inputs: { name: "auth", count: 3, ready: false, text: "hello world", tags: ["a", "b"] },
  steps: {
    specify: { output: { file: "spec.md", task_list: [{ id: 1, name: "x" }, { id: 2, name: "y" }] } },
    runtests: { output: { exit_code: 0, stdout: "ok" } },
    emit: { output: { stdout: '[{"n":1},{"n":2}]' } },
  },
  item: null,
  fanIn: {},
  runId: "deadbeef",
  workflowDir: "/w",
  ...fields,
});

test("dot-path access returns typed values", () => {
  assert.equal(evaluateExpression("{{ inputs.name }}", ctx()), "auth");
  assert.equal(evaluateExpression("{{ steps.specify.output.file }}", ctx()), "spec.md");
  assert.equal(evaluateExpression("{{ inputs.count }}", ctx()), 3);
});

test("single expression preserves type (list)", () => {
  assert.deepEqual(evaluateExpression("{{ steps.specify.output.task_list }}", ctx()), [
    { id: 1, name: "x" },
    { id: 2, name: "y" },
  ]);
});

test("mixed template returns string", () => {
  assert.equal(evaluateExpression("Processed {{ inputs.name }}!", ctx()), "Processed auth!");
});

test("multi-expression interpolates inline", () => {
  assert.equal(evaluateExpression("{{ inputs.name }} {{ inputs.count }}", ctx()), "auth 3");
});

test("comparisons", () => {
  assert.equal(evaluateExpression("{{ inputs.count > 2 }}", ctx()), true);
  assert.equal(evaluateExpression("{{ inputs.count < 2 }}", ctx()), false);
  assert.equal(evaluateExpression("{{ inputs.count == 3 }}", ctx()), true);
  assert.equal(evaluateExpression("{{ inputs.name != 'x' }}", ctx()), true);
  assert.equal(evaluateExpression("{{ inputs.count >= 3 }}", ctx()), true);
  assert.equal(evaluateExpression("{{ inputs.count <= 3 }}", ctx()), true);
  // numeric-string coercion both sides
  assert.equal(evaluateExpression("{{ '10' > '9' }}", ctx()), true);
});

test("boolean logic with precedence (or before and)", () => {
  assert.equal(evaluateExpression("{{ inputs.ready or inputs.count > 2 and inputs.count < 10 }}", ctx()), true);
  assert.equal(evaluateExpression("{{ inputs.ready and inputs.count > 2 }}", ctx()), false);
  assert.equal(evaluateExpression("{{ not inputs.ready }}", ctx()), true);
});

test("membership", () => {
  assert.equal(evaluateExpression("{{ 'a' in inputs.tags }}", ctx()), true);
  assert.equal(evaluateExpression("{{ 'z' not in inputs.tags }}", ctx()), true);
  assert.equal(evaluateExpression("{{ 'ell' in inputs.text }}", ctx()), true);
});

test("literals", () => {
  assert.equal(evaluateExpression("{{ true }}", ctx()), true);
  assert.equal(evaluateExpression("{{ false }}", ctx()), false);
  assert.equal(evaluateExpression("{{ none }}", ctx()), null);
  assert.equal(evaluateExpression("{{ 42 }}", ctx()), 42);
  assert.equal(evaluateExpression("{{ 4.5 }}", ctx()), 4.5);
  assert.deepEqual(evaluateExpression("{{ [1, 2] }}", ctx()), [1, 2]);
});

test("filters", () => {
  assert.equal(evaluateExpression("{{ inputs.missing | default('fallback') }}", ctx()), "fallback");
  assert.equal(evaluateExpression("{{ inputs.tags | join(', ') }}", ctx()), "a, b");
  assert.deepEqual(evaluateExpression("{{ steps.specify.output.task_list | map('name') }}", ctx()), ["x", "y"]);
  assert.equal(evaluateExpression("{{ inputs.text | contains('world') }}", ctx()), true);
  assert.deepEqual(evaluateExpression("{{ steps.emit.output.stdout | from_json }}", ctx()), [{ n: 1 }, { n: 2 }]);
  // filter chain: map then join
  assert.equal(
    evaluateExpression("{{ steps.specify.output.task_list | map('name') | join('-') }}", ctx()),
    "x-y",
  );
});

test("filter followed by comparison is rejected (upstream parity)", () => {
  // `count | default(0) > 5` — the comparison binds looser than the pipe;
  // upstream rejects it as an unsupported filter form rather than guessing.
  assert.throws(() => evaluateExpression("{{ inputs.missing | default(0) > 5 }}", ctx()), /unsupported form/);
});

test("unknown filter raises", () => {
  assert.throws(() => evaluateExpression("{{ inputs.name | bogus }}", ctx()), /unknown filter 'bogus'/);
});

test("registered filter in unsupported form raises", () => {
  assert.throws(() => evaluateExpression("{{ inputs.name | join }}", ctx()), /unsupported form/);
});

test("ambiguous filter precedence raises", () => {
  assert.throws(
    () => evaluateExpression("{{ inputs.count > 1 | default(5) }}", ctx()),
    /ambiguous filter precedence/,
  );
});

test("quoted pipe is not a filter separator", () => {
  assert.equal(evaluateExpression("{{ inputs.text == 'a|b' }}", ctx()), false);
});

test("literal }} inside string argument stays on typed path", () => {
  assert.equal(evaluateExpression("{{ inputs.text | contains('}}') }}", ctx()), false);
  assert.equal(evaluateExpression("{{ 'a}}b' | contains('}}') }}", ctx()), true);
});

test("indexed list access", () => {
  assert.deepEqual(evaluateExpression("{{ steps.specify.output.task_list[0] }}", ctx()), { id: 1, name: "x" });
  assert.equal(evaluateExpression("{{ steps.specify.output.task_list[1].name }}", ctx()), "y");
  assert.equal(evaluateExpression("{{ steps.specify.output.task_list[9] }}", ctx()), null);
});

test("context namespace", () => {
  assert.equal(evaluateExpression("{{ context.run_id }}", ctx()), "deadbeef");
  assert.equal(evaluateExpression("{{ context.workflow_dir }}", ctx()), "/w");
});

test("item namespace inside fan-out", () => {
  const c = ctx({ item: { name: "task-1" } });
  assert.equal(evaluateExpression("{{ item.name }}", c), "task-1");
});

test("fan_in namespace", () => {
  const c = ctx({ fanIn: { results: [{ r: 1 }, { r: 2 }] } });
  assert.equal(evaluateExpression("{{ fan_in.results | map('r') | join(',') }}", c), "1,2");
});

test("evaluateCondition: strip + keyword coercion", () => {
  assert.equal(evaluateCondition("false\n", ctx()), false); // captured stdout with newline
  assert.equal(evaluateCondition("true", ctx()), true);
  assert.equal(evaluateCondition("{{ inputs.count > 100 }}", ctx()), false);
  assert.equal(evaluateCondition("{{ inputs.count > 2 }}", ctx()), true);
  // non-boolean text is truthy
  assert.equal(evaluateCondition("hello", ctx()), true);
});

test("condition authoring validators", () => {
  // never evaluated: no braces
  assert.equal(conditionIsNeverEvaluated("inputs.count > 100"), true);
  assert.equal(conditionIsNeverEvaluated("{{ inputs.count > 100 }}"), false);
  assert.equal(conditionIsNeverEvaluated("true"), false);
  assert.equal(conditionIsNeverEvaluated(""), false);
  assert.equal(conditionIsNeverEvaluated("   "), true);
  // unterminated {{ with no }} → verbatim → never evaluated → true
  assert.equal(conditionIsNeverEvaluated("{{ inputs.ready and {{ inputs.x"), true);
  // malformed: quote swallows close, raw }} later → evaluated
  assert.equal(conditionHasMalformedExpressionBlock("{{ inputs.missing | default('oops }}"), true);
  // interpolated-to-text: braces present but don't cover whole condition
  assert.equal(conditionIsInterpolatedToText("{{ inputs.ready }} and {{ inputs.count > 100 }}"), true);
  assert.equal(conditionIsInterpolatedToText("{{ inputs.count }} > 100"), true);
  assert.equal(conditionIsInterpolatedToText("{{ inputs.count > 100 }}"), false);
});

test("safe membership: non-iterable right operand is false, not a crash", () => {
  assert.equal(evaluateExpression("{{ 'x' in inputs.count }}", ctx()), false);
});

test("unresolvable path returns null", () => {
  assert.equal(evaluateExpression("{{ inputs.nope.deep.deeper }}", ctx()), null);
});
