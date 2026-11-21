// `context.on_empty: pass` — a decision gate completes by itself when there is
// nothing to approve (SF-FIX-08).
//
// Contract pinned here:
//   E1  Opt-in only. Without the key (or with `ask`) an empty list pauses, as
//       before, with the "No new or changed … decisions" message.
//   E2  With `pass`, a list that was BUILT and is EMPTY completes the gate:
//       choice "approve", auto_passed: true, no approved_sha; the run log gets
//       `gate_auto_passed` and the event stream a `gate_auto_passed` event
//       whose message is "gate <id> auto-passed: nothing to approve".
//   E3  With `pass`, a non-empty list pauses as before.
//   E4  With `pass`, a list that could NOT be built pauses as before
//       ("Decision list unavailable") — never a silent pass.
//   E5  `on_empty` is a `context` key: a gate without `context.records` cannot
//       carry it, so a gate whose subject is not a record list never passes.
//   E6  A rejection given as the verdict input is honoured even when the list
//       is empty.
//   E7  A gate that already paused with a list is never auto-passed afterwards
//       (the head-moved halt still applies).
//   E8  Validation: unknown value, and `pass` without an `approve` option.
//   E9  No bundled workflow opts in: their gates approve a plan or a merge
//       request, so an empty record list must never skip them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus, validateWorkflow } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";

