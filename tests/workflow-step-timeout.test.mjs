// A step killed by its own time limit is told apart from an agent failure and
// ends the run with the retryable exit code (SF-FIX-05).
//
// Before: `timeout` (default 3600 s) sent SIGKILL, the step failed with
// "exited with code signal SIGKILL", the run was FAILED and the CLI exited 10
// ("the agent got it wrong"), which the Argo lane never retries.
//
// Contract pinned here:
//   T1  A timed-out agent step fails with an error that starts
//       "timeout: step <id> exceeded <n>s"; its output has timed_out: true.
//       The run is FAILED (still resumable) with timed_out in state.json, a
//       step_timed_out log entry and timed_out on the run_failed event.
//   T2  An agent that exits non-zero by itself is unchanged: no timed_out,
//       exit code 10.
//   T3  CLI: a time-out exits 1; ADLC_WORKFLOW_ON_TIMEOUT=fail exits 10; a
//       plain agent failure exits 10.
//   T4  A timed-out run can be resumed; the flag is cleared.
//   T5  continue_on_error on a timed-out step keeps the run going.
//   T6  classifyWorkflowStatus: only failed + timedOut maps to 1.
//   T7  The bundled factory-supervised / factory-autonomous workflows set an
//       explicit `timeout` on every agent step; execute is 7200.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { classifyWorkflowStatus } from "../src/exit-codes.mjs";

const POSIX = process.platform !== "win32";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "bin", "adlc-cli.mjs");

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

// A fake `opencode` on PATH: sleeps $FAKE_SLEEP_MS (default 0), then exits
// $FAKE_EXIT (default 0). With $FAKE_SLOW_ONCE set to a file path it sleeps
// only while that file does not exist, and creates it — so a second attempt
// of the same step is fast.
function installFakeAgent() {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
let ms = Number(process.env.FAKE_SLEEP_MS || 0);
const once = process.env.FAKE_SLOW_ONCE;
if (once) {
  if (fs.existsSync(once)) ms = 0;
  else fs.writeFileSync(once, "1");
}
console.log(JSON.stringify({ type: "text", text: "working" }));
setTimeout(() => process.exit(Number(process.env.FAKE_EXIT || 0)), ms);
`);
  chmodSync(script, 0o755);
  return bin;
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

function project() {
  const dir = tempDir("step-timeout-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function workflow(stepsYaml) {
  const path = join(tempDir("step-timeout-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: timeout-wf
  name: Step Timeout
  version: "1.0.0"
  integration: opencode
inputs:
  issue_ref: {type: string, default: ""}
steps:
${stepsYaml}`);
  return path;
}

const EXECUTE = (extra = "") => `  - id: execute
    type: command
    command: factory-mission
    timeout: 1
${extra}`;
const AFTER = `  - id: after
    type: shell
    run: "echo after"
`;

const persisted = (dir, runId) => JSON.parse(readFileSync(join(dir, ".adlc", "workflows", "runs", runId, "state.json"), "utf-8"));
const logOf = (dir, runId) => readFileSync(join(dir, ".adlc", "workflows", "runs", runId, "log.jsonl"), "utf-8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function run(stepsYaml, runId, env) {
  const bin = installFakeAgent();
  const dir = project();
  const events = [];
  const state = await withEnv({ PATH: `${bin}:${process.env.PATH}`, ADLC_WORKFLOW_ON_TIMEOUT: undefined, ...env }, async () => {
    const engine = new WorkflowEngine(dir);
    engine.onEvent = (e) => events.push(e);
    return engine.execute(engine.loadWorkflow(workflow(stepsYaml)), {}, runId, STEP_REGISTRY);
  });
  return { dir, bin, state, events };
}

test("T1: a step that exceeds its timeout fails as a time-out, not as an agent failure", { skip: !POSIX }, async () => {
  const { dir, state, events } = await run(EXECUTE() + AFTER, "t1", { FAKE_SLEEP_MS: "30000", FAKE_EXIT: "0" });
  const step = state.stepResults.execute;
  assert.equal(step.status, StepStatus.FAILED);
  assert.match(step.error, /^timeout: step execute exceeded 1s/);
  assert.equal(step.output.timed_out, true);
  assert.equal(step.output.timeout_seconds, 1);
  assert.doesNotMatch(step.error, /exited with code/, "not reported as an agent exit");

  assert.equal(state.status, RunStatus.FAILED, "the run stays failed, so it can be resumed");
  assert.equal(state.timedOut, true);
  assert.match(state.error, /^timeout: step execute exceeded 1s/);
  assert.equal(state.stepResults.after, undefined, "the next step never ran");
  assert.equal(persisted(dir, "t1").timed_out, true);
  assert.ok(logOf(dir, "t1").some((e) => e.event === "step_timed_out" && e.step_id === "execute" && e.timeout_seconds === 1));
  const failed = events.find((e) => e.type === "run_failed");
  assert.equal(failed.timed_out, true);
  assert.match(failed.error, /^timeout: step execute exceeded 1s/);
  assert.equal(classifyWorkflowStatus(state.status, { timedOut: state.timedOut }).exitCode, 1);
});

