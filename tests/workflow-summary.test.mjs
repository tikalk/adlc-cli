// End-of-run summary (adlc-workspace#66).
//
// Contract pinned here:
//   S1  `workflow summary <run_id>` renders completed, failed and aborted runs
//       from their run files (golden texts below); `--json` prints the same
//       data as one object with `text`. A missing run exits 1.
//   S2  A gate that takes its verdict from an input records who answered it
//       (`answered_by`, from ADLC_ANSWERED_BY; a plain id only) and the
//       summary shows it.
//   S3  Every MR/PR link of every step (mr_url, mr_urls) is listed once; the
//       execute step's conclusion wins over earlier ones; a failed run names
//       its failing step and error.
//   S4  Step text is redacted, one line and capped; the whole text fits one
//       chat message (SUMMARY_MAX_CHARS).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRunSummary, SUMMARY_MAX_CHARS } from "../src/workflow/summary.mjs";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";

const POSIX = process.platform !== "win32";
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "adlc-cli.mjs");
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

// The run copy of the definition (runs/<id>/workflow.yml) is what the engine
// executes and resumes from; the summary takes its gate ids from it. `defined`
// overrides the step types written there (default: the logged ones).
function writeDefinition(dir, defined) {
  const lines = ['schema_version: "1.0"', "workflow:", "  id: w", "  name: W", '  version: "1.0.0"', "steps:"];
  for (const [id, type] of defined) {
    lines.push(`  - id: ${id}`);
    if (type) lines.push(`    type: ${type}`);
    if (type === "gate") lines.push('    message: "?"', "    options: [approve, reject]");
    if (type === "shell") lines.push("    run: \"true\"");
    if (type === "command" || !type) lines.push("    command: x");
  }
  writeFileSync(join(dir, "workflow.yml"), lines.join("\n") + "\n");
}

function writeRun(root, runId, { state, inputs = {}, steps = [], resumes = 0, defined = steps, definition = true }) {
  const dir = join(root, ".adlc", "workflows", "runs", runId);
  mkdirSync(join(dir, "trace"), { recursive: true });
  if (definition) writeDefinition(dir, defined.filter(([id], i, a) => a.findIndex(([j]) => j === id) === i));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ run_id: runId, ...state }));
  writeFileSync(join(dir, "inputs.json"), JSON.stringify({ inputs }));
  const log = [];
  for (let i = 0; i < resumes; i++) log.push(JSON.stringify({ event: "workflow_finished", status: "paused" }));
  for (const [id, type] of steps) log.push(JSON.stringify({ event: "step_started", step_id: id, type }));
  log.push(JSON.stringify({ event: "workflow_finished", status: state.status }));
  writeFileSync(join(dir, "log.jsonl"), log.join("\n") + "\n");
  return dir;
}

const LANE_STEPS = [["run-branch", "shell"], ["plan", "command"], ["publish-spec", "shell"], ["spec-approval", "if"], ["gate-spec", "gate"], ["run-branch-execute", "shell"], ["execute", "command"]];
const INPUTS = { issue_ref: "g/adlc-workspace#174", dispatch: "supervised", run_id: "a4b7d251" };

function completedRun(root) {
  return writeRun(root, "93cd560c", {
    inputs: INPUTS, steps: LANE_STEPS, resumes: 1,
    state: {
      workflow_id: "factory-lane", status: "completed",
      created_at: "2026-11-23T08:00:00.000Z", updated_at: "2026-11-23T08:16:42.000Z",
      step_results: {
        "run-branch": { status: "completed", output: {} },
        plan: { status: "completed", output: { conclusion: "plan-ready" } },
        "publish-spec": { status: "completed", output: {} },
        "spec-approval": { status: "completed", output: {} },
        "gate-spec": { status: "completed", output: { choice: "approve", answered_by: "U03T2SB0B" } },
        "run-branch-execute": { status: "completed", output: {} },
        execute: { status: "completed", output: { conclusion: "Drill done: draft PR open", mr_url: "https://github.com/g/adlc-team-skills/pull/198" } },
      },
    },
  });
}

