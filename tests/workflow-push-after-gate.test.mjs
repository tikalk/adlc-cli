// Run state reaches the remote right after a gate is answered (SF-FIX-21).
//
// The engine pushes the run ref at every step start, throttled to once per
// ADLC_WORKFLOW_PUSH_INTERVAL seconds (default 60). A gate completes in
// milliseconds, so the step after it started inside the same window and was
// NOT pushed: for the whole of that step the remote still said "at the gate".
// A pod lost during the step was then restored at the gate, and a gate that
// declares `context` refused the stored approval ("head moved"), ending the
// run with exit 10.
//
// Contract pinned here:
//   G1  With the default interval, the step that follows a completed gate is
//       pushed at once: while it runs, the remote names it as current and
//       holds the gate's completed result.
//   G2  Steps that do not follow a gate stay throttled (no extra pushes).
//   G3  ADLC_WORKFLOW_PUSH_INTERVAL=0 pushes every step start; an invalid
//       value falls back to the default (throttled).
//   G4  A pod killed during the step after a context gate: a fresh clone on
//       the default branch restores the run and resumes straight into that
//       step; the gate is not asked or checked again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { restoreRun } from "../src/workflow/refs.mjs";

const POSIX = process.platform !== "win32";
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

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function configure(dir) {
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
}