test("T2: an agent that fails by itself is still a logical failure", { skip: !POSIX }, async () => {
  const { dir, state, events } = await run(EXECUTE() + AFTER, "t2", { FAKE_SLEEP_MS: "0", FAKE_EXIT: "2" });
  const step = state.stepResults.execute;
  assert.equal(step.status, StepStatus.FAILED);
  assert.match(step.error, /Agent step 'execute' exited with code 2\./);
  assert.equal(step.output.timed_out, undefined);
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(state.timedOut, false);
  assert.equal("timed_out" in persisted(dir, "t2"), false, "state.json is unchanged for ordinary failures");
  assert.equal("timed_out" in events.find((e) => e.type === "run_failed"), false);
  assert.equal(logOf(dir, "t2").some((e) => e.event === "step_timed_out"), false);
  assert.equal(classifyWorkflowStatus(state.status, { timedOut: state.timedOut }).exitCode, 10);
});

test("T3: the CLI exits 1 on a time-out, 10 with ADLC_WORKFLOW_ON_TIMEOUT=fail, 10 on an agent failure", { skip: !POSIX }, () => {
  const bin = installFakeAgent();
  const wf = workflow(EXECUTE());
  const cli = (env) => {
    const dir = project();
    const base = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete base.ADLC_WORKFLOW_ON_TIMEOUT;
    delete base.ADLC_WORKFLOW_RUN_ID;
    return spawnSync(process.execPath, [CLI, "workflow", "run", wf, "--format", "json"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...base, ...env },
      timeout: 60_000,
    });
  };
  const timedOut = cli({ FAKE_SLEEP_MS: "30000" });
  assert.equal(timedOut.status, 1, `stdout: ${timedOut.stdout}\nstderr: ${timedOut.stderr}`);
  assert.match(timedOut.stdout, /"type":"run_failed"[^\n]*timeout: step execute exceeded 1s/);

  const optOut = cli({ FAKE_SLEEP_MS: "30000", ADLC_WORKFLOW_ON_TIMEOUT: "fail" });
  assert.equal(optOut.status, 10, "the opt-out keeps the old exit code");
  assert.match(optOut.stdout, /timeout: step execute exceeded 1s/, "the message still says it was a time-out");

  const failed = cli({ FAKE_SLEEP_MS: "0", FAKE_EXIT: "2" });
  assert.equal(failed.status, 10);
});

test("T4: a timed-out run can be resumed, and the time-out mark is cleared", { skip: !POSIX }, async () => {
  const once = join(tempDir("slow-once-"), "ran");
  const { dir, bin, state } = await run(EXECUTE() + AFTER, "t4", { FAKE_SLEEP_MS: "30000", FAKE_SLOW_ONCE: once });
  assert.equal(state.timedOut, true);
  const resumed = await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_SLEEP_MS: "30000", FAKE_SLOW_ONCE: once }, () =>
    new WorkflowEngine(dir).resume("t4", null, STEP_REGISTRY));
  assert.equal(resumed.status, RunStatus.COMPLETED);
  assert.equal(resumed.timedOut, false);
  assert.equal("timed_out" in persisted(dir, "t4"), false);
  assert.equal(resumed.stepResults.after.status, StepStatus.COMPLETED);
});

test("T5: continue_on_error on a timed-out step keeps the run going", { skip: !POSIX }, async () => {
  const { state } = await run(EXECUTE("    continue_on_error: true\n") + AFTER, "t5", { FAKE_SLEEP_MS: "30000" });
  assert.equal(state.stepResults.execute.output.timed_out, true);
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.timedOut, false, "the run did not fail, so it is not a timed-out run");
  assert.equal(state.stepResults.after.status, StepStatus.COMPLETED);
});

test("T6: only a failed run that timed out maps to the retryable exit code", () => {
  assert.equal(classifyWorkflowStatus("failed", { timedOut: true }).exitCode, 1);
  assert.equal(classifyWorkflowStatus("failed", { timedOut: false }).exitCode, 10);
  assert.equal(classifyWorkflowStatus("failed").exitCode, 10);
  assert.equal(classifyWorkflowStatus("failed", {}).exitCode, 10);
  assert.equal(classifyWorkflowStatus("failed", { timedOut: "yes" }).exitCode, 10, "only the boolean true counts");
  assert.equal(classifyWorkflowStatus("completed", { timedOut: true }).exitCode, 0);
  assert.equal(classifyWorkflowStatus("paused", { timedOut: true }).exitCode, 3);
  assert.equal(classifyWorkflowStatus("aborted", { timedOut: true }).exitCode, 1);
});

test("T7: bundled supervised/autonomous workflows set an explicit timeout on every agent step", () => {
  const engine = new WorkflowEngine(tempDir("bundled-timeouts-"));
  for (const id of ["factory-supervised", "factory-autonomous"]) {
    const def = engine.loadWorkflow(id);
    const agentSteps = def.steps.filter((s) => (s.type ?? "command") === "command" || s.type === "prompt");
    assert.ok(agentSteps.length > 0, `${id}: fixture has agent steps`);
    for (const s of agentSteps) {
      assert.equal(typeof s.timeout, "number", `${id}: step ${s.id} must set timeout on purpose`);
      assert.ok(s.timeout > 0);
    }
    assert.equal(def.steps.find((s) => s.id === "execute").timeout, 7200, `${id}: execute is limited to 7200 s`);
  }
});
