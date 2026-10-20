// Agent-step run context and structured output (ADR-444, adlc-workspace#26).
//
// Contract pinned here:
//   O1  `command`/`prompt` agent steps run with ADLC_RUN_ID, ADLC_STEP_ID,
//       ADLC_STEP_OUTPUT (<root>/.adlc/workflows/runs/<run>/steps/<step>.output.json)
//       and ADLC_ISSUE_REF (only with a string `issue_ref` input).
//   O2  After exit 0, a JSON object in ADLC_STEP_OUTPUT is merged into the step
//       output when every entry is valid: key ^[a-z][a-z0-9_]{0,39}$, string
//       value <= 2048 chars, <= 16 entries, no reserved key. Anything else
//       (array, unparsable, reserved key, too many, too long, non-string)
//       merges nothing. A failed step merges nothing.
//   O3  The file is removed before the step runs (no stale value).
//   O4  The bundled `factory` workflow's intent gates link the intent step's
//       mr_url, and a context gate surfaces it as mr_link.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { getBuiltinWorkflow } from "../src/workflow/builtins.mjs";

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

// A fake `opencode` on PATH: dumps the ADLC_* env it received to $FAKE_DUMP,
// writes $FAKE_OUTPUT (raw text) to $ADLC_STEP_OUTPUT when set, exits $FAKE_EXIT.
function installFakeAgent() {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const pick = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ADLC_")));
if (process.env.FAKE_DUMP) fs.writeFileSync(process.env.FAKE_DUMP, JSON.stringify(pick));
if (process.env.FAKE_OUTPUT !== undefined && process.env.ADLC_STEP_OUTPUT) {
  fs.mkdirSync(require("node:path").dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
  fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, process.env.FAKE_OUTPUT);
}
console.log(JSON.stringify({ type: "text", text: "ok" }));
process.exit(Number(process.env.FAKE_EXIT || 0));
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
  const dir = tempDir("step-output-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function workflow(stepsYaml, inputs = "  issue_ref: {type: string, default: \"\"}\n") {
  const path = join(tempDir("step-output-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: so-wf
  name: Step Output
  version: "1.0.0"
  integration: opencode
inputs:
${inputs}steps:
${stepsYaml}`);
  return path;
}

const INTENT = `  - id: intent
    type: command
    command: factory-product
`;

async function runIntent({ output, exit = 0, inputs = { issue_ref: "g/p#26" }, pre } = {}) {
  const bin = installFakeAgent();
  const dir = project();
  const dump = join(tempDir("dump-"), "env.json");
  if (pre) pre(dir);
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DUMP: dump, FAKE_EXIT: String(exit) };
  if (output !== undefined) env.FAKE_OUTPUT = output;
  else delete process.env.FAKE_OUTPUT;
  return withEnv(env, async () => {
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(workflow(INTENT)), inputs, "r26", STEP_REGISTRY);
    const seen = existsSync(dump) ? JSON.parse(readFileSync(dump, "utf-8")) : null;
    return { dir, state, seen, out: state.stepResults.intent?.output ?? {} };
  });
}

const OUT_PATH = (dir) => join(dir, ".adlc", "workflows", "runs", "r26", "steps", "intent.output.json");

test("O1: agent steps see ADLC_RUN_ID, ADLC_STEP_ID, ADLC_STEP_OUTPUT, ADLC_ISSUE_REF", { skip: !POSIX }, async () => {
  const { dir, seen } = await runIntent({});
  assert.deepEqual(seen, {
    ADLC_RUN_ID: "r26",
    ADLC_STEP_ID: "intent",
    ADLC_STEP_OUTPUT: OUT_PATH(dir),
    ADLC_ISSUE_REF: "g/p#26",
  });
});

test("O1: no ADLC_ISSUE_REF without an issue_ref input", { skip: !POSIX }, async () => {
  const { seen } = await runIntent({ inputs: {} });
  assert.equal("ADLC_ISSUE_REF" in seen, false);
  assert.equal(seen.ADLC_RUN_ID, "r26");
});

test("O2: a valid output object is merged into the step output", { skip: !POSIX }, async () => {
  const { state, out } = await runIntent({ output: JSON.stringify({ mr_url: "https://gl.test/g/p/-/merge_requests/1", conclusion: "Two PDRs drafted." }) });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(out.mr_url, "https://gl.test/g/p/-/merge_requests/1");
  assert.equal(out.conclusion, "Two PDRs drafted.");
  assert.equal(out.exit_code, 0);
});

for (const [name, body] of [
  ["a reserved key", JSON.stringify({ mr_url: "u", stdout: "forged" })],
  ["an array", JSON.stringify(["mr_url"])],
  ["unparsable JSON", "{not json"],
  ["a non-string value", JSON.stringify({ mr_url: 1 })],
  ["a bad key", JSON.stringify({ "MR-URL": "u" })],
  ["too many keys", JSON.stringify(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])))],
  ["a value over 2048 chars", JSON.stringify({ mr_url: "x".repeat(2049) })],
]) {
  test(`O2: ${name} merges nothing`, { skip: !POSIX }, async () => {
    const { state, out } = await runIntent({ output: body });
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(out.mr_url, undefined);
    assert.notEqual(out.stdout, "forged");
    assert.equal(out.exit_code, 0);
  });
}

test("O2: a failed step merges nothing", { skip: !POSIX }, async () => {
  const { state, out } = await runIntent({ output: JSON.stringify({ mr_url: "u" }), exit: 1 });
  assert.equal(state.status, RunStatus.FAILED);
  assert.equal(out.mr_url, undefined);
});

test("O3: a stale output file is removed before the step runs", { skip: !POSIX }, async () => {
  const { out } = await runIntent({
    pre: (dir) => {
      mkdirSync(dirname(OUT_PATH(dir)), { recursive: true });
      writeFileSync(OUT_PATH(dir), JSON.stringify({ mr_url: "https://stale.example/x" }));
    },
  });
  assert.equal(out.mr_url, undefined);
});

test("O4: the factory workflow's intent gates link the intent step's mr_url", () => {
  const yaml = getBuiltinWorkflow("factory").yaml;
  assert.match(yaml, /- id: gate-product[\s\S]*?link: "\{\{ steps\.intent-product\.output\.mr_url \}\}"[\s\S]*?- id: intent-architecture/);
  assert.match(yaml, /- id: gate-architecture[\s\S]*?link: "\{\{ steps\.intent-architecture\.output\.mr_url \}\}"[\s\S]*?- id: execute/);
});

test("O4: a context gate surfaces the intent step's mr_url as mr_link", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  const steps = INTENT + `  - id: gate
    type: gate
    message: "Approve PDRs?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
    context:
      records: [".adlc/drafts/pdr/*.md"]
      since: last_approved
      link: "{{ steps.intent.output.mr_url }}"
`;
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_OUTPUT: JSON.stringify({ mr_url: "https://gl.test/g/p/-/merge_requests/9" }), FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    const events = [];
    engine.onEvent = (e) => events.push(e);
    const wf = workflow(steps, "  issue_ref: {type: string, default: \"\"}\n  verdict: {type: string, default: \"\"}\n");
    const state = await engine.execute(engine.loadWorkflow(wf), { verdict: "" }, "r26", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    const paused = events.find((e) => e.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/9");
  });
});