function failedRun(root) {
  return writeRun(root, "56d27c13", {
    inputs: { ...INPUTS, issue_ref: "g/adlc-workspace#181" }, steps: LANE_STEPS.slice(0, 2),
    state: {
      workflow_id: "factory-lane", status: "failed", error: "Agent step 'plan': blocked: dependency-gate on #66",
      created_at: "2026-11-23T13:46:20.000Z", updated_at: "2026-11-23T13:52:30.000Z",
      step_results: {
        "run-branch": { status: "completed", output: {} },
        plan: { status: "failed", error: "Agent step 'plan': blocked: dependency-gate on #66", output: { conclusion: "blocked: dependency-gate on #66" } },
      },
    },
  });
}

function abortedRun(root) {
  return writeRun(root, "7edcedf2", {
    inputs: { ...INPUTS, issue_ref: "g/adlc-workspace#172" }, steps: LANE_STEPS.slice(0, 5), resumes: 1,
    state: {
      workflow_id: "factory-lane", status: "aborted", error: "Gate rejected by user at step 'gate-spec'",
      created_at: "2026-11-22T16:00:00.000Z", updated_at: "2026-11-22T16:00:45.000Z",
      step_results: {
        "run-branch": { status: "completed", output: {} },
        plan: { status: "completed", output: { conclusion: "plan-ready" } },
        "publish-spec": { status: "completed", output: {} },
        "spec-approval": { status: "failed", output: {} },
        "gate-spec": { status: "failed", error: "Gate rejected by user at step 'gate-spec'", output: { choice: "reject", answered_by: "U03T2SB0B", aborted: true } },
      },
    },
  });
}

test("S1: completed run (golden)", () => {
  const s = buildRunSummary(completedRun(tempDir("sum-")));
  assert.equal(s.text, [
    "*Run 93cd560c completed* · factory-lane · 16m 42s",
    "Issue g/adlc-workspace#174 · dispatch supervised",
    "MR/PR:",
    "• https://github.com/g/adlc-team-skills/pull/198",
    "Conclusion: Drill done: draft PR open",
    "Gates:",
    "• gate-spec: approve (by U03T2SB0B)",
    "Steps:",
    "• ✓ run-branch: completed",
    "• ✓ plan: completed",
    "• ✓ publish-spec: completed",
    "• ✓ spec-approval: completed",
    "• ✓ gate-spec: completed",
    "• ✓ run-branch-execute: completed",
    "• ✓ execute: completed",
    "Resumed 1 time",
  ].join("\n"));
});

test("S1: failed run (golden)", () => {
  const s = buildRunSummary(failedRun(tempDir("sum-")));
  assert.equal(s.text, [
    "*Run 56d27c13 failed* · factory-lane · 6m 10s",
    "Issue g/adlc-workspace#181 · dispatch supervised",
    "Failed at `plan`: Agent step 'plan': blocked: dependency-gate on #66",
    "MR/PR: none",
    "Conclusion: blocked: dependency-gate on #66",
    "Steps:",
    "• ✓ run-branch: completed",
    "• ✗ plan: failed",
  ].join("\n"));
  assert.deepEqual(s.failed_step, { id: "plan", error: "Agent step 'plan': blocked: dependency-gate on #66" });
});

test("S1: aborted run (golden)", () => {
  const s = buildRunSummary(abortedRun(tempDir("sum-")));
  assert.equal(s.text, [
    "*Run 7edcedf2 aborted* · factory-lane · 45s",
    "Issue g/adlc-workspace#172 · dispatch supervised",
    "Failed at `gate-spec`: Gate rejected by user at step 'gate-spec'",
    "MR/PR: none",
    "Conclusion: plan-ready",
    "Gates:",
    "• gate-spec: reject (by U03T2SB0B)",
    "Steps:",
    "• ✓ run-branch: completed",
    "• ✓ plan: completed",
    "• ✓ publish-spec: completed",
    "• ✗ spec-approval: failed",
    "• ✗ gate-spec: failed",
    "Resumed 1 time",
  ].join("\n"));
});

