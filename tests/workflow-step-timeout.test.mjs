// A step killed by its own time limit says so: it is told apart from an agent
// that failed by itself (SF-FIX-05). Nothing else changes: the run still ends
// as failed and the CLI still exits 10, which the Argo lane never retries.
//
// Before: `timeout` (default 3600 s) sent SIGKILL and the step failed with
// "Agent step 'execute' exited with code signal SIGKILL", the same words as
// an agent that crashed. Nothing in the error, the run state or the events
// said that a time limit was hit, or which one.
//
// Contract pinned here:
//   T1  A timed-out agent step fails with an error that starts
//       "timeout: step <id> exceeded <n>s"; its output has timed_out: true
//       and timeout_seconds. The run is FAILED (still resumable) with the
//       same error, timed_out in state.json, a step_timed_out log entry and
//       timed_out on the run_failed event. Exit code 10.
//   T2  An agent that exits non-zero by itself is not a time-out: same
//       error as before, no timed_out anywhere.
//   T3  CLI: a time-out exits 10 and prints the time-out error; no
//       environment variable turns it into a retry; a plain agent failure
//       carries no time-out mark.
//   T4  A timed-out run can be resumed; the mark is cleared.
//   T5  continue_on_error on a timed-out step keeps the run going.
//   T6  classifyWorkflowStatus: "failed" is 10; there is no time-out option
//       that makes it retryable.
//   T7  Fan-out: the halting item decides whether the run is marked.
//
// The exit code of an agent that fails by itself is deliberately NOT pinned
// here: it belongs to the agent-failure classification (ADR-542), not to
// this change.

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
// of the same step is fast. A prompt that contains "item=<n> slow=<m>"
// sleeps 30 s when n equals m and exits 2 at once otherwise, whatever the env
// says (used by the fan-out test, where each item needs its own behaviour).
function installFakeAgent() {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
let ms = Number(process.env.FAKE_SLEEP_MS || 0);
let code = Number(process.env.FAKE_EXIT || 0);
const once = process.env.FAKE_SLOW_ONCE;
if (once) {
  if (fs.existsSync(once)) ms = 0;
  else fs.writeFileSync(once, "1");
}
const fan = /item=(\\d+) slow=(\\d+)/.exec(process.argv.slice(2).join(" "));
if (fan) {
  if (fan[1] === fan[2]) { ms = 30000; code = 0; }
  else { ms = 0; code = 2; }
}
console.log(JSON.stringify({ type: "text", text: "working" }));
setTimeout(() => process.exit(code), ms);
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

// `limit` is the step's time limit in seconds. Tests that only need the
// time-out use 1. Tests in which an agent must also FINISH inside the limit
// use ROOMY, so a slow start of the fake agent on a loaded machine is not
// mistaken for a time-out.
const ROOMY = 4;
const EXECUTE = (extra = "", limit = 1) => `  - id: execute
    type: command
    command: factory-mission
    timeout: ${limit}
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
  const state = await withEnv({ PATH: `${bin}:${process.env.PATH}`, ...env }, async () => {
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
  assert.match(step.error, /killed by the step's time limit/);
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
  assert.equal(failed.status, "failed");
  assert.equal(classifyWorkflowStatus(state.status).exitCode, 10, "a time-out is a failed run: exit 10, not retried");
});

test("T2: an agent that fails by itself is not reported as a time-out", { skip: !POSIX }, async () => {
  const { dir, state, events } = await run(EXECUTE("", 60) + AFTER, "t2", { FAKE_SLEEP_MS: "0", FAKE_EXIT: "2" });
  const step = state.stepResults.execute;
  assert.equal(step.status, StepStatus.FAILED);
  assert.match(step.error, /Agent step 'execute' exited with code 2\./);
  assert.doesNotMatch(step.error, /timeout/);
  assert.equal(step.output.timed_out, undefined);
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(state.timedOut, false);
  assert.equal("timed_out" in persisted(dir, "t2"), false, "state.json is unchanged for ordinary failures");
  assert.equal("timed_out" in events.find((e) => e.type === "run_failed"), false);
  assert.equal(logOf(dir, "t2").some((e) => e.event === "step_timed_out"), false);
});

test("T3: the CLI exits 10 on a time-out and says it was a time-out; nothing makes it a retry", { skip: !POSIX }, () => {
  const bin = installFakeAgent();
  const cli = (env, format = ["--format", "json"], wf = workflow(EXECUTE())) => {
    const dir = project();
    const base = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete base.ADLC_WORKFLOW_ON_TIMEOUT;
    delete base.ADLC_WORKFLOW_RUN_ID;
    return spawnSync(process.execPath, [CLI, "workflow", "run", wf, ...format], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...base, ...env },
      timeout: 60_000,
    });
  };
  const runFailed = (stdout) => stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).find((e) => e.type === "run_failed");

  const timedOut = cli({ FAKE_SLEEP_MS: "30000" });
  assert.equal(timedOut.status, 10, `stdout: ${timedOut.stdout}\nstderr: ${timedOut.stderr}`);
  const event = runFailed(timedOut.stdout);
  assert.match(event.error, /^timeout: step execute exceeded 1s/);
  assert.equal(event.timed_out, true);
  assert.equal(event.status, "failed");

  // The summary a person reads (no --format json) carries the same words.
  const human = cli({ FAKE_SLEEP_MS: "30000" }, []);
  assert.equal(human.status, 10);
  assert.match((human.stdout + human.stderr).replace(/\s+/g, " "), /timeout: step execute exceeded 1s/);

  // An earlier draft of this change retried a time-out unless
  // ADLC_WORKFLOW_ON_TIMEOUT=fail was set. There is no such switch: a
  // time-out is a failed run whatever the variable holds.
  const withSwitch = cli({ FAKE_SLEEP_MS: "30000", ADLC_WORKFLOW_ON_TIMEOUT: "retry" });
  assert.equal(withSwitch.status, 10, "ADLC_WORKFLOW_ON_TIMEOUT must not change the exit code");

  const failed = cli({ FAKE_SLEEP_MS: "0", FAKE_EXIT: "2" }, undefined, workflow(EXECUTE("", 60)));
  assert.notEqual(failed.status, 0);
  assert.equal("timed_out" in runFailed(failed.stdout), false);
  assert.doesNotMatch(runFailed(failed.stdout).error, /timeout/);
});

test("T4: a timed-out run can be resumed, and the time-out mark is cleared", { skip: !POSIX }, async () => {
  const once = join(tempDir("slow-once-"), "ran");
  const { dir, bin, state } = await run(EXECUTE("", ROOMY) + AFTER, "t4", { FAKE_SLEEP_MS: "30000", FAKE_SLOW_ONCE: once });
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

test("T6: a failed run exits 10; no time-out option makes it retryable", () => {
  assert.equal(classifyWorkflowStatus("failed").exitCode, 10);
  assert.equal(classifyWorkflowStatus("failed", { timedOut: true }).exitCode, 10);
  assert.equal(classifyWorkflowStatus("failed", { timed_out: true }).exitCode, 10);
});

const FAN_OUT = (slowItem) => `  - id: emit
    type: shell
    run: "node -p [1,2]"
    output_format: json
  - id: work
    type: fan-out
    items: "{{ steps.emit.output.data }}"
    max_concurrency: 2
    step:
      id: unit
      type: command
      command: factory-mission
      timeout: ${ROOMY}
      input:
        args: "item={{ item }} slow=${slowItem}"
`;

test("T7: in a fan-out the halting item decides whether the run is a time-out", { skip: !POSIX }, async () => {
  // The first item times out (at its limit); the second fails by itself at
  // once. The run halts on the first, in item order: a timed-out run.
  const first = await run(FAN_OUT(1), "t7a", {});
  assert.equal(first.state.status, RunStatus.FAILED);
  assert.match(first.state.error, /^timeout: step work:unit:0 exceeded 4s/);
  assert.equal(first.state.timedOut, true);
  assert.equal(first.events.find((e) => e.type === "run_failed").timed_out, true);

  // The other way round: the first item fails by itself, the second times
  // out later. The run reports the first item's failure and is NOT marked as
  // a time-out, even though the time-out was the last failure in time.
  const second = await run(FAN_OUT(2), "t7b", {});
  assert.equal(second.state.status, RunStatus.FAILED);
  assert.match(second.state.error, /Agent step 'work:unit:0' exited with code 2\./);
  assert.equal(second.state.timedOut, false);
  assert.equal("timed_out" in second.events.find((e) => e.type === "run_failed"), false);
});
