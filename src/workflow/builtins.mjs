// Bundled workflow definitions — curated built-ins shipped with adlc-cli
// (ADR-391-amendment: the outer loop is a workflow whose id is `factory`,
// composed of `command` steps invoking orchestrator skills plus `gate`
// checkpoints; consumed via `adlc-cli workflow run factory`).

// Shell command for an engine step that runs factory-mission helper scripts
// in order. A missing helper (factory-mission skill not installed) or a bash
// that cannot start skips the step (exit 0); a helper's non-zero exit fails it.
const HELPER_DIR = ".agents/skills/factory-mission/scripts/bash";
function helperRun(label, names) {
  const files = JSON.stringify(names.map((n) => `${HELPER_DIR}/${n}`)).replaceAll('"', "'");
  return `node -e "const fs=require('fs'),cp=require('child_process');const fl=${files};` +
    `if(!fl.every((f)=>fs.existsSync(f))){console.error('${label}: factory-mission helpers not installed, skipped');process.exit(0)}` +
    `for(const f of fl){const r=cp.spawnSync('bash',[f],{stdio:'inherit'});` +
    `if(r.error){console.error('${label}: '+r.error.message+', skipped');process.exit(0)}` +
    `if(r.status!==0)process.exit(r.status===null?1:r.status)}"`;
}

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
  - id: run-branch
    type: shell
    # The engine checks out the intent run branch before any agent step
    # (ADR-431-amendment §1), so agent commits land on it and a re-dispatch
    # continues the issue's branch and MR. Idempotent with the orchestrator's
    # own run-branch call; skipped without the helper.
    run: |-
      ${helperRun("run-branch", ["run-branch.sh"])}
  - id: intent-product
    type: command
    command: factory-product
  - id: publish-product
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # run-branch first: an intent step that changed nothing may never have
    # left the base branch, and open-mr refuses anything but factory/intent/*.
    # open-mr is idempotent and opens nothing for an empty run; without the
    # helpers (factory-mission skill not installed) the step is skipped.
    run: |-
      ${helperRun("publish", ["run-branch.sh", "open-mr.sh"])}
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
    # run-branch first: an intent step that changed nothing may never have
    # left the base branch, and open-mr refuses anything but factory/intent/*.
    # open-mr is idempotent and opens nothing for an empty run; without the
    # helpers (factory-mission skill not installed) the step is skipped.
    run: |-
      ${helperRun("publish", ["run-branch.sh", "open-mr.sh"])}
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
