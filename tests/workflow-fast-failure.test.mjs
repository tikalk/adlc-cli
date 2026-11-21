// Agent fast-failure classification (ADR-542).
//
// Contract pinned here:
//   F1  An agent step that exits non-zero within the fast-failure threshold
//       of spawn (60 s production default) fails the run as an
//       INFRASTRUCTURE failure: state.fastFailure is true, persisted as
//       fast_failure in state.json, the step output carries fast_failure +
//       agent_elapsed_seconds, the run_failed event carries fast_failure,
//       and the command boundary classifies the run to the retryable exit 1.
//   F2  A non-zero exit past the threshold stays a LOGICAL failure: no
//       fast_failure anywhere, exit 10. (Threshold shortened via the
//       ADLC_FAST_FAILURE_THRESHOLD_SECONDS test seam so the suite does not
//       wait 60 s.)
//   F3  Resume clears the mark: a run retried after a fast failure and
//       completing has no fast_failure in its state file.
//   F4  A signal kill within the threshold (e.g. OOM at start-up) is a fast
//       failure too — it reaches the same non-zero-exit branch.
//   F5  continue_on_error: a fast failure the run is told to continue past
//       never marks the run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { classifyWorkflowStatus } from "../src/exit-codes.mjs";

const POSIX = process.platform !== "win32";
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

// A fake `opencode` on PATH: sleeps $FAKE_SLEEP_MS, then either kills itself
// with $FAKE_SIGNAL or exits $FAKE_EXIT (default 0). When $FAKE_MARKER is
// set, the first invocation creates the marker and exits $FAKE_EXIT, later
// invocations exit 0 (fail-then-succeed for resume tests).
function installFakeAgent() {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const sleep = Number(process.env.FAKE_SLEEP_MS || 0);
const act = () => {
  if (process.env.FAKE_SIGNAL) { process.kill(process.pid, process.env.FAKE_SIGNAL); return; }
  let code = Number(process.env.FAKE_EXIT || 0);
  if (process.env.FAKE_MARKER) {
    if (fs.existsSync(process.env.FAKE_MARKER)) code = 0;
    else fs.writeFileSync(process.env.FAKE_MARKER, String(process.pid));
  }
  console.log(JSON.stringify({ type: "text", text: "fake" }));
  process.exit(code);
};
sleep > 0 ? setTimeout(act, sleep) : act();
`);
  chmodSync(script, 0o755);
  return bin;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function project() {
  const dir = tempDir("fast-failure-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function workflowFile(stepsYaml) {
  const path = join(tempDir("fast-failure-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ff-wf
  name: Fast Failure
  version: "1.0.0"
  integration: opencode
steps:
${stepsYaml}`);
  return path;
}

const stateJson = (dir, runId) =>
  JSON.parse(readFileSync(join(dir, ".adlc", "workflows", "runs", runId, "state.json"), "utf-8"));

const AGENT_STEP = `  - id: work
    type: command
    command: factory-product
`;

async function runOnce({ dir, env = {}, runId = "r1" } = {}) {
  const events = [];
  return withEnv(env, async () => {
    const engine = new WorkflowEngine(dir);
    engine.onEvent = (ev) => events.push(ev);
    const state = await engine.execute(engine.loadWorkflow(workflowFile(AGENT_STEP)), {}, runId, STEP_REGISTRY);
    return { state, events };
  });
}

test("F1: fast non-zero exit marks the run retryable end to end", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "3" };
  const { state, events } = await runOnce({ dir, env });
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(state.fastFailure, true);
  assert.match(state.error, /infrastructure failure.*ADR-542/s);
  const persisted = stateJson(dir, state.runId);
  assert.equal(persisted.fast_failure, true);
  const stepOut = state.stepResults.work?.output ?? {};
  assert.equal(stepOut.fast_failure, true);
  assert.equal(typeof stepOut.agent_elapsed_seconds, "number");
  assert.ok(stepOut.agent_elapsed_seconds < 60);
  const runFailed = events.find((e) => e.type === "run_failed");
  assert.equal(runFailed?.fast_failure, true);
  assert.equal(classifyWorkflowStatus(state.status, { fastFailure: state.fastFailure === true }).exitCode, 1);
});

test("F2: failure past the threshold stays a logical failure", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_EXIT: "3",
    FAKE_SLEEP_MS: "1000",
    ADLC_FAST_FAILURE_THRESHOLD_SECONDS: "0.2",
  };
  const { state, events } = await runOnce({ dir, env });
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(state.fastFailure, false);
  assert.doesNotMatch(state.error, /infrastructure failure/);
  const persisted = stateJson(dir, state.runId);
  assert.equal("fast_failure" in persisted, false);
  const stepOut = state.stepResults.work?.output ?? {};
  assert.equal("fast_failure" in stepOut, false);
  assert.equal(typeof stepOut.agent_elapsed_seconds, "number");
  const runFailed = events.find((e) => e.type === "run_failed");
  assert.equal(runFailed && "fast_failure" in runFailed, false);
  assert.equal(classifyWorkflowStatus(state.status, { fastFailure: state.fastFailure === true }).exitCode, 10);
});

test("F3: resume after a fast failure clears the mark", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const marker = join(tempDir("fast-failure-marker-"), "once");
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "3", FAKE_MARKER: marker };
  const { state: state1 } = await runOnce({ dir, env, runId: "r3" });
  assert.equal(state1.status, RunStatus.FAILED);
  assert.equal(state1.fastFailure, true);
  // Second invocation of the fake agent exits 0 (marker exists).
  const state2 = await withEnv(env, async () => {
    const engine = new WorkflowEngine(dir);
    return engine.resume(state1.runId, {}, STEP_REGISTRY);
  });
  assert.equal(state2.status, RunStatus.COMPLETED);
  const persisted = stateJson(dir, state1.runId);
  assert.equal("fast_failure" in persisted, false);
});

test("F4: a signal kill within the threshold is a fast failure", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_SIGNAL: "SIGTERM" };
  const { state } = await runOnce({ dir, env });
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(state.fastFailure, true);
  assert.equal(stateJson(dir, state.runId).fast_failure, true);
});

test("F5: continue_on_error never marks the run", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const path = join(tempDir("fast-failure-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ff-wf
  name: Fast Failure
  version: "1.0.0"
  integration: opencode
steps:
  - id: work
    type: command
    command: factory-product
    continue_on_error: true
  - id: after
    type: shell
    run: "true"
`);
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "3" };
  const state = await withEnv(env, async () => {
    const engine = new WorkflowEngine(dir);
    return engine.execute(engine.loadWorkflow(path), {}, "r5", STEP_REGISTRY);
  });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.fastFailure, false);
  assert.equal("fast_failure" in stateJson(dir, "r5"), false);
});
