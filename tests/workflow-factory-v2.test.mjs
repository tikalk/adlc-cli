// Bundled `factory` 2.1.0 (SF-LANE-05 + ADR-522 record gates): it calls only skills that exist in
// adlc-team-skills and fails closed. A run with no factory skills, no issue,
// or no merge request ends FAILED (CLI exit 10, never retried by the Argo
// lane) instead of "completed" with nothing done; a human reject ends FAILED,
// never ABORTED (exit 1, which the lane retries).
//
// The engine tests that need a multi-gate example keep the 1.0.0 shape as a
// fixture (tests/fixtures/workflows/factory-v1.yml).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus, validateWorkflow, headlessGateErrors } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { classifyWorkflowStatus } from "../src/exit-codes.mjs";

const POSIX = process.platform !== "win32";

// Skills the bundled workflow may call (adlc-team-skills skills/factory/).
// factory-product / factory-architect were removed on 2026-10-25.
const EXISTING_COMMANDS = new Set(["factory-intent", "factory-mission"]);
const STEP_IDS = [
  "preflight", "intent", "plan-link", "gate-intent", "gate-intent-decisions",
  "stop-if-plan-rejected", "run-branch-execute",
  "execute", "proof-of-work", "gate-completion", "stop-if-result-rejected",
];
const MR = "https://gitlab.example.com/g/p/-/merge_requests/7";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "wf-factory-v2-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}


// Approve the plan gate plus the single record gate in a non-git fixture
// project (the record gate sees "Decision list unavailable: not in a git
// work tree" and approves cleanly without a list, S1/T2). Returns the
// paused-or-finished state after the final resume.
async function approvePlanGates(engine, runId, extraInputs = {}) {
  let state = await engine.resume(runId, { verdict_intent: "approve" }, STEP_REGISTRY);
  let guard = 0;
  while (state.status === RunStatus.PAUSED && guard < 3) {
    guard++;
    const id = state.currentStepId;
    if (id !== "gate-intent" && id !== "gate-intent-decisions") break;
    state = await engine.resume(runId, { verdict_intent: "approve" }, STEP_REGISTRY);
  }
  return state;
}

