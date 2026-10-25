// Bundled workflow definitions — curated built-ins shipped with adlc-cli
// (ADR-391-amendment: the outer loop is a workflow whose id is `factory`,
// composed of `command` steps invoking orchestrator skills plus `gate`
// checkpoints; consumed via `adlc-cli workflow run factory`).

// Shell command for an engine step that runs factory-mission helper scripts
// in order. Each helper is checked on its own: a missing one (factory-mission
// skill not installed) or a bash that cannot start is skipped and reported as
// `skipped` in the step output (ADLC_STEP_OUTPUT) and on stdout/stderr, so a
// gate without a link is explained; a present helper's non-zero exit fails
// the step (fail-closed: open-mr still refuses a non-intent branch).
const HELPER_DIR = ".agents/skills/factory-mission/scripts/bash";
function helperRun(label, names) {
  const files = JSON.stringify(names.map((n) => `${HELPER_DIR}/${n}`)).replaceAll('"', "'");
  return `node -e "const fs=require('fs'),cp=require('child_process');const fl=${files};const miss=[];` +
    `for(const f of fl){const n=f.split('/').pop();if(!fs.existsSync(f)){miss.push(n);continue}` +
    `const r=cp.spawnSync('bash',[f],{stdio:'inherit'});if(r.error){miss.push(n+' ('+r.error.message+')');continue}` +
    `if(r.status!==0)process.exit(r.status===null?1:r.status)}` +
    `if(miss.length){const m='${label}: skipped '+miss.join(', ')+' (factory-mission helpers not installed)';` +
    `console.error(m);console.log(m);const o=process.env.ADLC_STEP_OUTPUT;` +
    `if(o){let d={};try{d=JSON.parse(fs.readFileSync(o,'utf8'))}catch(e){}d.skipped=m.slice(0,2000);fs.writeFileSync(o,JSON.stringify(d))}}"`;
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
    # (ADR-431-amendment §1, §3a), so agent commits land on it and a
    # re-dispatch continues the issue's branch and MR. Idempotent with the
    # orchestrator's own run-branch call; skipped without the helper.
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
    # open-mr is idempotent and opens nothing for an empty run; a missing
    # helper (factory-mission skill not installed) is skipped and reported.
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
  - id: run-branch-architecture
    type: shell
    # Again after the product gate: a parked run resumes after it, possibly
    # restored into a fresh clone on the base branch, and resume never re-runs
    # the first run-branch step.
    run: |-
      ${helperRun("run-branch", ["run-branch.sh"])}
  - id: intent-architecture
    type: command
    command: factory-architect
  - id: publish-architecture
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # run-branch first: an intent step that changed nothing may never have
    # left the base branch, and open-mr refuses anything but factory/intent/*.
    # open-mr is idempotent and opens nothing for an empty run; a missing
    # helper (factory-mission skill not installed) is skipped and reported.
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
