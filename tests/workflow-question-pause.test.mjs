// Question payload: an agent step that leaves a valid
// runs/<run_id>/questions/<step_id>.json pauses with kind=question
// (adlc-workspace#148).
//
//   Q1  valid payload → StepStatus.PAUSED, output {kind: question,
//       answer_input: answer_<step>, payload, head_sha}; engine emits
//       gate_paused with kind: question. Step env includes ADLC_STEP_QUESTION.
//   Q2  resume with answer_<step> input re-runs the step with ADLC_STEP_ANSWERS
//       pointing at runs/<run_id>/answers/<step_id>.json.
//   Q3  gate with verdict_input answer_* fails validation.
//   Q4  4th pause of the same step in one run → FAILED
//       "blocked: question budget exhausted".
//   Q5  invalid payload (bad JSON / wrong shape / >3 questions) → COMPLETED
//       with a warning.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";

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

// Fake agent: leaves FAKE_QUESTION (raw text) at $ADLC_STEP_QUESTION when set.
function installFakeAgent() {
  const bin = tempDir("fake-qagent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
if (process.env.FAKE_DUMP) fs.writeFileSync(process.env.FAKE_DUMP, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ADLC_")))));
if (process.env.FAKE_QUESTION !== undefined && process.env.ADLC_STEP_QUESTION) {
  fs.mkdirSync(path.dirname(process.env.ADLC_STEP_QUESTION), { recursive: true });
  fs.writeFileSync(process.env.ADLC_STEP_QUESTION, process.env.FAKE_QUESTION);
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
  const dir = tempDir("qpause-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

function workflow(stepsYaml, inputs = "  issue_ref: {type: string, default: \"\"}\n") {
  const path = join(tempDir("qpause-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: q-wf
  name: Q Pause
  version: "1.0.0"
  integration: opencode
inputs:
${inputs}steps:
${stepsYaml}`);
  return path;
}

const STEP = `  - id: ask
    type: command
    command: factory-mission
`;

const QUESTION = JSON.stringify({
  summary: "The brief does not name a color.",
  questions: [{ id: "q1", text: "Pick a color?" }],
});

test("Q1: valid payload pauses with kind=question and exposes ADLC_STEP_QUESTION", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const dump = join(tempDir("dump-"), "env.json");
  const events = [];
  const { state, seen, qpath } = await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_DUMP: dump, FAKE_QUESTION: QUESTION, FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    engine.onEvent = (e) => events.push(e);
    const s = await engine.execute(await engine.loadWorkflow(workflow(STEP)), { issue_ref: "g/p#148" }, "rq1", STEP_REGISTRY);
    const seen = existsSync(dump) ? JSON.parse(readFileSync(dump, "utf-8")) : {};
    return { state: s, seen, qpath: join(dir, ".adlc", "workflows", "runs", "rq1", "questions", "ask.json") };
  });
  assert.equal(state.status, RunStatus.PAUSED);
  assert.equal(existsSync(qpath), true);
  assert.equal(seen.ADLC_STEP_QUESTION, qpath);
  const out = state.stepResults.ask.output;
  assert.equal(out.kind, "question");
  assert.equal(out.answer_input, "answer_ask");
  assert.deepEqual(out.payload.questions[0].id, "q1");
  assert.ok(typeof out.head_sha === "string" && out.head_sha.length > 0);
  const paused = events.find((e) => e.type === "gate_paused");
  assert.ok(paused);
  assert.equal(paused.kind, "question");
  assert.equal(paused.step_id, "ask");
});

test("Q5: invalid payload completes the step", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const { state } = await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_QUESTION: "{not json", FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    const s = await engine.execute(await engine.loadWorkflow(workflow(STEP)), { issue_ref: "g/p#148" }, "rq5", STEP_REGISTRY);
    return { state: s };
  });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.stepResults.ask.output.kind, undefined);
});

test("Q5: more than 3 questions completes the step", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const big = JSON.stringify({ summary: "s", questions: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }, { id: "d", text: "4" }] });
  const { state } = await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_QUESTION: big, FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    const s = await engine.execute(await engine.loadWorkflow(workflow(STEP)), {}, "rq5b", STEP_REGISTRY);
    return { state: s };
  });
  assert.equal(state.status, RunStatus.COMPLETED);
});

test("Q3: gate with verdict_input answer_* fails validation", async () => {
  const dir = project();
  const engine = new WorkflowEngine(dir);
  const def = await engine.loadWorkflow(workflow(`  - id: g1
    type: gate
    message: "x"
    options: [approve, reject]
    on_reject: abort
    verdict_input: answer_ask
`, "  answer_ask: {type: string, default: \"\"}\n"));
  const errors = engine.validate(def, STEP_REGISTRY);
  assert.ok(errors.some((e) => e.includes("answer_")));
});

test("Q4: 4th pause of the same step fails with budget exhausted", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_QUESTION: QUESTION, FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    let state = await engine.execute(await engine.loadWorkflow(workflow(STEP, "  answer_ask: {type: string, default: \"\"}\n")), {}, "rq4", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    for (let i = 0; i < 3; i++) {
      state = await engine.resume("rq4", { answer_ask: `ans${i}` }, STEP_REGISTRY);
      if (i < 2) assert.equal(state.status, RunStatus.PAUSED);
    }
    assert.equal(state.status, RunStatus.FAILED);
    assert.match(state.error, /blocked: question budget exhausted/);
  });
});

test("Q2: resume with answer_ask re-runs the step with ADLC_STEP_ANSWERS", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const dump2 = join(tempDir("dump-"), "env2.json");
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_DUMP: dump2, FAKE_QUESTION: QUESTION, FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    let state = await engine.execute(await engine.loadWorkflow(workflow(STEP, "  answer_ask: {type: string, default: \"\"}\n")), {}, "rq2", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    delete process.env.FAKE_QUESTION;
    state = await engine.resume("rq2", { answer_ask: "blue" }, STEP_REGISTRY);
    const seen = JSON.parse(readFileSync(dump2, "utf-8"));
    assert.equal(seen.ADLC_STEP_ANSWERS, join(dir, ".adlc", "workflows", "runs", "rq2", "answers", "ask.json"));
    const answers = JSON.parse(readFileSync(join(dir, ".adlc", "workflows", "runs", "rq2", "answers", "ask.json"), "utf-8"));
    assert.ok(Array.isArray(answers) && answers.some((a) => a.text === "blue"));
    assert.equal(answers.length, 1);
    assert.equal(answers[0].question_id, "q1");
    // The step wrote no new question on the re-run, so the run completes:
    // the earlier pause's question file must not pause it again.
    assert.equal(state.status, RunStatus.COMPLETED);
  });
});

test("Q5: payload without summary completes the step with a warning", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const noSummary = JSON.stringify({ questions: [{ id: "q1", text: "Pick?" }] });
  const { state } = await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_QUESTION: noSummary, FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    const s = await engine.execute(await engine.loadWorkflow(workflow(STEP)), {}, "rq5c", STEP_REGISTRY);
    return { state: s };
  });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.match(state.stepResults.ask.output.question_warning, /missing summary/);
});

test("Q1b: paused payload keeps summary and resume_hint", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const q = JSON.stringify({ summary: "Gap.", resume_hint: "plan phase", questions: [{ id: "q1", text: "Pick?", options: ["a", "b"] }] });
  const { state } = await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_QUESTION: q, FAKE_EXIT: "0" }, async () => {
    const engine = new WorkflowEngine(dir);
    const s = await engine.execute(await engine.loadWorkflow(workflow(STEP)), {}, "rq1b", STEP_REGISTRY);
    return { state: s };
  });
  assert.equal(state.status, RunStatus.PAUSED);
  const p = state.stepResults.ask.output.payload;
  assert.equal(p.summary, "Gap.");
  assert.equal(p.resume_hint, "plan phase");
  assert.deepEqual(p.questions[0].options, ["a", "b"]);
});

test("Q1c: paused payload keeps an http(s) mr_url and drops anything else", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const run = async (mr, id) => {
    const dir = project();
    const q = JSON.stringify({ summary: "Gap.", mr_url: mr, questions: [{ id: "q1", text: "Pick?" }] });
    return withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_QUESTION: q, FAKE_EXIT: "0" }, async () => {
      const engine = new WorkflowEngine(dir);
      return engine.execute(await engine.loadWorkflow(workflow(STEP)), {}, id, STEP_REGISTRY);
    });
  };
  const ok = await run("https://gitlab.example/g/p/-/merge_requests/7", "rq1c-a");
  assert.equal(ok.status, RunStatus.PAUSED);
  assert.equal(ok.stepResults.ask.output.payload.mr_url, "https://gitlab.example/g/p/-/merge_requests/7");
  for (const [bad, id] of [["javascript:alert(1)", "rq1c-b"], ["not a url", "rq1c-c"], [42, "rq1c-d"]]) {
    const s = await run(bad, id);
    assert.equal(s.status, RunStatus.PAUSED, "a bad mr_url never blocks the pause");
    assert.equal("mr_url" in s.stepResults.ask.output.payload, false, String(bad));
  }
});
