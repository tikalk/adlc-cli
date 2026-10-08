// Bundled workflow definitions — curated built-ins shipped with adlc-cli
// (ADR-391-amendment: the outer loop is a workflow whose id is `factory`,
// composed of `command` steps invoking orchestrator skills plus `gate`
// checkpoints; consumed via `adlc-cli workflow run factory`).

export const BUILTIN_WORKFLOWS = {
  factory: {
    description: "Factory outer loop — product → architecture → execution → sweep, with stage gates",
    yaml: `schema_version: "1.0"
workflow:
  id: factory
  name: Factory Outer Loop
  version: "1.0.0"
inputs:
  verdict:
    type: string
    enum: ["", approve, reject]
steps:
  - id: intent-product
    type: command
    command: factory-product
  - id: gate-product
    type: gate
    message: "Product decisions drafted. Approve PDRs before architecture?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: intent-architecture
    type: command
    command: factory-architect
  - id: gate-architecture
    type: gate
    message: "Architecture decisions drafted. Approve ADRs before execution?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: execute
    type: command
    command: factory-mission
  - id: gate-completion
    type: gate
    message: "Execution converged. Approve completion?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: sweep
    type: command
    command: factory-init
`,
  },
};

export function getBuiltinWorkflow(id) {
  return BUILTIN_WORKFLOWS[id] ?? null;
}
