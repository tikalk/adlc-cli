// YAML subset parser tests for factory workflow files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml } from "../src/workflow/yaml.mjs";

test("workflow-shaped document parses fully", () => {
  const doc = parseYaml(`
schema_version: "1.0"
workflow:
  id: feature-squad
  name: Feature Squad
  version: "1.0.0"
inputs:
  spec:
    type: string
    required: true
steps:
  - id: analyze
    type: prompt
    prompt: |
      Analyze {{ inputs.spec }}.
    integration: opencode
  - id: review
    type: gate
    message: "Review before merge"
    options: [approve, request-changes]
    on_reject: abort
  - id: collect
    type: fan-in
    wait_for: [analyze]
    output: {}
`);
  assert.equal(doc.schema_version, "1.0");
  assert.equal(doc.workflow.id, "feature-squad");
  assert.equal(doc.workflow.version, "1.0.0");
  assert.equal(doc.inputs.spec.type, "string");
  assert.equal(doc.inputs.spec.required, true);
  assert.equal(doc.steps.length, 3);
  assert.equal(doc.steps[0].type, "prompt");
  // Literal block scalar keeps the trailing newline (YAML clip chomping).
  assert.equal(doc.steps[0].prompt, "Analyze {{ inputs.spec }}.\n");
  assert.deepEqual(doc.steps[1].options, ["approve", "request-changes"]);
  assert.deepEqual(doc.steps[2].wait_for, ["analyze"]);
});

test("nested mapping under list item", () => {
  const doc = parseYaml(`
steps:
  - id: run-tests
    type: shell
    input:
      args: "{{ inputs.spec }}"
      deep:
        nested: true
`);
  assert.equal(doc.steps[0].input.deep.nested, true);
});

test("flow mapping", () => {
  const doc = parseYaml(`
steps:
  - id: a
    input: {args: "hello", count: 3}
`);
  assert.deepEqual(doc.steps[0].input, { args: "hello", count: 3 });
});

test("block scalars: literal and folded", () => {
  const doc = parseYaml(`
a: |
  line one
  line two
b: >
  folded one
  folded two
`);
  assert.equal(doc.a, "line one\nline two\n");
  assert.equal(doc.b, "folded one folded two\n");
});

test("block scalar chomped", () => {
  const doc = parseYaml(`
a: |-
  no trailing newline
`);
  assert.equal(doc.a, "no trailing newline");
});

test("comments and blank lines ignored", () => {
  const doc = parseYaml(`
# top comment
key: value # trailing comment
# another

other: 2
`);
  assert.equal(doc.key, "value");
  assert.equal(doc.other, 2);
});

test("quoted strings with escapes", () => {
  const doc = parseYaml(`
a: "line\\nbreak"
b: 'it''s'
c: "hash # inside quotes"
`);
  assert.equal(doc.a, "line\nbreak");
  assert.equal(doc.b, "it's");
  assert.equal(doc.c, "hash # inside quotes");
});

test("null and booleans and numbers", () => {
  const doc = parseYaml(`
a: null
b: true
c: false
d: 42
e: 4.5
f:
`);
  assert.equal(doc.a, null);
  assert.equal(doc.b, true);
  assert.equal(doc.c, false);
  assert.equal(doc.d, 42);
  assert.equal(doc.e, 4.5);
  assert.equal(doc.f, null);
});

test("list of scalars with mixed types", () => {
  const doc = parseYaml(`
items:
  - one
  - 2
  - true
  - null
`);
  assert.deepEqual(doc.items, ["one", 2, true, null]);
});

test("nested lists of mappings", () => {
  const doc = parseYaml(`
outer:
  - id: first
    steps:
      - id: inner
        run: echo hi
  - id: second
`);
  assert.equal(doc.outer[0].steps[0].run, "echo hi");
  assert.equal(doc.outer[1].id, "second");
});

test("expression strings survive untouched", () => {
  const doc = parseYaml(`
run: echo "{{ steps.a.output.file }}"
condition: "{{ inputs.count > 5 }}"
`);
  assert.equal(doc.run, 'echo "{{ steps.a.output.file }}"');
  assert.equal(doc.condition, "{{ inputs.count > 5 }}");
});

test("empty doc returns null", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# only a comment\n"), null);
});
