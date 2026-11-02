// Bundled workflow definitions — curated built-ins shipped with adlc-cli
// (ADR-391-amendment: the outer loop is a workflow whose id is `factory`,
// composed of `command` steps invoking orchestrator skills plus `gate`
// checkpoints; consumed via `adlc-cli workflow run factory`).

// Shell command for an engine step that runs the factory publish helpers in
// order. The helpers live in the factory-runbook skill (adlc-team-skills
// #121); older installs carry them in factory-mission, so each helper is
// looked up there second. A helper that is missing from both, or a bash that
// cannot start, FAILS the step: this used to be "skipped" while the step
// still completed, so a whole factory run could push nothing, open no MR and
// report success. The reason goes to stderr, which the
// engine puts in the step's error. A helper's own non-zero exit fails the
// step too (open-mr still refuses a non-intent branch).
export const HELPER_DIRS = Object.freeze([
  ".agents/skills/factory-runbook/scripts/bash",
  ".agents/skills/factory-mission/scripts/bash",
]);
function helperRun(label, names) {
  const dirs = JSON.stringify(HELPER_DIRS).replaceAll('"', "'");
  const files = JSON.stringify(names).replaceAll('"', "'");
  return `node -e "const fs=require('fs'),cp=require('child_process');const ds=${dirs};const fl=${files};` +
    `const fail=(m)=>{console.error(m);process.exit(1)};` +
    `for(const n of fl){const f=ds.map((d)=>d+'/'+n).find((p)=>fs.existsSync(p));` +
    `if(!f)fail('${label}: '+n+' not found in '+ds.join(' or ')+' (factory-runbook skill not installed)');` +
    `const r=cp.spawnSync('bash',[f],{stdio:'inherit'});if(r.error)fail('${label}: '+n+' could not start: '+r.error.message);` +
    `if(r.status!==0)process.exit(r.status===null?1:r.status)}"`;
}

export const BUILTIN_WORKFLOWS = {
  factory: {
    description: "Factory outer loop — intent (product + architecture) → execution → sweep, with stage gates",
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
    # (ADR-431-amendment §1, §3a), so agent commits land on it and a
    # re-dispatch continues the issue's branch and MR. Idempotent with the
    # orchestrator's own run-branch call; skipped without the helper.
    run: |-
      ${helperRun("run-branch", ["run-branch.sh"])}
  # Intent (ADR-435): factory-intent runs both lanes, product and
  # architecture, in one step; factory-product and factory-architect no
  # longer exist. One publish, then the two scope-pinned gates in order.
  - id: intent
    type: command
    command: factory-intent
  - id: publish-intent
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # run-branch first: an intent step that changed nothing may never have
    # left the base branch, and open-mr refuses anything but factory/intent/*.
    # open-mr is idempotent and opens nothing for an empty run.
    run: |-
      ${helperRun("publish", ["run-branch.sh", "open-mr.sh"])}
  - id: gate-product
    type: gate
    message: "Approve PDRs before architecture?"
    context:
      records: [".adlc/drafts/pdr/*.md"]
      since: last_approved
      # The draft MR the publish step opened (ADR-444 §5, ADR-431-amendment §3a).
      link: "{{ steps.publish-intent.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: gate-architecture
    type: gate
    message: "Approve ADRs before execution?"
    context:
      records: [".adlc/drafts/adr/*.md"]
      # run_start, not last_approved: the intent step wrote the ADRs before
      # gate-product was approved, so "since that approval" would list none.
      since: run_start
      link: "{{ steps.publish-intent.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: execute
    type: command
    command: factory-mission
    # The mission is the run's issue (ADR-444 §4): without it factory-mission
    # asked for one and returned, and the step counted as completed
    # (adlc-workspace#12 M9 pilot, run 84412db5). The skill also falls back to
    # ADLC_ISSUE_REF and fails the step when neither is set.
    input:
      args: "--issue {{ inputs.issue_ref }}"
  - id: gate-completion
    type: gate
    message: "Approve completion (ChDRs and merge request)?"
    context:
      records: [".adlc/drafts/chdr/*.md"]
      since: last_approved
      # The code MR factory-mission opened (its mr_url step output, ADR-444);
      # an operator-supplied mr_url input is the fallback.
      link: "{{ steps.execute.output.mr_url | default(inputs.mr_url) }}"
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
