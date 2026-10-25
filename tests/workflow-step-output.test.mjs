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
//   O3  The file is removed before the step runs (no stale value); a run or
//       step id that is not path-safe gets no ADLC_STEP_OUTPUT at all.
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

test("O4: the factory workflow publishes after each intent step and its gates link the publish step's mr_url", () => {
  const yaml = getBuiltinWorkflow("factory").yaml;
  assert.match(yaml, /- id: intent-product[\s\S]*?- id: publish-product\n\s+type: shell[\s\S]*?- id: gate-product[\s\S]*?link: "\{\{ steps\.publish-product\.output\.mr_url \}\}"/);
  assert.match(yaml, /- id: intent-architecture[\s\S]*?- id: publish-architecture\n\s+type: shell[\s\S]*?- id: gate-architecture[\s\S]*?link: "\{\{ steps\.publish-architecture\.output\.mr_url \}\}"/);
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

test("O3: a step id that is not path-safe gets no output file (nothing deleted or read outside steps/)", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const dump = join(tempDir("dump-"), "env.json");
  // Would resolve to <root>/.adlc/workflows/runs/victim.output.json.
  const victim = join(dir, ".adlc", "workflows", "runs", "victim.output.json");
  mkdirSync(dirname(victim), { recursive: true });
  writeFileSync(victim, "keep me");
  const steps = `  - id: "../../victim"
    type: command
    command: factory-product
`;
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_DUMP: dump, FAKE_EXIT: "0", FAKE_OUTPUT: JSON.stringify({ mr_url: "u" }) }, async () => {
    const engine = new WorkflowEngine(dir);
    await engine.execute(engine.loadWorkflow(workflow(steps)), { issue_ref: "g/p#26" }, "r26", STEP_REGISTRY);
  });
  const seen = JSON.parse(readFileSync(dump, "utf-8"));
  assert.equal("ADLC_STEP_OUTPUT" in seen, false);
  assert.equal(readFileSync(victim, "utf-8"), "keep me");
});

test("O5: the factory workflow declares issue_ref and dispatch, so its intent step sees ADLC_ISSUE_REF", { skip: !POSIX }, async () => {
  // The runtime passes these as --input; undeclared inputs are dropped, which
  // left ADLC_ISSUE_REF unset in real factory runs (run branch keyed on the run
  // id, no issue on the MR, no issue_ref check on restore).
  const bin = installFakeAgent();
  const dir = project();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  // The built-in workflow names no integration; the project's agent supplies it.
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
  const dump = join(tempDir("dump-"), "env.json");
  const wf = join(tempDir("factory-wf-"), "workflow.yml");
  writeFileSync(wf, getBuiltinWorkflow("factory").yaml);
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_DUMP: dump, FAKE_EXIT: "0" }, async () => {
    delete process.env.FAKE_OUTPUT;
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(wf), { issue_ref: "g/p#12", dispatch: "supervised", verdict: "" }, "r12", STEP_REGISTRY);
    assert.equal(state.inputs.issue_ref, "g/p#12");
    assert.equal(state.inputs.dispatch, "supervised");
    const seen = JSON.parse(readFileSync(dump, "utf-8"));
    assert.equal(seen.ADLC_ISSUE_REF, "g/p#12");
    assert.equal(seen.ADLC_STEP_ID, "intent-product");
  });
});

test("O5: the factory workflow still runs without an issue (no ADLC_ISSUE_REF)", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  // The built-in workflow names no integration; the project's agent supplies it.
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
  const dump = join(tempDir("dump-"), "env.json");
  const wf = join(tempDir("factory-wf-"), "workflow.yml");
  writeFileSync(wf, getBuiltinWorkflow("factory").yaml);
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_DUMP: dump, FAKE_EXIT: "0" }, async () => {
    delete process.env.FAKE_OUTPUT;
    const engine = new WorkflowEngine(dir);
    await engine.execute(engine.loadWorkflow(wf), { verdict: "" }, "r13", STEP_REGISTRY);
    const seen = JSON.parse(readFileSync(dump, "utf-8"));
    assert.equal("ADLC_ISSUE_REF" in seen, false);
  });
});


