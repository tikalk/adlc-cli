// Shell step `env:` — the safe way to hand a script a value that came from
// an input or an earlier step (second review of SF-LANE-05, 2026-11-21).
//
// A templated value inside `run` is pasted into the script as text, so a quote
// in it ends the string and the rest runs as a command. A value under `env:`
// is exported as an environment variable and is only ever data.
//
// The scripts here are `node -e "…"` with no `$`, so they run the same under
// sh and under cmd.exe (the CI matrix includes Windows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepContext, StepStatus } from "../src/workflow/base.mjs";
import { ShellStep } from "../src/workflow/steps/shell.mjs";
import { WorkflowEngine, RunStatus, validateWorkflow } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";

const PRINT = `node -e "process.stdout.write(JSON.stringify({v:process.env.VALUE,n:process.env.COUNT,f:process.env.FLAG,m:process.env.MISSING||''}))"`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "wf-shell-env-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function contextFor(dir, steps = {}, inputs = {}) {
  return new StepContext({ inputs, steps, projectRoot: dir, runId: "envrun01" });
}

test("env: a value with quotes, $(…) and backticks arrives verbatim and nothing in it runs", async () => {
  const { dir, cleanup } = project();
  try {
    const marker = join(dir, "injected.txt");
    const hostile = `x'; echo INJECTED > injected.txt; echo '" && echo INJECTED > injected.txt & $(touch injected.txt) \`touch injected.txt\``;
    const steps = { execute: { output: { mr_url: hostile } } };
    const result = await new ShellStep().execute(
      { id: "show", run: PRINT, env: { VALUE: "{{ steps.execute.output.mr_url }}" } },
      contextFor(dir, steps),
    );
    assert.equal(result.status, StepStatus.COMPLETED, result.error ?? "");
    assert.equal(JSON.parse(result.output.stdout).v, hostile);
    assert.equal(existsSync(marker), false, "nothing from the value was executed");
  } finally {
    cleanup();
  }
});

test("env: numbers and booleans become text; a value an earlier step never reported is empty", async () => {
  const { dir, cleanup } = project();
  try {
    const result = await new ShellStep().execute(
      { id: "show", run: PRINT, env: { VALUE: "plain", COUNT: 3, FLAG: true, MISSING: "{{ steps.execute.output.mr_url }}" } },
      contextFor(dir, { execute: { output: {} } }),
    );
    assert.equal(result.status, StepStatus.COMPLETED, result.error ?? "");
    assert.deepEqual(JSON.parse(result.output.stdout), { v: "plain", n: "3", f: "true", m: "" });
  } finally {
    cleanup();
  }
});

test("env: an input is passed the same way", async () => {
  const { dir, cleanup } = project();
  try {
    const result = await new ShellStep().execute(
      { id: "show", run: PRINT, env: { VALUE: "issue {{ inputs.issue_ref }}" } },
      contextFor(dir, {}, { issue_ref: "g/p#1'; exit 9; '" }),
    );
    assert.equal(result.status, StepStatus.COMPLETED, result.error ?? "");
    assert.equal(JSON.parse(result.output.stdout).v, "issue g/p#1'; exit 9; '");
  } finally {
    cleanup();
  }
});

test("env: the engine's own ADLC_* variables cannot be overridden", async () => {
  const { dir, cleanup } = project();
  try {
    for (const name of ["ADLC_STEP_OUTPUT", "ADLC_RUN_ID", "adlc_issue_ref"]) {
      const config = { id: "bad", run: PRINT, env: { [name]: "x" } };
      assert.match(new ShellStep().validate(config).join(" "), /is reserved \(ADLC_\* is set by the engine\)/);
      const result = await new ShellStep().execute(config, contextFor(dir));
      assert.equal(result.status, StepStatus.FAILED, "an invalid env fails the step, it is not ignored");
      assert.match(result.error, /is reserved/);
    }
  } finally {
    cleanup();
  }
});

test("env: malformed mappings are validation errors", () => {
  const errors = (env) => new ShellStep().validate({ id: "bad", run: "echo ok", env }).join(" ");
  assert.match(errors(["A=1"]), /'env' must be a mapping of variable names to values, got list/);
  assert.match(errors("A=1"), /'env' must be a mapping/);
  assert.match(errors({ "MR-URL": "x" }), /'env' name "MR-URL" must match/);
  assert.match(errors({ "1X": "x" }), /must match/);
  assert.match(errors({ LIST: ["a"] }), /'env' value of "LIST" must be a string, number or boolean, got list/);
  assert.equal(errors({ MR_URL: "{{ steps.execute.output.mr_url }}", N: 1, B: false, E: null }), "");
  assert.equal(new ShellStep().validate({ id: "ok", run: "echo ok" }).join(" "), "", "env stays optional");
});

test("env: a workflow file with a bad env is rejected by `workflow validate`, and works end to end when valid", async () => {
  const { dir, cleanup } = project();
  try {
    const yaml = (env) => `schema_version: "1.0"
workflow: { id: env-demo, name: Env demo, version: "1.0.0" }
inputs:
  who: { type: string, default: "" }
steps:
  - id: show
    type: shell
    env:
      ${env}
    run: ${JSON.stringify(PRINT)}
`;
    const engine = new WorkflowEngine(dir);
    const load = (name, text) => {
      const path = join(dir, name);
      writeFileSync(path, text, "utf-8");
      return engine.loadWorkflow(path);
    };
    const bad = await load("bad.yml", yaml(`ADLC_STEP_OUTPUT: "/tmp/x"`));
    assert.match(validateWorkflow(bad, STEP_REGISTRY).join(" "), /is reserved/);
    const good = await load("good.yml", yaml(`VALUE: "{{ inputs.who }}"`));
    assert.deepEqual(validateWorkflow(good, STEP_REGISTRY), []);
    const state = await engine.execute(good, { who: "it's \"me\"" }, "envrun02", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(JSON.parse(state.stepResults.show.output.stdout).v, "it's \"me\"");
  } finally {
    cleanup();
  }
});
