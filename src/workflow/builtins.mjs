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
  # Set by the dispatching runtime. issue_ref becomes the agent steps'
  # ADLC_ISSUE_REF (ADR-444) and is checked on restore; undeclared inputs are
  # dropped, so both must be declared here.
  issue_ref:
    type: string
    default: ""
  dispatch:
    type: string
    default: ""
steps:
  - id: intent-product
    type: command
    command: factory-product
  - id: publish-product
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # open-mr is idempotent and opens nothing for an empty run; without the
    # helper (factory-mission skill not installed) the step is skipped.
    run: |-
      node -e "const f='.agents/skills/factory-mission/scripts/bash/open-mr.sh';if(!require('fs').existsSync(f)){console.error('publish: open-mr helper not installed, no MR');process.exit(0)}const r=require('child_process').spawnSync('bash',[f],{stdio:'inherit'});if(r.error){console.error('publish: '+r.error.message+', no MR');process.exit(0)}process.exit(r.status===null?1:r.status)"
  - id: gate-product
    type: gate
    message: "Approve PDRs before architecture?"
    context:
      records: [".adlc/drafts/pdr/*.md"]
      since: last_approved
      # The draft MR the publish step opened (ADR-444 §5, ADR-431-amendment §3a).
      link: "{{ steps.publish-product.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: intent-architecture
    type: command
    command: factory-architect
  - id: publish-architecture
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # open-mr is idempotent and opens nothing for an empty run; without the
    # helper (factory-mission skill not installed) the step is skipped.
    run: |-
      node -e "const f='.agents/skills/factory-mission/scripts/bash/open-mr.sh';if(!require('fs').existsSync(f)){console.error('publish: open-mr helper not installed, no MR');process.exit(0)}const r=require('child_process').spawnSync('bash',[f],{stdio:'inherit'});if(r.error){console.error('publish: '+r.error.message+', no MR');process.exit(0)}process.exit(r.status===null?1:r.status)"
  - id: gate-architecture
    type: gate
    message: "Approve ADRs before execution?"
    context:
      records: [".adlc/drafts/adr/*.md"]
      since: last_approved
      link: "{{ steps.publish-architecture.output.mr_url }}"
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