test("S3: every link once, mr_urls split, non-links dropped", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r1", {
    steps: [["publish-spec", "shell"], ["execute", "command"]],
    state: {
      workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:05Z",
      step_results: {
        "publish-spec": { status: "completed", output: { mr_url: "https://gl.test/g/p/-/merge_requests/1" } },
        execute: { status: "completed", output: { mr_url: "https://gl.test/g/p/-/merge_requests/1", mr_urls: "https://github.com/g/c/pull/2, javascript:alert(1) https://github.com/g/d/pull/3" } },
      },
    },
  });
  assert.deepEqual(buildRunSummary(dir).mr_urls, [
    "https://gl.test/g/p/-/merge_requests/1", "https://github.com/g/c/pull/2", "https://github.com/g/d/pull/3",
  ]);
});

test("S4: step text is redacted, one line, capped; the text fits one message", () => {
  const root = tempDir("sum-");
  const token = "glpat-" + "a1b2c3d4e5f6g7h8i9j0";
  const results = {};
  const steps = [];
  for (let i = 0; i < 120; i++) { results[`step-${i}`] = { status: "completed", output: {} }; steps.push([`step-${i}`, "shell"]); }
  results.execute = { status: "failed", error: `push to https://oauth2:${token}@gl.test failed\nline two`, output: { conclusion: "x".repeat(5000) } };
  steps.push(["execute", "command"]);
  const dir = writeRun(root, "r2", { steps, state: { workflow_id: "w", status: "failed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T09:05:00Z", step_results: results } });
  const s = buildRunSummary(dir);
  assert.ok(!s.text.includes(token));
  assert.ok(!s.failed_step.error.includes("\n"));
  assert.ok(s.conclusion.length <= 300);
  assert.ok(s.text.length <= SUMMARY_MAX_CHARS);
  assert.match(s.text, /^\*Run r2 failed\* · w · 1h 5m/);
});

test("S2: an answered_by that is not a plain id is not shown", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r3", {
    steps: [["gate-spec", "gate"]],
    state: { workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:01Z",
      step_results: { "gate-spec": { status: "completed", output: { choice: "approve", answered_by: "<!channel> evil" } } } },
  });
  assert.match(buildRunSummary(dir).text, /• gate-spec: approve\n/);
});

// ── S2 end to end: the gate records who answered ────────────────────────────

function gateProject() {
  const dir = tempDir("sum-gate-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const wf = join(tempDir("sum-gate-wf-"), "workflow.yml");
  writeFileSync(wf, `schema_version: "1.0"
workflow:
  id: g-wf
  name: G
  version: "1.0.0"
inputs:
  verdict: {type: string, default: "", enum: ["", approve, reject]}
steps:
  - id: gate-spec
    type: gate
    message: "Approve?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
`);
  return { dir, wf };
}

// The gate pauses first (no verdict), then a relay resumes it with the
// verdict and ADLC_ANSWERED_BY: the gate that asked is the gate answered.
async function runGate(env, verdict = "approve") {
  const { dir, wf } = gateProject();
  const saved = process.env.ADLC_ANSWERED_BY;
  try {
    delete process.env.ADLC_ANSWERED_BY;
    const engine = new WorkflowEngine(dir);
    const paused = await engine.execute(engine.loadWorkflow(wf), {}, "g1", STEP_REGISTRY);
    assert.equal(paused.status, RunStatus.PAUSED);
    if (env === undefined) delete process.env.ADLC_ANSWERED_BY;
    else process.env.ADLC_ANSWERED_BY = env;
    const state = await engine.resume("g1", { verdict }, STEP_REGISTRY);
    return { dir, state };
  } finally {
    if (saved === undefined) delete process.env.ADLC_ANSWERED_BY;
    else process.env.ADLC_ANSWERED_BY = saved;
  }
}

test("S2: a gate answered through its verdict input records ADLC_ANSWERED_BY", async () => {
  const { state } = await runGate("U03T2SB0B");
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.stepResults["gate-spec"].output.answered_by, "U03T2SB0B");
});

test("S2: a reject records who rejected", async () => {
  const { state } = await runGate("U03T2SB0B", "reject");
  assert.equal(state.stepResults["gate-spec"].output.answered_by, "U03T2SB0B");
});