function installSkills(dir) {
  for (const s of ["factory-intent", "factory-mission", "factory-runbook"]) {
    mkdirSync(join(dir, ".agents", "skills", s), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", s, "SKILL.md"), `# ${s}\n`);
  }
  const bash = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(bash, { recursive: true });
  for (const h of ["run-branch.sh", "open-mr.sh"]) writeFileSync(join(bash, h), "#!/usr/bin/env bash\n");
}

// The bundled YAML with every `command` step swapped for a shell stub, written
// to a file: resume re-reads the run's workflow.yml copy, so the stub has to be
// real YAML. `stubs` maps a skill name to the stub's shell lines.
function stubbedWorkflow(dir, stubs = {}) {
  const engine = new WorkflowEngine(dir);
  const yaml = engine.loadWorkflow("factory").sourceYaml ?? readFileSync(engine.loadWorkflow("factory").sourcePath, "utf-8");
  const out = yaml.replace(
    /^( {4})type: command\n {4}command: ([\w-]+)\n(?: {4}(?:#.*|timeout: \d+)\n)*(?: {4}input:\n {6}args: .*\n)?/gm,
    (_, i, cmd) => {
      const body = (stubs[cmd] ?? `echo ${cmd}`).split("\n").map((l) => `${i}  ${l}`).join("\n");
      return `${i}type: shell\n${i}run: |\n${body}\n`;
    },
  );
  assert.ok(!out.includes("type: command"), "fixture: every command step stubbed");
  assert.ok(!/^ {4}(input|timeout):/m.test(out), "fixture: the stubs carry no agent-step keys");
  const path = join(dir, "factory-stub.yml");
  writeFileSync(path, out, "utf-8");
  return { engine, def: engine.loadWorkflow(path) };
}

// A stub `execute` that reports the given step output (ADR-444 ADLC_STEP_OUTPUT).
function executeWrites(output) {
  return `cat > "$ADLC_STEP_OUTPUT" <<'JSON'\n${JSON.stringify(output)}\nJSON`;
}

// ADLC_ISSUE_REF comes from the issue_ref input; make sure the test process
// does not leak one in (e.g. when the suite runs inside a factory pod).
function withoutIssueEnv(fn) {
  return async () => {
    const saved = process.env.ADLC_ISSUE_REF;
    delete process.env.ADLC_ISSUE_REF;
    try {
      await fn();
    } finally {
      if (saved !== undefined) process.env.ADLC_ISSUE_REF = saved;
    }
  };
}

test("factory 2.1.0: valid, headless-valid, calls only existing skills, gates never abort", () => {
  const { dir, cleanup } = project();
  try {
    const def = new WorkflowEngine(dir).loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.version, "2.1.0");
    assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
    assert.deepEqual(headlessGateErrors(def), []);
    assert.deepEqual(def.steps.map((s) => s.id), STEP_IDS);
    for (const s of def.steps.filter((x) => x.type === "command")) {
      assert.ok(EXISTING_COMMANDS.has(s.command), `step ${s.id} calls ${s.command}, which adlc-team-skills does not ship`);
    }
    // A plan-gate reject ends FAILED (exit 10), never ABORTED (exit 1,
    // retried by the lane). The record gate is a scope-pinned context gate
    // (ADR-522; PR #111 review F1: one gate over both globs, so the product
    // approval cannot move `since` past records the architecture gate never
    // shows). It shares verdict_intent with gate-intent so one human plan
    // approval covers both plan gates, and it skips (never aborts) like the
    // other plan gates — a rejected record never reaches execute via
    // stop-if-plan-rejected.
    const gates = def.steps.filter((x) => x.type === "gate");
    assert.deepEqual(gates.map((g) => [g.id, g.on_reject, g.verdict_input]), [
      ["gate-intent", "skip", "verdict_intent"],
      ["gate-intent-decisions", "skip", "verdict_intent"],
      ["gate-completion", "skip", "verdict_completion"],
    ]);
    // Only the record gate declares `context`, on purpose: a context gate
    // binds the approval to the local HEAD, and the plan/completion gates
    // must survive a park-restore into a fresh clone ("head moved").
    for (const g of gates) {
      if (g.id === "gate-intent-decisions") {
        assert.ok("context" in g, `${g.id} declares context`);
      } else {
        assert.equal("context" in g, false, `${g.id} declares no context`);
      }
    }
    // Every agent step sets its time limit on purpose (the engine default,
    // 3600 s, killed a real mission at exactly one hour).
    assert.deepEqual(
      def.steps.filter((x) => x.type === "command").map((s) => [s.id, s.timeout]),
      [["intent", 3600], ["execute", 3600]],
    );
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: a workspace without the factory skills fails at preflight, before any agent step", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    const { engine, def } = stubbedWorkflow(dir);
    const state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2a0001", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(classifyWorkflowStatus(state.status).exitCode, 10);
    assert.equal(state.stepResults.preflight?.status, "failed");
    assert.match(state.stepResults.preflight.output.stderr, /preflight: missing: factory-intent factory-mission factory-runbook/);
    assert.equal(state.stepResults.intent, undefined, "no agent step ran");
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: skills without the factory-runbook helpers fail at preflight", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    rmSync(join(dir, ".agents", "skills", "factory-runbook", "scripts"), { recursive: true, force: true });
    const { engine, def } = stubbedWorkflow(dir);
    const state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2a0002", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.match(state.stepResults.preflight.output.stderr, /factory-runbook\/scripts\/bash\/run-branch\.sh factory-runbook\/scripts\/bash\/open-mr\.sh/);
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: a run without an issue fails at preflight", { skip: !POSIX }, withoutIssueEnv(async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const { engine, def } = stubbedWorkflow(dir);
    const state = await engine.execute(def, {}, "fv2b0001", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.match(state.stepResults.preflight.output.stderr, /preflight: missing: issue_ref-input/);
    assert.equal(state.stepResults.intent, undefined, "no agent step ran");
  } finally {
    cleanup();
  }
}));

test("factory 2.1.0: an approved plan whose execute reports no mr_url fails at proof-of-work", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const { engine, def } = stubbedWorkflow(dir);
    let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0001", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0001");
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(classifyWorkflowStatus(state.status).exitCode, 10);
    assert.equal(state.stepResults.execute?.status, "completed");
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
    assert.match(state.stepResults["proof-of-work"].output.stderr, /execute returned no merge request URL/);
    assert.equal(state.stepResults["gate-completion"], undefined, "the completion gate never asks about nothing");
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: an mr_url that is not a URL (e.g. 'none') fails at proof-of-work", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const { engine, def } = stubbedWorkflow(dir, {
      "factory-mission": executeWrites({ mr_url: "none", conclusion: "could not open the MR" }),
    });
    let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0002", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0002");
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: an mr_url carrying $(…) or backticks is refused and never run", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const marker = join(dir, "injected");
    const { engine, def } = stubbedWorkflow(dir, {
      "factory-mission": executeWrites({
        mr_url: `${MR}?$(touch ${marker})\`touch ${marker}\``,
        conclusion: "ok",
      }),
    });
    let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0003", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0003");
    assert.equal(existsSync(marker), false, "nothing from the step output was executed");
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
    assert.equal(state.status, RunStatus.FAILED);
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: a conclusion full of shell syntax is never run; a real MR URL passes", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const marker = join(dir, "injected");
    const { engine, def } = stubbedWorkflow(dir, {
      "factory-mission": executeWrites({
        mr_url: MR,
        conclusion: `opened "the MR" — it's done; ran \`touch ${marker}\` and $(touch ${marker})`,
      }),
    });
    let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0005", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0005");
    assert.equal(state.stepResults["proof-of-work"]?.status, "completed");
    assert.equal(existsSync(marker), false, "nothing from the step output was executed");
    assert.equal(state.status, RunStatus.PAUSED);
    assert.equal(state.currentStepId, "gate-completion");
  } finally {
    cleanup();
  }
});