const temps = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of temps) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function commitAll(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

function pdr(title) {
  return `---\nstatus: Proposed\n---\n\n# ${title}\n\n## Decision Outcome\n\nWe decide ${title}.\n`;
}

// A repo whose only commit is the base: nothing was drafted "since run start".
function repo({ draft = false } = {}) {
  const dir = tempDir("gate-empty-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, ".gitignore", ".adlc/workflows/\n");
  write(dir, "README.md", "base\n");
  commitAll(dir, "base");
  return { dir, draft };
}

function gate({ onEmpty, options = "[approve, reject]", onReject = "abort", context = true } = {}) {
  const ctx = context
    ? `    context:
      records: ["${PDR_GLOB}"]
      since: last_approved
${onEmpty === undefined ? "" : `      on_empty: ${onEmpty}\n`}`
    : "";
  return `  - id: gate-product
    type: gate
    message: "Approve PDRs before architecture?"
    options: ${options}
    on_reject: ${onReject}
    verdict_input: verdict
${ctx}`;
}

// The step before the gate: a planning step that drafts (or does not draft) a record.
const PLAN_NOTHING = `  - id: plan
    type: shell
    run: "echo planned nothing"
`;
const NEXT = `  - id: execute
    type: shell
    run: "echo executed"
`;

function workflow(stepsYaml) {
  const path = join(tempDir("gate-empty-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: empty-gate
  name: Empty gate
  version: "1.0.0"
inputs:
  verdict: {type: string, default: ""}
steps:
${stepsYaml}`, "utf-8");
  return path;
}

async function run(dir, stepsYaml, runId, inputs = {}) {
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const state = await engine.execute(engine.loadWorkflow(workflow(stepsYaml)), inputs, runId, STEP_REGISTRY);
  return { engine, events, state };
}

async function resume(dir, runId, inputs) {
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const state = await engine.resume(runId, inputs, STEP_REGISTRY);
  return { events, state };
}

function log(dir, runId) {
  return readFileSync(join(dir, ".adlc", "workflows", "runs", runId, "log.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ── E1: default is unchanged ──────────────────────────────────────────────

for (const [name, onEmpty] of [["no on_empty key", undefined], ["on_empty: ask", "ask"]]) {
  test(`E1: an empty list still pauses with ${name}`, async () => {
    const { dir } = repo();
    const { state, events } = await run(dir, PLAN_NOTHING + gate({ onEmpty }) + NEXT, "e1");
    assert.equal(state.status, RunStatus.PAUSED);
    assert.equal(state.currentStepId, "gate-product");
    const out = state.stepResults["gate-product"].output;
    assert.equal(out.no_changes, true);
    assert.match(out.message, /No new or changed product decisions since/);
    assert.equal(out.auto_passed, undefined);
    assert.equal(events.some((e) => e.type === "gate_auto_passed"), false);
    assert.equal(state.stepResults.execute, undefined);
  });
}

// ── E2: built and empty → the gate passes by itself ───────────────────────

test("E2: on_empty: pass completes the gate when the list was built and is empty", async () => {
  const { dir } = repo();
  const { state, events } = await run(dir, PLAN_NOTHING + gate({ onEmpty: "pass" }) + NEXT, "e2");
  assert.equal(state.status, RunStatus.COMPLETED);
  const g = state.stepResults["gate-product"];
  assert.equal(g.status, StepStatus.COMPLETED);
  assert.equal(g.output.choice, "approve");
  assert.equal(g.output.auto_passed, true);
  assert.equal(g.output.auto_pass_reason, "nothing to approve");
  assert.equal(g.output.no_changes, true);
  assert.equal(g.output.approved_sha, undefined, "nobody approved anything: no approval is pinned");
  assert.equal(state.lastApprovedSha, null);
  assert.equal(state.stepResults.execute.status, StepStatus.COMPLETED);

  const event = events.find((e) => e.type === "gate_auto_passed");
  assert.ok(event, "the event stream says the gate was not asked");
  assert.equal(event.step_id, "gate-product");
  assert.equal(event.message, "gate gate-product auto-passed: nothing to approve");
  assert.equal(events.some((e) => e.type === "gate_paused" || e.type === "permission_request"), false, "no person was asked");
  const entries = log(dir, "e2");
  assert.ok(entries.some((e) => e.event === "gate_auto_passed" && e.step_id === "gate-product" && e.reason === "nothing to approve"));
  assert.equal(entries.some((e) => e.event === "gate_approved"), false, "an auto-pass is not recorded as an approval");
});

test("E2: the gate's own spelling of approve is used, and a preset approve verdict changes nothing", async () => {
  const { dir } = repo();
  const { state } = await run(dir, PLAN_NOTHING + gate({ onEmpty: "pass", options: "[Approve, Reject]" }) + NEXT, "e2b", { verdict: "approve" });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.stepResults["gate-product"].output.choice, "Approve");
  assert.equal(state.stepResults["gate-product"].output.auto_passed, true);
});

// ── E3: something to approve → asks, as before ────────────────────────────

test("E3: on_empty: pass still pauses when a record was drafted", async () => {
  const { dir } = repo();
  const plan = `  - id: plan
    type: shell
    run: "echo planned"
`;
  // Drafted and committed after the run's base, as a planning step would.
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const def = engine.loadWorkflow(workflow(plan + gate({ onEmpty: "pass" }) + NEXT));
  // The record lands between run start and the gate: commit it from a hook on step start.
  engine.onStepStart = (stepId) => {
    if (stepId === "gate-product") {
      write(dir, ".adlc/drafts/pdr/PDR-001.md", pdr("Billing tiers"));
      commitAll(dir, "draft PDR-001");
    }
  };
  const state = await engine.execute(def, {}, "e3", STEP_REGISTRY);
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults["gate-product"].output;
  assert.equal(out.no_changes, false);
  assert.equal(out.decisions.length, 1);
  assert.equal(out.auto_passed, undefined);
  assert.ok(events.some((e) => e.type === "gate_paused"));
  assert.equal(events.some((e) => e.type === "gate_auto_passed"), false);
  assert.equal(state.stepResults.execute, undefined);
});

// ── E4: list unavailable → asks, never a silent pass ──────────────────────

test("E4: on_empty: pass still pauses when the list could not be built", async () => {
  // Not a git repository: the manifest reports "Decision list unavailable".
  const dir = tempDir("gate-empty-norepo-");
  const { state, events } = await run(dir, PLAN_NOTHING + gate({ onEmpty: "pass" }) + NEXT, "e4");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults["gate-product"].output;
  assert.match(out.message, /Decision list unavailable/);
  assert.equal(out.no_changes, false);
  assert.equal(out.auto_passed, undefined);
  assert.equal(events.some((e) => e.type === "gate_auto_passed"), false);
  assert.equal(state.stepResults.execute, undefined);
});

// ── E5: only a gate with context.records can carry it ─────────────────────

test("E5: a gate without context never auto-passes, and on_empty outside context is not a gate option", async () => {
  const { dir } = repo();
  const plain = gate({ context: false });
  const { state } = await run(dir, PLAN_NOTHING + plain + NEXT, "e5");
  assert.equal(state.status, RunStatus.PAUSED, "a gate whose subject is not a record list always asks");
  assert.equal(state.stepResults["gate-product"].output.auto_passed, undefined);

  // `on_empty` without `records` is a validation error: the list is what makes "empty" mean something.
  const engine = new WorkflowEngine(dir);
  const noRecords = `  - id: gate-completion
    type: gate
    message: "Approve the result?"
    options: [approve, reject]
    verdict_input: verdict
    context:
      on_empty: pass
`;
  const errors = validateWorkflow(engine.loadWorkflow(workflow(noRecords)), STEP_REGISTRY).join(" ");
  assert.match(errors, /'context\.records' must be a non-empty list of glob strings/);
  const run2 = await run(dir, noRecords + NEXT, "e5b");
  assert.equal(run2.state.status, RunStatus.FAILED, "and it fails at run time rather than passing");
  assert.equal(run2.state.stepResults.execute, undefined);
});

// ── E6: a rejection is honoured ───────────────────────────────────────────

test("E6: a reject verdict is honoured even when the list is empty", async () => {
  const { dir } = repo();
  const { state, events } = await run(dir, PLAN_NOTHING + gate({ onEmpty: "pass" }) + NEXT, "e6", { verdict: "reject" });
  assert.equal(state.status, RunStatus.ABORTED);
  assert.equal(state.stepResults["gate-product"].output.choice, "reject");
  assert.equal(state.stepResults["gate-product"].output.auto_passed, undefined);
  assert.equal(events.some((e) => e.type === "gate_auto_passed"), false);
  assert.equal(state.stepResults.execute, undefined);
});

// ── E7: a gate that already showed a list is never auto-passed ────────────

test("E7: after a pause with a list, a moved head still halts; the gate is not auto-passed", async () => {
  const { dir } = repo();
  const engine = new WorkflowEngine(dir);
  const def = engine.loadWorkflow(workflow(PLAN_NOTHING + gate({ onEmpty: "pass" }) + NEXT));
  engine.onStepStart = (stepId) => {
    if (stepId === "gate-product") {
      write(dir, ".adlc/drafts/pdr/PDR-001.md", pdr("Billing tiers"));
      commitAll(dir, "draft PDR-001");
    }
  };
  const paused = await engine.execute(def, {}, "e7", STEP_REGISTRY);
  assert.equal(paused.status, RunStatus.PAUSED);
  // The draft is removed again outside the run: the list at the new HEAD is empty.
  git(dir, "rm", "-q", ".adlc/drafts/pdr/PDR-001.md");
  git(dir, "commit", "-q", "-m", "drop the draft");
  const { state } = await resume(dir, "e7", { verdict: "approve" });
  assert.equal(state.status, RunStatus.FAILED);
  assert.match(state.error, /head moved since the gate paused/);
  assert.equal(state.stepResults["gate-product"].output.auto_passed, undefined);
});

// ── E8: validation ────────────────────────────────────────────────────────

test("E8: on_empty accepts only ask or pass, and pass needs an approve option", () => {
  const { dir } = repo();
  const engine = new WorkflowEngine(dir);
  const errorsFor = (stepsYaml) => validateWorkflow(engine.loadWorkflow(workflow(stepsYaml)), STEP_REGISTRY).join(" ");
  assert.equal(errorsFor(gate({ onEmpty: "pass" })), "");
  assert.equal(errorsFor(gate({ onEmpty: "ask" })), "");
  assert.match(errorsFor(gate({ onEmpty: "skip" })), /'context\.on_empty' must be one of ask, pass, got "skip"/);
  assert.match(errorsFor(gate({ onEmpty: "true" })), /'context\.on_empty' must be one of ask, pass/);
  assert.match(
    errorsFor(gate({ onEmpty: "pass", options: "[yes, reject]" })),
    /'context\.on_empty: pass' needs an 'approve' option to complete with/,
  );
});

// ── E9: the bundled workflows do not opt in ───────────────────────────────

test("E9: no bundled workflow sets on_empty (their gates approve a plan or a merge request)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "workflows");
  const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf-8"));
  const paths = Object.values(catalog.workflows).map((w) => join(root, "..", w.path));
  assert.ok(paths.length >= 3, "fixture: the bundled workflows were found");
  for (const path of paths) {
    assert.doesNotMatch(readFileSync(path, "utf-8"), /on_empty/, `${path} must not auto-pass a gate`);
  }
});