test("S2: no ADLC_ANSWERED_BY, or one that is not a plain id, records nothing", async () => {
  assert.equal((await runGate(undefined)).state.stepResults["gate-spec"].output.answered_by, undefined);
  assert.equal((await runGate("<!here>")).state.stepResults["gate-spec"].output.answered_by, undefined);
  assert.equal((await runGate("@channel")).state.stepResults["gate-spec"].output.answered_by, undefined);
});

// ── the command ─────────────────────────────────────────────────────────────

test("S1: `workflow summary` prints the text, `--json` the object; a missing run exits 1", { skip: !POSIX }, () => {
  const root = tempDir("sum-cli-");
  failedRun(root);
  const r = spawnSync(process.execPath, [BIN, "workflow", "summary", "56d27c13"], { cwd: root, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\*Run 56d27c13 failed\* · factory-lane · 6m 10s/);
  const j = spawnSync(process.execPath, [BIN, "workflow", "summary", "56d27c13", "--json"], { cwd: root, encoding: "utf-8" });
  assert.equal(j.status, 0, j.stderr);
  const obj = JSON.parse(j.stdout);
  assert.equal(obj.status, "failed");
  assert.equal(obj.failed_step.id, "plan");
  assert.match(obj.text, /^\*Run 56d27c13 failed\*/);
  const missing = spawnSync(process.execPath, [BIN, "workflow", "summary", "nope"], { cwd: root, encoding: "utf-8" });
  assert.equal(missing.status, 1);
});

// ── security review of a9f8541 ──────────────────────────────────────────────

test("S5: a non-gate step that writes choice/answered_by is not shown as a gate", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r5", {
    steps: [["fake", "shell"], ["typeless", undefined]],
    state: { workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:01Z",
      step_results: {
        fake: { status: "completed", output: { choice: "approve", answered_by: "U0BOSS" } },
        typeless: { status: "completed", output: { choice: "approve", answered_by: "U0BOSS" } },
      } },
  });
  const s = buildRunSummary(dir);
  assert.deepEqual(s.gates, []);
  assert.doesNotMatch(s.text, /Gates:|U0BOSS/);
});

test("S6: chat markup and broadcast mentions in step text are neutralised in the text", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r6", {
    steps: [["execute", "command"]],
    state: { workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:01Z",
      step_results: { execute: { status: "completed", output: { conclusion: "done <!channel> <https://evil.test|click> a & b @here @everyone @channel" } } } },
  });
  const s = buildRunSummary(dir);
  assert.ok(!s.text.includes("<!channel>"), s.text);
  assert.ok(!s.text.includes("<https://evil.test|click>"), s.text);
  assert.match(s.text, /&lt;!channel&gt;/);
  assert.match(s.text, /a &amp; b/);
  for (const m of ["@here", "@everyone", "@channel"]) assert.ok(!s.text.includes(m), m);
  assert.equal(s.conclusion, "done <!channel> <https://evil.test|click> a & b @here @everyone @channel"); // JSON keeps the text
});

function twoGateProject() {
  const dir = tempDir("sum-gate2-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const wf = join(tempDir("sum-gate2-wf-"), "workflow.yml");
  writeFileSync(wf, `schema_version: "1.0"
workflow:
  id: g2-wf
  name: G2
  version: "1.0.0"
inputs:
  v1: {type: string, default: "", enum: ["", approve, reject]}
  v2: {type: string, default: "", enum: ["", approve, reject]}
steps:
  - id: gate-one
    type: gate
    message: "One?"
    options: [approve, reject]
    verdict_input: v1
  - id: gate-two
    type: gate
    message: "Two?"
    options: [approve, reject]
    verdict_input: v2
`);
  return { dir, wf };
}

async function withAnswerer(id, fn) {
  const saved = process.env.ADLC_ANSWERED_BY;
  if (id === undefined) delete process.env.ADLC_ANSWERED_BY; else process.env.ADLC_ANSWERED_BY = id;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.ADLC_ANSWERED_BY; else process.env.ADLC_ANSWERED_BY = saved;
  }
}