for (const [what, value] of [
  ["any web page", "https://example.com"],
  ["a merge request URL with a query", `${MR}?x=1`],
  ["Slack control text", `${MR} <!channel>`],
  ["a disguised Slack link", "https://evil.example/x/-/merge_requests/1|https://gitlab.example.com/g/p/-/merge_requests/7"],
  ["a URL with user info", "https://user:pw@gitlab.example.com/g/p/-/merge_requests/7"],
]) {
  test(`factory 2.1.0: proof-of-work refuses ${what} as the merge request`, { skip: !POSIX }, async () => {
    const { dir, cleanup } = project();
    try {
      installSkills(dir);
      const { engine, def } = stubbedWorkflow(dir, { "factory-mission": executeWrites({ mr_url: value }) });
      let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0006", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0006");
      assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
      assert.equal(state.status, RunStatus.FAILED);
      assert.equal(state.stepResults["gate-completion"], undefined, "the value never reaches the approval message");
    } finally {
      cleanup();
    }
  });
}

test("factory 2.1.0: proof-of-work accepts a GitHub pull request URL", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const pr = "https://github.com/acme/widgets/pull/42";
    const { engine, def } = stubbedWorkflow(dir, { "factory-mission": executeWrites({ mr_url: pr }) });
    let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0007", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0007");
    assert.equal(state.stepResults["proof-of-work"]?.status, "completed");
    assert.ok(state.stepResults["gate-completion"].output.message.includes(pr));
  } finally {
    cleanup();
  }
});

// The plan gate's message is posted to Slack as written, so the plan link is
// checked first (plan-link) and anything that is not an MR URL is left out.
test("factory 2.1.0: the plan gate shows only a checked merge request link", { skip: !POSIX }, async () => {
  for (const [id, reported, shown] of [
    ["fv2g0001", "https://gitlab.example.com/g/p/-/merge_requests/6", "https://gitlab.example.com/g/p/-/merge_requests/6"],
    ["fv2g0002", "https://gitlab.example.com/g/p/-/merge_requests/6 <!channel> <https://evil.example|click>", "no merge request was opened"],
    ["fv2g0003", "'; touch injected; echo '", "no merge request was opened"],
    ["fv2g0004", undefined, "no merge request was opened"],
  ]) {
    const { dir, cleanup } = project();
    try {
      installSkills(dir);
      const { engine, def } = stubbedWorkflow(dir, reported === undefined ? {} : { "factory-intent": executeWrites({ mr_url: reported }) });
      const state = await engine.execute(def, { issue_ref: "g/p#1" }, id, STEP_REGISTRY);
      assert.equal(state.status, RunStatus.PAUSED, `${id}: the run still reaches the plan gate`);
      assert.equal(state.currentStepId, "gate-intent");
      assert.equal(state.stepResults["plan-link"]?.status, "completed", `${id}: plan-link never fails the run`);
      assert.equal(state.stepResults["gate-intent"].output.message, `Plan drafted for g/p#1: ${shown} — approve before implementation?`);
      assert.equal(existsSync(join(dir, "injected")), false);
    } finally {
      cleanup();
    }
  }
});