// ── shell steps get the run context (ADR-444 §5) ────────────────────────────

const DUMP_ENV_JS = `const fs=require('fs');fs.writeFileSync(process.env.FAKE_DUMP,JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('ADLC_')))));if(process.env.FAKE_OUTPUT!==undefined&&process.env.ADLC_STEP_OUTPUT){fs.mkdirSync(require('path').dirname(process.env.ADLC_STEP_OUTPUT),{recursive:true});fs.writeFileSync(process.env.ADLC_STEP_OUTPUT,process.env.FAKE_OUTPUT)}`;

async function runShell({ output, pre } = {}) {
  const dir = project();
  const dump = join(tempDir("dump-"), "env.json");
  const script = join(tempDir("shell-js-"), "dump.js");
  writeFileSync(script, DUMP_ENV_JS);
  if (pre) pre(dir);
  const env = { FAKE_DUMP: dump };
  if (output !== undefined) env.FAKE_OUTPUT = output;
  return withEnv(env, async () => {
    if (output === undefined) delete process.env.FAKE_OUTPUT;
    const steps = `  - id: publish
    type: shell
    run: node ${JSON.stringify(script)}
`;
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(workflow(steps)), { issue_ref: "g/p#26" }, "r26", STEP_REGISTRY);
    return { dir, state, seen: JSON.parse(readFileSync(dump, "utf-8")), out: state.stepResults.publish?.output ?? {} };
  });
}

test("O6: shell steps see ADLC_RUN_ID, ADLC_STEP_ID, ADLC_STEP_OUTPUT, ADLC_ISSUE_REF", { skip: !POSIX }, async () => {
  const { dir, seen } = await runShell({});
  assert.equal(seen.ADLC_RUN_ID, "r26");
  assert.equal(seen.ADLC_STEP_ID, "publish");
  assert.equal(seen.ADLC_STEP_OUTPUT, join(dir, ".adlc", "workflows", "runs", "r26", "steps", "publish.output.json"));
  assert.equal(seen.ADLC_ISSUE_REF, "g/p#26");
});

test("O6: a shell step's valid output object is merged; reserved keys are not", { skip: !POSIX }, async () => {
  const { out } = await runShell({ output: JSON.stringify({ mr_url: "https://gl.test/g/p/-/merge_requests/9" }) });
  assert.equal(out.mr_url, "https://gl.test/g/p/-/merge_requests/9");
  assert.equal(out.exit_code, 0);
  const bad = await runShell({ output: JSON.stringify({ exit_code: "9", mr_url: "x" }) });
  assert.equal(bad.out.exit_code, 0);
  assert.equal(bad.out.mr_url, undefined);
});

test("O6: a stale shell step output file is removed before the step runs", { skip: !POSIX }, async () => {
  const { out } = await runShell({
    pre: (dir) => {
      const p = join(dir, ".adlc", "workflows", "runs", "r26", "steps", "publish.output.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ mr_url: "stale" }));
    },
  });
  assert.equal(out.mr_url, undefined);
});

// ── the factory workflow publishes itself (ADR-431-amendment §3a) ───────────

// Default run-branch helper: switch to (or create) the issue's run branch.
const RUN_BRANCH_HELPER = `#!/usr/bin/env bash
git switch -q factory/intent/p-12 2>/dev/null || git switch -q -c factory/intent/p-12
echo factory/intent/p-12
`;

async function runFactory({ helper, runBranch = RUN_BRANCH_HELPER, beforeResume } = {}) {
  const bin = installFakeAgent();
  const dir = project();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
  if (helper !== undefined) {
    const h = join(dir, ".agents", "skills", "factory-mission", "scripts", "bash", "open-mr.sh");
    mkdirSync(dirname(h), { recursive: true });
    writeFileSync(h, helper);
    if (runBranch) writeFileSync(join(dirname(h), "run-branch.sh"), runBranch);
  }
  const wf = join(tempDir("factory-wf-"), "workflow.yml");
  writeFileSync(wf, getBuiltinWorkflow("factory").yaml);
  return withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "0" }, async () => {
    delete process.env.FAKE_OUTPUT;
    delete process.env.FAKE_DUMP;
    const engine = new WorkflowEngine(dir);
    const events = [];
    engine.onEvent = (e) => events.push(e);
    const state = await engine.execute(engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "r12", STEP_REGISTRY);
    const paused = events.find((e) => e.type === "gate_paused");
    if (!beforeResume) return { state, paused, dir };
    beforeResume(dir);
    const resumed = await new WorkflowEngine(dir).resume("r12", { verdict: "approve" }, STEP_REGISTRY);
    return { state, paused, dir, resumed };
  });
}

