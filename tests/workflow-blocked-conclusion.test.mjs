// A step that ends `blocked:` ends the run (adlc-workspace#167).
//
// Evidence: #151 re-send, run fa82c68a (2026-11-22, adlc-cli 2.15.0). The
// `plan` step (factory-mission --plan) hit the dependency hard gate, posted
// its refusal, set the issue back to spec-gated and wrote
// {"conclusion":"blocked: dependency-gate on #164 (open)"} — then exited 0.
// The engine completed the step and paused gate-spec with nothing to
// approve; the approval started `execute` on a refused mission.
//
// Contract pinned here:
//   B1  After exit 0, an agent step whose ADLC_STEP_OUTPUT `conclusion`
//       starts with `blocked:` (case-insensitive, after leading space) FAILS
//       with that conclusion in the error: the run ends failed, no later gate
//       pauses and no later step runs.
//   B2  It is a logical failure, never the retryable infrastructure one: the
//       run state carries no fast_failure, so `workflow run` exits 10 (the
//       lane's retryStrategy does not retry 10).
//   B3  A conclusion that only mentions "blocked:" later, or no conclusion,
//       completes as before; the output object is still merged on B1.
//   B4  A blocked conclusion wins over a question payload: a refused step
//       never pauses to ask.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { classifyWorkflowStatus } from "../src/exit-codes.mjs";

const POSIX = process.platform !== "win32";
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "adlc-cli.mjs");
const BLOCKED = "blocked: dependency-gate on #164 (open)";
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

// A fake `opencode`: for the step named in $FAKE_STEP it writes $FAKE_OUTPUT to
// ADLC_STEP_OUTPUT (and $FAKE_QUESTION to ADLC_STEP_QUESTION); every step
// appends its id to $FAKE_LOG. Always exits 0, like the agent did in fa82c68a.
function installFakeAgent() {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const step = process.env.ADLC_STEP_ID;
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, step + "\\n");
if (step === process.env.FAKE_STEP) {
  if (process.env.FAKE_OUTPUT !== undefined && process.env.ADLC_STEP_OUTPUT) {
    fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
    fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, process.env.FAKE_OUTPUT);
  }
  if (process.env.FAKE_QUESTION && process.env.ADLC_STEP_QUESTION) {
    fs.mkdirSync(path.dirname(process.env.ADLC_STEP_QUESTION), { recursive: true });
    fs.writeFileSync(process.env.ADLC_STEP_QUESTION, process.env.FAKE_QUESTION);
  }
}
console.log(JSON.stringify({ type: "text", text: "ok" }));
process.exit(0);
`);
  chmodSync(script, 0o755);
  return bin;
}

function project() {
  const dir = tempDir("blocked-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

// The lane's shape: plan, then the spec gate, then execute.
function laneWorkflow() {
  const path = join(tempDir("blocked-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: blocked-wf
  name: Blocked
  version: "1.0.0"
  integration: opencode
inputs:
  issue_ref: {type: string, default: ""}
  verdict: {type: string, default: "", enum: ["", approve, reject]}
steps:
  - id: plan
    type: command
    command: factory-mission
  - id: gate-spec
    type: gate
    message: "Approve the plan?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: execute
    type: command
    command: factory-mission
`);
  return path;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function runLane({ output, question, step = "plan" } = {}) {
  const bin = installFakeAgent();
  const dir = project();
  const log = join(tempDir("log-"), "steps.log");
  return withEnv({
    PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_STEP: step,
    FAKE_OUTPUT: output, FAKE_QUESTION: question,
  }, async () => {
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(laneWorkflow()), { issue_ref: "g/p#151" }, "r167", STEP_REGISTRY);
    let ran = [];
    try { ran = (await import("node:fs")).readFileSync(log, "utf-8").trim().split("\n").filter(Boolean); } catch {}
    return { state, ran };
  });
}

