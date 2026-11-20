// Bundled `factory` 2.0.0 (SF-LANE-05): it calls only skills that exist in
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
import { WorkflowEngine, RunStatus, validateWorkflow, headlessGateErrors } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { classifyWorkflowStatus } from "../src/exit-codes.mjs";

const POSIX = process.platform !== "win32";

// Skills the bundled workflow may call (adlc-team-skills skills/factory/).
// factory-product / factory-architect were removed on 2026-10-25.
const EXISTING_COMMANDS = new Set(["factory-intent", "factory-mission"]);
const STEP_IDS = [
  "preflight", "intent", "plan-link", "gate-intent", "stop-if-plan-rejected",
  "execute", "proof-of-work", "gate-completion", "stop-if-result-rejected",
];
const MR = "https://gitlab.example.com/g/p/-/merge_requests/7";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "wf-factory-v2-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
    /^( {4})type: command\n {4}command: ([\w-]+)\n(?: {4}#.*\n)*(?: {4}input:\n {6}args: .*\n)?/gm,
    (_, i, cmd) => {
      const body = (stubs[cmd] ?? `echo ${cmd}`).split("\n").map((l) => `${i}  ${l}`).join("\n");
      return `${i}type: shell\n${i}run: |\n${body}\n`;
    },
  );
  assert.ok(!out.includes("type: command"), "fixture: every command step stubbed");
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

test("factory 2.0.0: valid, headless-valid, calls only existing skills, gates never abort", () => {
  const { dir, cleanup } = project();
  try {
    const def = new WorkflowEngine(dir).loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.version, "2.0.0");
    assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
    assert.deepEqual(headlessGateErrors(def), []);
    assert.deepEqual(def.steps.map((s) => s.id), STEP_IDS);
    for (const s of def.steps.filter((x) => x.type === "command")) {
      assert.ok(EXISTING_COMMANDS.has(s.command), `step ${s.id} calls ${s.command}, which adlc-team-skills does not ship`);
    }
    // A reject must end FAILED (exit 10), never ABORTED (exit 1, retried by
    // the lane); each gate has its own verdict input.
    const gates = def.steps.filter((x) => x.type === "gate");
    assert.deepEqual(gates.map((g) => [g.id, g.on_reject, g.verdict_input]), [
      ["gate-intent", "skip", "verdict_intent"],
      ["gate-completion", "skip", "verdict_completion"],
    ]);
  } finally {
    cleanup();
  }
});

test("factory 2.0.0: a workspace without the factory skills fails at preflight, before any agent step", { skip: !POSIX }, async () => {
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

test("factory 2.0.0: skills without the factory-runbook helpers fail at preflight", { skip: !POSIX }, async () => {
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

test("factory 2.0.0: a run without an issue fails at preflight", { skip: !POSIX }, withoutIssueEnv(async () => {
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

test("factory 2.0.0: an approved plan whose execute reports no mr_url fails at proof-of-work", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const { engine, def } = stubbedWorkflow(dir);
    const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0001", STEP_REGISTRY);
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

test("factory 2.0.0: an mr_url that is not a URL (e.g. 'none') fails at proof-of-work", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const { engine, def } = stubbedWorkflow(dir, {
      "factory-mission": executeWrites({ mr_url: "none", conclusion: "could not open the MR" }),
    });
    const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0002", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
  } finally {
    cleanup();
  }
});

test("factory 2.0.0: an mr_url carrying $(…) or backticks is refused and never run", { skip: !POSIX }, async () => {
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
    const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0003", STEP_REGISTRY);
    assert.equal(existsSync(marker), false, "nothing from the step output was executed");
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
    assert.equal(state.status, RunStatus.FAILED);
  } finally {
    cleanup();
  }
});

test("factory 2.0.0: a conclusion full of shell syntax is never run; a real MR URL passes", { skip: !POSIX }, async () => {
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
    const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0005", STEP_REGISTRY);
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
  test(`factory 2.0.0: proof-of-work refuses ${what} as the merge request`, { skip: !POSIX }, async () => {
    const { dir, cleanup } = project();
    try {
      installSkills(dir);
      const { engine, def } = stubbedWorkflow(dir, { "factory-mission": executeWrites({ mr_url: value }) });
      const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0006", STEP_REGISTRY);
      assert.equal(state.stepResults["proof-of-work"]?.status, "failed");
      assert.equal(state.status, RunStatus.FAILED);
      assert.equal(state.stepResults["gate-completion"], undefined, "the value never reaches the approval message");
    } finally {
      cleanup();
    }
  });
}

test("factory 2.0.0: proof-of-work accepts a GitHub pull request URL", { skip: !POSIX }, async () => {
  const { dir, cleanup } = project();
  try {
    installSkills(dir);
    const pr = "https://github.com/acme/widgets/pull/42";
    const { engine, def } = stubbedWorkflow(dir, { "factory-mission": executeWrites({ mr_url: pr }) });
    const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0007", STEP_REGISTRY);
    assert.equal(state.stepResults["proof-of-work"]?.status, "completed");
    assert.ok(state.stepResults["gate-completion"].output.message.includes(pr));
  } finally {
    cleanup();
  }
});

// The plan gate's message is posted to Slack as written, so the plan link is
// checked first (plan-link) and anything that is not an MR URL is left out.
test("factory 2.0.0: the plan gate shows only a checked merge request link", { skip: !POSIX }, async () => {
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
test("factory 2.0.0: a single quote in mr_url cannot break out into the shell", { skip: !POSIX }, async () => {
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
    const state = await engine.execute(def, { issue_ref: "g/p#1", verdict_intent: "approve" }, "fv2c0004", STEP_REGISTRY);
    assert.equal(existsSync(marker), false, "nothing from the step output was executed");
    assert.equal(state.stepResults["proof-of-work"]?.status, "failed", "a value that is not exactly a merge request URL is refused");
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(state.stepResults["gate-completion"], undefined, "the completion gate is never reached");
  } finally {
    cleanup();
  }
});

test("factory 2.0.0: approve, MR, approve completes; the completion gate links the MR", { skip: !POSIX }, async () => {
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

    const s2 = await engine.resume("fv2d0001", { verdict_intent: "approve" }, STEP_REGISTRY);
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

for (const [gate, inputs, stop] of [
  ["gate-intent", { verdict_intent: "reject" }, "stop-if-plan-rejected"],
  ["gate-completion", { verdict_intent: "approve", verdict_completion: "reject" }, "stop-if-result-rejected"],
]) {
  test(`factory 2.0.0: a reject at ${gate} ends FAILED (exit 10), never ABORTED (exit 1, retried)`, { skip: !POSIX }, async () => {
    const { dir, cleanup } = project();
    try {
      installSkills(dir);
      const { engine, def } = stubbedWorkflow(dir, {
        "factory-mission": executeWrites({ mr_url: MR, conclusion: "ok" }),
      });
      const state = await engine.execute(def, { issue_ref: "g/p#1", ...inputs }, `fv2e${gate === "gate-intent" ? "0001" : "0002"}`, STEP_REGISTRY);
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