test("O7: the factory workflow links the MR even when the orchestrator never calls open-mr", { skip: !POSIX }, async () => {
  // The fake agent writes no step output; only the engine's publish step runs open-mr.
  const helper = `#!/usr/bin/env bash
[ -n "$ADLC_RUN_ID" ] && [ "$ADLC_STEP_ID" = publish-product ] || exit 9
printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/45"}' > "$ADLC_STEP_OUTPUT"
echo https://gl.test/g/p/-/merge_requests/45
`;
  const { state, paused } = await runFactory({ helper });
  assert.equal(state.status, RunStatus.PAUSED);
  assert.equal(state.stepResults["publish-product"].output.mr_url, "https://gl.test/g/p/-/merge_requests/45");
  assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/45");
});

test("O7: without the open-mr helper the publish step is skipped and the gate has no link", { skip: !POSIX }, async () => {
  const { state, paused } = await runFactory({});
  assert.equal(state.status, RunStatus.PAUSED);
  assert.equal(state.stepResults["publish-product"].status, "completed");
  assert.match(state.stepResults["publish-product"].output.skipped, /publish: skipped run-branch\.sh, open-mr\.sh/);
  assert.ok(!paused.mr_link);
});

test("O7: a refusing open-mr fails the run (fail-closed)", { skip: !POSIX }, async () => {
  const { state } = await runFactory({ helper: "#!/usr/bin/env bash\necho 'open-mr: tracker token lacks the api scope' >&2\nexit 2\n" });
  assert.equal(state.status, RunStatus.FAILED);
});

test("O7: a refusing open-mr's stderr is in the step error", { skip: !POSIX }, async () => {
  const { state } = await runFactory({ helper: "#!/usr/bin/env bash\necho 'open-mr: tracker token lacks the api scope' >&2\nexit 2\n" });
  assert.match(state.stepResults["publish-product"].error, /exited with code 2\. stderr: open-mr: tracker token lacks the api scope/);
});

// ── the engine owns the run branch (ADR-431-amendment §1) ───────────────────

// open-mr as shipped: refuses anything but an intent run branch.
const STRICT_OPEN_MR = `#!/usr/bin/env bash
b="$(git rev-parse --abbrev-ref HEAD)"
case "$b" in factory/intent/*) ;; *) echo "open-mr: not on an intent run branch (factory/intent/*): '$b'" >&2; exit 2 ;; esac
printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/45"}' > "$ADLC_STEP_OUTPUT"
`;

test("O8: the factory workflow checks out the run branch before the first agent step", { skip: !POSIX }, async () => {
  const { state, dir } = await runFactory({ helper: STRICT_OPEN_MR });
  const ids = Object.keys(state.stepResults);
  assert.equal(ids[0], "run-branch");
  assert.equal(state.stepResults["run-branch"].status, "completed");
  assert.ok(ids.indexOf("run-branch") < ids.indexOf("intent-product"));
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim(), "factory/intent/p-12");
});

test("O8: publish switches to the run branch even when the intent step left the base branch checked out", { skip: !POSIX }, async () => {
  // adlc-workspace#12 drill (run 3833ce28): an intent step that changed nothing
  // returned on the base branch and open-mr refused it. The engine's run-branch
  // step only runs once, so simulate the agent switching back to the base.
  const runBranch = `#!/usr/bin/env bash
if [ "$ADLC_STEP_ID" = run-branch ]; then git switch -q -c factory/intent/p-12 && git switch -q - ; exit 0; fi
git switch -q factory/intent/p-12
`;
  const { state, paused } = await runFactory({ helper: STRICT_OPEN_MR, runBranch });
  assert.equal(state.stepResults["publish-product"].status, "completed");
  assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/45");
});