test("B1: a plan step that concludes blocked: fails the run before the spec gate", { skip: !POSIX }, async () => {
  const { state, ran } = await runLane({ output: JSON.stringify({ conclusion: BLOCKED }) });
  assert.equal(state.status, RunStatus.FAILED);
  assert.deepEqual(ran, ["plan"]); // execute never ran
  assert.equal(state.stepResults["gate-spec"], undefined); // the gate never paused
  const plan = state.stepResults.plan;
  assert.equal(plan.status, "failed");
  assert.match(plan.error, /blocked: dependency-gate on #164 \(open\)/);
  assert.equal(plan.output.conclusion, BLOCKED); // the output is still merged
});

test("B2: it is a logical failure (exit 10), never the retryable one", { skip: !POSIX }, async () => {
  const { state } = await runLane({ output: JSON.stringify({ conclusion: BLOCKED }) });
  assert.notEqual(state.fastFailure, true);
  assert.equal(classifyWorkflowStatus(state.status, { fastFailure: state.fastFailure === true }).exitCode, 10);
});

for (const conclusion of ["Blocked: factory run without an issue", "  blocked: pause publish failed (push refused)"]) {
  test(`B1: ${JSON.stringify(conclusion)} counts as blocked`, { skip: !POSIX }, async () => {
    const { state, ran } = await runLane({ output: JSON.stringify({ conclusion }) });
    assert.equal(state.status, RunStatus.FAILED);
    assert.deepEqual(ran, ["plan"]);
  });
}

for (const [name, output] of [
  ["a normal conclusion", JSON.stringify({ conclusion: "plan-ready" })],
  ["a conclusion that mentions blocked: later", JSON.stringify({ conclusion: "plan-ready; was blocked: by #164, now closed" })],
  ["no conclusion", JSON.stringify({ mr_url: "https://gl.test/g/p/-/merge_requests/1" })],
  ["no output file", undefined],
]) {
  test(`B3: ${name} completes plan and pauses at the gate as before`, { skip: !POSIX }, async () => {
    const { state, ran } = await runLane({ output });
    assert.equal(state.status, RunStatus.PAUSED);
    assert.deepEqual(ran, ["plan"]);
    assert.equal(state.stepResults.plan.status, "completed");
  });
}

test("B4: a blocked conclusion wins over a question payload", { skip: !POSIX }, async () => {
  const { state } = await runLane({
    output: JSON.stringify({ conclusion: BLOCKED }),
    question: JSON.stringify({ summary: "s", questions: [{ id: "q1", text: "Which channel?" }] }),
  });
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(state.stepResults.plan.status, "failed");
});

test("B2: `adlc-cli workflow run` exits 10 on a blocked plan", { skip: !POSIX }, () => {
  const bin = installFakeAgent();
  const dir = project();
  const r = spawnSync(process.execPath, [BIN, "workflow", "run", laneWorkflow(), "--format", "json", "--input", "issue_ref=g/p#151"], {
    cwd: dir, encoding: "utf-8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STEP: "plan", FAKE_OUTPUT: JSON.stringify({ conclusion: BLOCKED }) },
  });
  assert.equal(r.status, 10, r.stderr + r.stdout);
  const failed = r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e && e.type === "run_failed");
  assert.ok(failed, r.stdout);
  assert.notEqual(failed.status, "aborted"); // not a reject
  assert.match(failed.error ?? "", /blocked: dependency-gate/);
});

// B5 (security review of #118): a blocked step keeps its merged output, so
// agent-written fields must not steer the run. `aborted` (a string here; the
// gate sets the boolean true) must not turn the failure into an abort, which
// exits 1 and is retried.
test("B5: an agent-written aborted field cannot turn a blocked step into an abort", { skip: !POSIX }, async () => {
  const { state } = await runLane({ output: JSON.stringify({ conclusion: BLOCKED, aborted: "true" }) });
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(classifyWorkflowStatus(state.status, { fastFailure: state.fastFailure === true }).exitCode, 10);
});

test("B6: the blocked error is redacted and kept on one line", { skip: !POSIX }, async () => {
  const token = "glpat-" + "a1b2c3d4e5f6g7h8i9j0";
  const { state } = await runLane({ output: JSON.stringify({ conclusion: `blocked: push refused for https://oauth2:${token}@gl.test/g/p.git\nsecond line` }) });
  const err = state.stepResults.plan.error;
  assert.equal(state.status, RunStatus.FAILED);
  assert.ok(!err.includes(token), err);
  assert.ok(!err.includes("\n"), err);
  assert.match(err, /blocked: push refused/);
});