// Second review (2026-11-21): a single quote closed the shell string the first
// version put mr_url in, so the rest of the value ran as a command.
test("factory 2.1.0: a single quote in mr_url cannot break out into the shell", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const marker = join(dir, "injected.txt");
    const { engine, def } = stubbedWorkflow(dir, {
      "factory-mission": executeWrites({
        mr_url: `${MR}'; echo INJECTED-BY-STEP-OUTPUT > injected.txt; echo '`,
        conclusion: "ok",
      }),
    });
    let state = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2c0004", STEP_REGISTRY);
    state = await approvePlanGates(engine, "fv2c0004");
    assert.equal(existsSync(marker), false, "nothing from the step output was executed");
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed", "a value that is not exactly a merge request URL is refused");
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(state.stepResults["gate-completion"], undefined, "the completion gate is never reached");
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: approve, MR, approve completes; the completion gate links the MR", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const { engine, def } = stubbedWorkflow(dir, {
      "factory-intent": executeWrites({ mr_url: "https://gitlab.example.com/g/p/-/merge_requests/6" }),
      "factory-mission": executeWrites({ mr_url: MR, conclusion: "ok" }),
    });
    const s1 = await engine.execute(def, { issue_ref: "g/p#1" }, "fv2d0001", STEP_REGISTRY);
    assert.equal(s1.status, RunStatus.PAUSED);
    assert.equal(s1.currentStepId, "gate-intent");
    assert.match(s1.stepResults["gate-intent"].output.message, /Plan drafted for g\/p#1: https:\/\/gitlab\.example\.com\/g\/p\/-\/merge_requests\/6/);
    assert.equal(s1.stepResults.execute, undefined, "nothing is implemented before the plan is approved");

    const s2 = await approvePlanGates(engine, "fv2d0001");
    assert.equal(s2.status, RunStatus.PAUSED);
    assert.equal(s2.currentStepId, "gate-completion", "approving the plan does not pre-answer the completion gate");
    assert.equal(s2.stepResults["proof-of-work"]?.status, "completed");
    assert.ok(s2.stepResults["gate-completion"].output.message.includes(MR));

    const s3 = await engine.resume("fv2d0001", { verdict_completion: "approve" }, STEP_REGISTRY);
    assert.equal(s3.status, RunStatus.COMPLETED);
    assert.equal(classifyWorkflowStatus(s3.status).exitCode, 0);
  } finally {
    cleanup();
  }
});