test("O8: a missing run-branch helper is skipped and reported; open-mr still fails closed off the run branch", { skip: !POSIX }, async () => {
  const { state } = await runFactory({ helper: STRICT_OPEN_MR, runBranch: null });
  assert.equal(state.stepResults["run-branch"].status, "completed");
  assert.match(state.stepResults["run-branch"].output.skipped, /run-branch: skipped run-branch\.sh/);
  assert.equal(state.stepResults["publish-product"].status, "failed");
  assert.match(state.stepResults["publish-product"].error, /not on an intent run branch/);
});

test("O8: a resumed run checks out the run branch again before intent-architecture", { skip: !POSIX }, async () => {
  // A parked run restored into a fresh clone starts on the base branch; resume
  // continues after gate-product and never re-runs the first run-branch step.
  let base;
  const { state, resumed, dir } = await runFactory({
    helper: STRICT_OPEN_MR,
    beforeResume: (d) => {
      base = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: d }).toString().trim();
      execFileSync("git", ["switch", "-q", "--detach", base], { cwd: d });
    },
  });
  assert.equal(state.status, RunStatus.PAUSED);
  assert.ok(base);
  assert.equal(resumed.stepResults["run-branch-architecture"].status, "completed");
  const ids = Object.keys(resumed.stepResults);
  assert.ok(ids.indexOf("run-branch-architecture") < ids.indexOf("intent-architecture"));
  assert.equal(resumed.stepResults["publish-architecture"].status, "completed");
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).toString().trim(), "factory/intent/p-12");
});

test("O7: a failed shell step's persisted state holds no raw credential", { skip: !POSIX }, async () => {
  // state.json is what parkRun pushes to refs/factory-runs/<run_id> on the remote.
  const helper = "#!/usr/bin/env bash\necho 'fatal: token glpat-EXAMPLE1234567890 rejected' >&2\necho 'out glpat-EXAMPLE1234567890'\nexit 2\n";
  const { state, dir } = await runFactory({ helper });
  const r = state.stepResults["publish-product"];
  assert.doesNotMatch(r.output.stderr, /glpat-/);
  assert.doesNotMatch(r.output.stdout, /glpat-/);
  const raw = readFileSync(join(dir, ".adlc", "workflows", "runs", "r12", "state.json"), "utf8");
  assert.doesNotMatch(raw, /glpat-EXAMPLE1234567890/);
  assert.match(raw, /fatal: token \*\*\* rejected/);
});

test("O7: a failed step's stderr is redacted before it reaches the error", { skip: !POSIX }, async () => {
  const helper = `#!/usr/bin/env bash
echo "fatal: unable to access 'https://oauth2:glpat-abcdefghij1234567890@gl.test/g/p.git/': 403" >&2
echo "token in env: $FAKE_SECRET_TOKEN" >&2
echo "PRIVATE-TOKEN: glpat-zyxwvutsrq0987654321" >&2
exit 2
`;
  const { state } = await withEnv({ FAKE_SECRET_TOKEN: "s3cr3t-value-123456" }, () => runFactory({ helper }));
  const err = state.stepResults["publish-product"].error;
  assert.match(err, /exited with code 2\. stderr: /);
  assert.doesNotMatch(err, /glpat-|s3cr3t-value-123456|oauth2:/);
  assert.match(err, /https:\/\/\*\*\*@gl\.test/);
});

