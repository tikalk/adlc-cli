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
  mr_url:
    type: string
    default: ""
steps:
  - id: intent-product
    type: command
    command: factory-product
  - id: gate-product
    type: gate
    message: "Approve PDRs before architecture?"
    context:
      records: [".adlc/drafts/pdr/*.md"]
      since: last_approved
      # The intent step's draft MR (ADR-444 step output, ADR-431-amendment).
      link: "{{ steps.intent-product.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: intent-architecture
    type: command
    command: factory-architect
  - id: gate-architecture
    type: gate
    message: "Approve ADRs before execution?"
    context:
      records: [".adlc/drafts/adr/*.md"]
      since: last_approved
      link: "{{ steps.intent-architecture.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: execute
    type: command
    command: factory-mission
  - id: gate-completion
    type: gate
    message: "Approve completion (ChDRs and merge request)?"
    context:
      records: [".adlc/drafts/chdr/*.md"]
      since: last_approved
      link: "{{ inputs.mr_url }}"
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