// A clone with a bare `origin`; run dirs are git-ignored.
function repo() {
  const dir = tempDir("push-gate-repo-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  write(dir, ".gitignore", ".adlc/workflows/\n");
  write(dir, "README.md", "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const bare = tempDir("push-gate-bare-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  git(dir, "remote", "add", "origin", bare);
  git(dir, "push", "-q", "origin", "main");
  return { dir, bare };
}

function remoteState(bare, runId) {
  return JSON.parse(git(bare, "show", `refs/factory-runs/${runId}:state.json`));
}

function workflow(stepsYaml) {
  const path = join(tempDir("push-gate-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: push-gate
  name: Push after gate
  version: "1.0.0"
inputs:
  verdict: {type: string, default: ""}
steps:
${stepsYaml}`, "utf-8");
  return path;
}

const shell = (id) => `  - id: ${id}
    type: shell
    run: "echo ${id}"
`;
const GATE = `  - id: gate-a
    type: gate
    message: "Approve?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
`;

async function withPushInterval(value, fn) {
  const prev = process.env.ADLC_WORKFLOW_PUSH_INTERVAL;
  if (value === undefined) delete process.env.ADLC_WORKFLOW_PUSH_INTERVAL;
  else process.env.ADLC_WORKFLOW_PUSH_INTERVAL = String(value);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ADLC_WORKFLOW_PUSH_INTERVAL;
    else process.env.ADLC_WORKFLOW_PUSH_INTERVAL = prev;
  }
}

// Run a workflow and record, at each step start (after the engine's own sync
// attempt), which step the REMOTE names as current. That is what a retry pod
// would restore if this pod died during the step.
async function runAndWatchRemote({ dir, bare }, stepsYaml, runId, inputs = {}) {
  const engine = new WorkflowEngine(dir);
  const seen = {};
  engine.onStepStart = (stepId) => {
    const remote = remoteState(bare, runId);
    seen[stepId] = { current: remote.current_step_id, steps: remote.step_results ?? {} };
  };
  const state = await engine.execute(engine.loadWorkflow(workflow(stepsYaml)), inputs, runId, STEP_REGISTRY);
  return { state, seen };
}

test("G1: the step after an answered gate is on the remote as soon as it starts (default interval)", async () => {
  const r = repo();
  await withPushInterval(undefined, async () => {
    const { state, seen } = await runAndWatchRemote(r, shell("plan") + GATE + shell("execute") + shell("after"), "g1", { verdict: "approve" });
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(seen.execute.current, "execute", "a restore during execute must not go back to the gate");
    assert.equal(seen.execute.steps["gate-a"]?.status, StepStatus.COMPLETED, "the remote holds the gate's answer");
    assert.equal(seen.execute.steps["gate-a"]?.output?.choice, "approve");
    // The step after that is throttled again: one unthrottled push per gate.
    assert.equal(seen.after.current, "execute");
  });
});

test("G2: steps that do not follow a gate stay throttled", async () => {
  const r = repo();
  await withPushInterval(3600, async () => {
    const { state, seen } = await runAndWatchRemote(r, shell("one") + shell("two") + shell("three"), "g2");
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.equal(seen.one.current, "one", "the first step start is always pushed");
    assert.equal(seen.two.current, "one", "no push inside the interval");
    assert.equal(seen.three.current, "one");
    assert.equal(remoteState(r.bare, "g2").status, RunStatus.COMPLETED, "the run end is pushed unconditionally, as before");
  });
});

test("G2: a paused gate does not arm the push; a rejected one stops the run as before", async () => {
  const r = repo();
  await withPushInterval(3600, async () => {
    const paused = await runAndWatchRemote(r, shell("plan") + GATE + shell("execute"), "g2p");
    assert.equal(paused.state.status, RunStatus.PAUSED);
    assert.equal(paused.seen.execute, undefined);
    assert.equal(remoteState(r.bare, "g2p").status, RunStatus.PAUSED);
    const rejected = await runAndWatchRemote(r, shell("plan") + GATE + shell("execute"), "g2r", { verdict: "reject" });
    assert.equal(rejected.state.status, RunStatus.ABORTED);
  });
});

test("G3: ADLC_WORKFLOW_PUSH_INTERVAL=0 pushes every step start; an invalid value means the default", async () => {
  const steps = shell("one") + shell("two") + shell("three");
  const zero = repo();
  await withPushInterval(0, async () => {
    const { seen } = await runAndWatchRemote(zero, steps, "g3zero");
    assert.deepEqual([seen.one.current, seen.two.current, seen.three.current], ["one", "two", "three"]);
  });
  for (const [value, id] of [["abc", "g3abc"], ["-5", "g3neg"], ["", "g3empty"]]) {
    const r = repo();
    await withPushInterval(value, async () => {
      const { seen } = await runAndWatchRemote(r, steps, id);
      assert.deepEqual([seen.one.current, seen.two.current, seen.three.current], ["one", "one", "one"], `${JSON.stringify(value)} falls back to 60 s`);
    });
  }
});

// ── G4: the crash this protects against, with a real kill ─────────────────

const PDR = `---\nstatus: Proposed\n---\n\n# Billing tiers\n\n## Decision Outcome\n\nWe decide billing tiers.\n`;

function waitFor(predicate, what, timeoutMs = 30_000) {
  return new Promise((resolveP, rejectP) => {
    const started = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolveP();
      if (Date.now() - started > timeoutMs) return rejectP(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("G4: a pod killed during the step after a context gate resumes into that step from a fresh clone", { skip: !POSIX }, async () => {
  const { dir, bare } = repo();
  // The run works on its own branch, ahead of the default branch — as a
  // mission does once the plan is committed. A retry pod clones `main`.
  git(dir, "checkout", "-q", "-b", "factory/mission/p-1");
  write(dir, ".adlc/drafts/pdr/PDR-001.md", PDR);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "plan: draft PDR-001");
  git(dir, "push", "-q", "origin", "factory/mission/p-1");

  const marker = join(tempDir("push-gate-marker-"), "first-attempt");
  // execute: the first attempt never finishes (the pod is killed); a second
  // attempt, in any clone, is quick.
  const wf = workflow(`  - id: gate-a
    type: gate
    message: "Approve PDRs?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
    context:
      records: [".adlc/drafts/pdr/*.md"]
      since: last_approved
  - id: execute
    type: shell
    timeout: 120
    run: |
      if [ -f "${marker}" ]; then echo second-attempt; else : > "${marker}"; sleep 100; fi
`);

  await withPushInterval(undefined, async () => {
    // Pod 1, first spawn: the gate pauses (pushed on exit).
    const e1 = new WorkflowEngine(dir);
    const paused = await e1.execute(e1.loadWorkflow(wf), {}, "g4", STEP_REGISTRY);
    assert.equal(paused.status, RunStatus.PAUSED);
    assert.equal(remoteState(bare, "g4").status, RunStatus.PAUSED);

    // Pod 1, second spawn: the approval arrives, execute starts, the pod dies.
    const env = { ...process.env };
    delete env.ADLC_WORKFLOW_PUSH_INTERVAL;
    delete env.ADLC_WORKFLOW_RUN_ID;
    const child = spawn(process.execPath, [CLI, "workflow", "resume", "g4", "--input", "verdict=approve", "--format", "json"], {
      cwd: dir, env, detached: true, stdio: "ignore",
    });
    try {
      await waitFor(() => existsSync(marker), "execute to start");
    } finally {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    await new Promise((r) => child.once("exit", r));

    // What the remote says after the pod died.
    const remote = remoteState(bare, "g4");
    // Before the fix the remote still showed the run at the gate here
    // ("paused", or "running" at gate-a when the last push was over a minute
    // old), and the resume below went back to the gate.
    assert.equal(remote.status, RunStatus.RUNNING);
    assert.equal(remote.current_step_id, "execute", "the remote must not still say 'at the gate'");
    assert.equal(remote.step_results["gate-a"].status, StepStatus.COMPLETED);

    // Retry pod: a fresh clone on the default branch restores and resumes.
    const fresh = join(tempDir("push-gate-fresh-"), "repo");
    execFileSync("git", ["clone", "-q", bare, fresh]);
    configure(fresh);
    assert.equal(git(fresh, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    restoreRun(fresh, "g4", {});
    const resumed = await new WorkflowEngine(fresh).resume("g4", null, STEP_REGISTRY);
    assert.equal(resumed.error, null);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.match(resumed.stepResults.execute.output.stdout, /second-attempt/);
    assert.equal(resumed.stepResults["gate-a"].output.choice, "approve", "the stored answer is kept, the gate is not run again");
  });
});
