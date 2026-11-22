// A run that throws exits with the "failed" code, not the generic 1 (SF-FIX-21).
//
// Before: when the engine threw while executing a step (for example an unknown
// template filter, which `workflow validate` does not catch), the run was
// saved as failed and `run_failed` was emitted, but the command returned 1.
// The Argo lane retries exit 1, so a deterministic error ran four times.
//
// Contract pinned here:
//   X1  `workflow run` of a workflow that throws exits 10; the run is saved
//       as failed and `run_failed` is on the event stream.
//   X2  `workflow resume` of that run throws again and exits 10.
//   X3  A command that never started a run keeps exit 1 (unknown workflow,
//       unknown run id).
// (X4 and X5, the classifier and the engine's tag, are in
// workflow-thrown-exit-classify.test.mjs. This file imports nothing new, so
// on the code before the fix it fails on the exit code itself.)
//
// The scripts use only `echo`, so the suite runs on Windows too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, validateWorkflow } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "adlc-cli.mjs");

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

// Valid for `workflow validate`, throws at run time: `upper` is not a filter.
const THROWS = `schema_version: "1.0"
workflow:
  id: throws
  name: Throws
  version: "1.0.0"
inputs:
  who: {type: string, default: "x"}
steps:
  - id: first
    type: shell
    run: "echo first"
  - id: bad
    type: shell
    run: "echo {{ inputs.who | upper }}"
`;
const FAILS = `schema_version: "1.0"
workflow:
  id: fails
  name: Fails
  version: "1.0.0"
steps:
  - id: bad
    type: shell
    run: "exit 4"
`;

function project(yaml) {
  const dir = tempDir("thrown-exit-");
  const wf = join(dir, "wf.yml");
  writeFileSync(wf, yaml, "utf-8");
  return { dir, wf };
}

function cli(dir, args) {
  const env = { ...process.env };
  delete env.ADLC_WORKFLOW_RUN_ID;
  return spawnSync(process.execPath, [CLI, "workflow", ...args], { cwd: dir, encoding: "utf-8", env, timeout: 60_000 });
}

function events(stdout) {
  return stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}

function savedState(dir) {
  const runs = join(dir, ".adlc", "workflows", "runs");
  const [runId] = readdirSync(runs);
  return JSON.parse(readFileSync(join(runs, runId, "state.json"), "utf-8"));
}

test("X1: a workflow that throws exits with the failed code (10), not 1", () => {
  const { dir, wf } = project(THROWS);
  assert.deepEqual(
    validateWorkflow(new WorkflowEngine(dir).loadWorkflow(wf), STEP_REGISTRY), [],
    "fixture: validation does not catch the unknown filter, so the lane would start this run",
  );
  const r = cli(dir, ["run", wf, "--format", "json"]);
  assert.equal(r.status, 10, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const failed = events(r.stdout).find((e) => e.type === "run_failed");
  assert.ok(failed, "run_failed is emitted");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /unknown filter 'upper'/);
  const state = savedState(dir);
  assert.equal(state.status, "failed");
  assert.equal(state.current_step_id, "bad");
  assert.equal(state.step_results.first.status, "completed");
});

test("X2: resuming a run that throws again exits 10 too", () => {
  const { dir, wf } = project(THROWS);
  cli(dir, ["run", wf, "--format", "json"]);
  const { run_id: runId } = savedState(dir);
  const r = cli(dir, ["resume", runId, "--format", "json"]);
  assert.equal(r.status, 10, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(savedState(dir).status, "failed");
});

test("X3: a command that never started a run keeps exit 1", () => {
  const { dir } = project(THROWS);
  assert.equal(cli(dir, ["run", "no-such-workflow", "--format", "json"]).status, 1);
  assert.equal(cli(dir, ["resume", "nosuchrun", "--format", "json"]).status, 1);
});

test("X3: an ordinary failed step is unchanged (exit 10), as is a completed run (exit 0)", () => {
  const failing = project(FAILS);
  assert.equal(cli(failing.dir, ["run", failing.wf, "--format", "json"]).status, 10);
  const ok = project(FAILS.replace("exit 4", "echo ok"));
  assert.equal(cli(ok.dir, ["run", ok.wf, "--format", "json"]).status, 0);
});