test("factory 2.1.0: a resume into a fresh clone checks out the mission run branch before execute (F3)", { skip: !POSIX }, async () => {
  // F3: a parked run restored into a fresh clone starts on the base branch;
  // resume continues after gate-intent-decisions and never re-runs earlier
  // steps. Without a run-branch step between the gates and execute,
  // factory-mission would run detached on the base branch. The fix mirrors
  // supervised's run-branch-execute: check out the mission run branch again
  // (--kind code) right after the plan gates, before execute.
  const remote = mkdtempSync(join(tmpdir(), "f3-remote-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  const seed = mkdtempSync(join(tmpdir(), "f3-seed-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: seed });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: seed });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed });
  const m0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf-8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", m0], { cwd: seed });
  installSkills(seed);
  const seen = join(mkdtempSync(join(tmpdir(), "f3-seen-")), "seen.json");
  const e1 = new WorkflowEngine(seed);
  // Stub every command step: intent writes nothing (no drafts -> the record
  // gate auto-passes), execute records the branch it ran on.
  const { def } = stubbedWorkflow(seed, {
    "factory-intent": "echo intent",
    "factory-mission": `echo execute on $(git rev-parse --abbrev-ref HEAD) > ${seen}\n${executeWrites({ mr_url: "https://gl.test/g/p/-/merge_requests/7" })}`,
  });
  const s1 = await e1.execute(def, { issue_ref: "g/p#12" }, "f3r0001", STEP_REGISTRY);
  assert.equal(s1.status, RunStatus.PAUSED, "run pauses at the plan gate");
  const branchBefore = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: seed, encoding: "utf-8" }).trim();
  // Restore into a fresh single-branch clone on main (detached/base), like a
  // parked run coming back on a new pod; then resume through the gates.
  const fresh = join(mkdtempSync(join(tmpdir(), "f3-fresh-")), "repo");
  execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", remote, fresh]);
  assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fresh, encoding: "utf-8" }).trim(), "main");
  installSkills(fresh);
  const { restoreRun } = await import("../src/workflow/refs.mjs");
  restoreRun(fresh, "f3r0001", { issueRef: "g/p#12" });
  // Pre-create the mission branch at m0 (the intent phase did on the pod).
  execFileSync("git", ["branch", "-q", "factory/mission/p-12", m0], { cwd: fresh });
  // The placeholder run-branch.sh from installSkills exits 0 without
  // switching; give the fresh clone a helper that really checks out the
  // mission branch, like the real run-branch.sh --kind code does.
  const helperDir = join(fresh, ".agents", "skills", "factory-runbook", "scripts", "bash");
  writeFileSync(join(helperDir, "run-branch.sh"), "#!/usr/bin/env bash\ngit switch -q factory/mission/p-12\n");
  const e2 = new WorkflowEngine(fresh);
  // Two plan gates share verdict_intent: approve gate-intent, then approve
  // gate-intent-decisions. After the second approval the run must execute
  // run-branch-execute before execute.
  let resumed = await e2.resume("f3r0001", { verdict_intent: "approve" }, STEP_REGISTRY);
  assert.equal(resumed.status, RunStatus.PAUSED, "second plan gate still asks");
  assert.equal(resumed.currentStepId, "gate-intent-decisions");
  resumed = await e2.resume("f3r0001", { verdict_intent: "approve" }, STEP_REGISTRY);
  const ids = Object.keys(resumed.stepResults);
  assert.ok(ids.indexOf("run-branch-execute") !== -1, "the workflow declares run-branch-execute");
  assert.ok(ids.indexOf("run-branch-execute") < ids.indexOf("execute"), "run-branch-execute runs before execute");
  assert.equal(resumed.stepResults["run-branch-execute"]?.status, "completed");
  assert.equal(
    execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fresh, encoding: "utf-8" }).trim(),
    "factory/mission/p-12",
    `execute must run on the mission branch, not detached (was: ${branchBefore} before restore)`,
  );
  rmSync(remote, { recursive: true, force: true });
  rmSync(seed, { recursive: true, force: true });
  rmSync(join(fresh, ".."), { recursive: true, force: true });
});

for (const [gate, inputs, stop] of [
  ["gate-intent", { verdict_intent: "reject" }, "stop-if-plan-rejected"],
  ["gate-completion", { verdict_completion: "reject" }, "stop-if-result-rejected"],
]) {
  test(`factory 2.1.0: a reject at ${gate} ends FAILED (exit 10), never ABORTED (exit 1, retried)`, { skip: !POSIX }, async () => {
    const { dir, cleanup } = project();
    try {
      installSkills(dir);
      const { engine, def } = stubbedWorkflow(dir, {
        "factory-mission": executeWrites({ mr_url: MR, conclusion: "ok" }),
      });
      const runId = `fv2e${gate === "gate-intent" ? "0001" : "0002"}`;
      let state = await engine.execute(def, { issue_ref: "g/p#1" }, runId, STEP_REGISTRY);
      if (gate === "gate-completion") {
        state = await approvePlanGates(engine, runId);
        state = await engine.resume(runId, inputs, STEP_REGISTRY);
      } else state = await engine.resume(runId, inputs, STEP_REGISTRY);
      assert.equal(state.status, RunStatus.FAILED);
      assert.equal(classifyWorkflowStatus(state.status).exitCode, 10);
      assert.equal(state.stepResults[gate].output.choice, "reject");
      assert.equal(state.stepResults[stop]?.status, "failed");
      if (gate === "gate-intent") assert.equal(state.stepResults.execute, undefined, "a rejected plan is never implemented");
    } finally {
      cleanup();
    }
  });
}