test("redactSecrets masks URL userinfo, token formats and secret env values", async () => {
  const { redactSecrets } = await import("../src/workflow/steps/shell.mjs");
  const env = { GITLAB_TOKEN: "plain-secret-abcdef", HOME: "/home/runner-long-path" };
  assert.equal(redactSecrets("push https://u:p@h/x failed", env), "push https://***@h/x failed");
  assert.equal(redactSecrets("bot xoxb-1234567890-abcdefghij", env), "bot ***");
  assert.equal(redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234 leaked", env), "*** leaked");
  assert.equal(redactSecrets("value plain-secret-abcdef here", env), "value *** here");
  assert.equal(redactSecrets("cwd /home/runner-long-path", env), "cwd /home/runner-long-path");
  assert.equal(redactSecrets("Authorization: Bearer abc.def", env), "Authorization: Bearer ***");
  assert.equal(redactSecrets("Authorization: token ghx_short", env), "Authorization: token ***");
  assert.equal(redactSecrets("authorization: Bot opaque-value", env), "authorization: Bot ***");
  assert.equal(redactSecrets("Authorization: opaque123 trailing", env), "Authorization: ***");
  assert.equal(redactSecrets("PRIVATE-TOKEN: abc123 extra\nnext line", env), "PRIVATE-TOKEN: ***\nnext line");
  assert.equal(
    redactSecrets("Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/x, Signature=deadbeef", env),
    "Authorization: ***",
  );
  assert.equal(redactSecrets('Authorization: Digest username="u", response="abc"', env), "Authorization: Digest ***");
  // A value on the next line (YAML, folded header) is masked too.
  assert.equal(redactSecrets("Authorization:\n  Bearer abc", env), "Authorization:\n  Bearer ***");
  assert.equal(redactSecrets("private-token:\r\n  glpat-free-form-x", env), "private-token:\r\n  ***");
  // A scheme with no value masks the scheme word and leaves the next line alone.
  assert.equal(redactSecrets("Authorization: Bearer\nnext line", env), "Authorization: ***\nnext line");
  assert.equal(redactSecrets("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig", env), "jwt ***");
  assert.equal(redactSecrets("ff glffct-abcdefghij12345", env), "ff ***");
  assert.equal(redactSecrets("job opaque-jwt-value-1234", { CI_JOB_JWT_V2: "opaque-jwt-value-1234" }), "job ***");
});

// ── the execute step gets the issue and links its code MR ───────────────────

// Records each agent step's prompt; the execute step reports a code MR.
function installExecuteFake() {
  const bin = tempDir("fake-exec-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const step = process.env.ADLC_STEP_ID || "";
if (process.env.FAKE_PROMPTS) fs.appendFileSync(process.env.FAKE_PROMPTS, JSON.stringify({ step, argv: process.argv.slice(2) }) + "\\n");
if (step === "execute" && process.env.ADLC_STEP_OUTPUT) {
  fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
  fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, JSON.stringify({ mr_url: "https://gl.test/g/argo/-/merge_requests/38" }));
}
console.log(JSON.stringify({ type: "text", text: "ok" }));
`);
  chmodSync(script, 0o755);
  return bin;
}

test("O9: execute runs factory-mission with the run's issue, and gate-completion links its MR", { skip: !POSIX }, async () => {
  const bin = installExecuteFake();
  const dir = project();
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
  const prompts = join(tempDir("prompts-"), "prompts.jsonl");
  const wf = join(tempDir("factory-wf-"), "workflow.yml");
  writeFileSync(wf, getBuiltinWorkflow("factory").yaml);
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_PROMPTS: prompts }, async () => {
    const inputs = { issue_ref: "g/p#12", verdict: "" };
    const e1 = new WorkflowEngine(dir);
    const s1 = await e1.execute(e1.loadWorkflow(wf), inputs, "r9", STEP_REGISTRY);
    assert.equal(s1.currentStepId, "gate-product");
    const s2 = await new WorkflowEngine(dir).resume("r9", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(s2.currentStepId, "gate-architecture");
    const e3 = new WorkflowEngine(dir);
    const events = [];
    e3.onEvent = (ev) => events.push(ev);
    const s3 = await e3.resume("r9", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(s3.currentStepId, "gate-completion");
    assert.equal(s3.stepResults.execute.output.mr_url, "https://gl.test/g/argo/-/merge_requests/38");
    const paused = events.find((ev) => ev.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/argo/-/merge_requests/38");
  });
  const exec = readFileSync(prompts, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((p) => p.step === "execute");
  assert.ok(exec.argv.some((a) => a.includes("/factory-mission --issue g/p#12")), JSON.stringify(exec.argv));
});