test("S2: the answerer is recorded only for a verdict supplied in this run or resume call", async () => {
  const { dir, wf } = twoGateProject();
  const engine = new WorkflowEngine(dir);
  // Started with v2 preset and no answerer: gate-one pauses.
  let state = await withAnswerer(undefined, () => engine.execute(engine.loadWorkflow(wf), { v2: "approve" }, "g2", STEP_REGISTRY));
  assert.equal(state.status, RunStatus.PAUSED);
  // U1 answers gate-one. gate-two then runs on the v2 set at start: U1 did
  // not give that verdict, so it must not be credited to U1.
  state = await withAnswerer("U1", () => engine.resume("g2", { v1: "approve" }, STEP_REGISTRY));
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.stepResults["gate-one"].output.answered_by, "U1");
  assert.equal(state.stepResults["gate-two"].output.answered_by, undefined);
});

// ── security review of 55631f7 ──────────────────────────────────────────────

test("S2: a verdict preset at the start (no pause) is not credited to anyone", async () => {
  const { dir, wf } = gateProject();
  const state = await withAnswerer("U1", () => { const e = new WorkflowEngine(dir); return e.execute(e.loadWorkflow(wf), { verdict: "approve" }, "g0", STEP_REGISTRY); });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.stepResults["gate-spec"].output.answered_by, undefined);
});

test("S2: two gates sharing one verdict input: only the gate that asked is credited", async () => {
  const dir = tempDir("sum-shared-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const wf = join(tempDir("sum-shared-wf-"), "workflow.yml");
  writeFileSync(wf, `schema_version: "1.0"
workflow:
  id: sh-wf
  name: SH
  version: "1.0.0"
inputs:
  verdict: {type: string, default: "", enum: ["", approve, reject]}
steps:
  - id: gate-a
    type: gate
    message: "A?"
    options: [approve, reject]
    verdict_input: verdict
  - id: gate-b
    type: gate
    message: "B?"
    options: [approve, reject]
    verdict_input: verdict
`);
  const engine = new WorkflowEngine(dir);
  await withAnswerer(undefined, () => engine.execute(engine.loadWorkflow(wf), {}, "sh", STEP_REGISTRY));
  const state = await withAnswerer("U1", () => engine.resume("sh", { verdict: "approve" }, STEP_REGISTRY));
  assert.equal(state.stepResults["gate-a"].output.answered_by, "U1");
  assert.equal(state.stepResults["gate-b"]?.output?.answered_by, undefined);
});

test("S6: an answerer that looks like a mention is never rendered as one", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r7", {
    steps: [["gate-spec", "gate"]],
    state: { workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:01Z",
      step_results: { "gate-spec": { status: "completed", output: { choice: "approve", answered_by: "@channel" } } } },
  });
  const s = buildRunSummary(dir);
  assert.ok(!s.text.includes("@channel"), s.text);
});

test("S5: the log cannot turn a step into a gate: the run's definition decides", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r8", {
    steps: [["fake", "gate"], ["fake", "shell"]], defined: [["fake", "shell"]],
    state: { workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:01Z",
      step_results: { fake: { status: "completed", output: { choice: "approve", answered_by: "U0BOSS" } } } },
  });
  assert.deepEqual(buildRunSummary(dir).gates, []);
});

test("S5: without the run's definition there are no gate lines (fail closed)", () => {
  const root = tempDir("sum-");
  const dir = writeRun(root, "r9", {
    steps: [["gate-spec", "gate"]], definition: false,
    state: { workflow_id: "w", status: "completed", created_at: "2026-11-23T08:00:00Z", updated_at: "2026-11-23T08:00:01Z",
      step_results: { "gate-spec": { status: "completed", output: { choice: "approve", answered_by: "U1" } } } },
  });
  const s = buildRunSummary(dir);
  assert.deepEqual(s.gates, []);
  assert.match(s.text, /• ✓ gate-spec: completed/);
});

test("S1: a real paused-and-resumed run: gate credited, one resume, from the engine's own files", async () => {
  const { dir } = await runGate("U03T2SB0B");
  const s = buildRunSummary(join(dir, ".adlc", "workflows", "runs", "g1"));
  assert.deepEqual(s.gates, [{ id: "gate-spec", choice: "approve", answered_by: "U03T2SB0B" }]);
  assert.equal(s.resumes, 1);
  assert.match(s.text, /• gate-spec: approve \(by U03T2SB0B\)/);
  assert.match(s.text, /Resumed 1 time$/);
});
