// State helpers + lease tests (ADR-395): the LLM-executor librarian API,
// strict single-writer lease, and — the headline — cross-executor handoff:
// a run started/paused via helpers resumes on the CLI engine and completes,
// and a CLI-paused gate is answered via a helper advance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { writeFileSync as fsWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine, RunState, RunStatus, Lease, LeaseHeldError } from "../src/factory/engine.mjs";
import { STEP_REGISTRY } from "../src/factory/registry.mjs";
import { stateStart, stateAdvance, statePause, stateFail, stateShow } from "../src/factory/state.mjs";

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "wf-state-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeWorkflow(dir) {
  const path = join(dir, "wf.yml");
  writeFileSync(path, `
schema_version: "1.0"
workflow:
  id: helper-wf
  name: Helper
  version: "1.0.0"
inputs:
  verdict: {type: string}
steps:
  - id: prepare
    type: shell
    run: "echo prep"
  - id: review
    type: gate
    message: "Approve?"
    options: [approve, reject]
    verdict_input: verdict
  - id: finish
    type: shell
    run: "echo done"
`, "utf-8");
  return path;
}

test("state start: creates run, frozen copy, resolved inputs; command-scoped lease released", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const state = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000001", inputs: { verdict: "" } });
    assert.equal(state.status, RunStatus.RUNNING);
    assert.equal(state.currentStepIndex, 0);
    assert.equal(state.currentStepId, "prepare");
    const runDir = join(dir, ".adlc", "workflows", "runs", "hh000001");
    assert.ok(existsSync(join(runDir, "state.json")));
    assert.ok(existsSync(join(runDir, "workflow.yml")));
    // Frozen copy is verbatim.
    assert.equal(readFileSync(join(runDir, "workflow.yml"), "utf-8"), readFileSync(path, "utf-8"));
    // Without ADLC_WORKFLOW_SESSION each helper command is its own session:
    // the command-scoped lock is released when the command exits.
    const lease = new Lease(runDir, { runId: "hh000001" });
    assert.equal(lease.read(), null);
    // …so a sequential helper invocation (next command) proceeds unblocked.
    const s1 = await stateAdvance({ projectRoot: dir, runId: "hh000001", stepId: "prepare", status: "completed" });
    assert.equal(s1.currentStepId, "review");
  } finally {
    cleanup();
  }
});

test("session-scoped lease: ADLC_WORKFLOW_SESSION persists the holder across invocations", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const prevSession = process.env.ADLC_WORKFLOW_SESSION;
    process.env.ADLC_WORKFLOW_SESSION = "agent-session-42";
    try {
      const runDir = join(dir, ".adlc", "workflows", "runs", "hh000009");
      const l1 = new Lease(runDir, { runId: "hh000009" });
      assert.ok(l1.persistent);
      assert.equal(l1.holder, "session:agent-session-42");
      l1.acquire();

      // A different session is blocked while ours is live…
      const l2 = new Lease(runDir, { runId: "hh000009" });
      l2.holder = "session:other";
      assert.throws(() => l2.acquire(), LeaseHeldError);

      // …and the same session (same env value, different pid) renews fine.
      process.env.ADLC_WORKFLOW_SESSION = "agent-session-42";
      const l3 = new Lease(runDir, { runId: "hh000009" });
      l3.renew();
      l3.release();

      // stateStart under a session keeps the lease held after the command.
      const s0 = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000010", inputs: { verdict: "" } });
      const held = new Lease(join(dir, ".adlc", "workflows", "runs", "hh000010"), { runId: "hh000010" });
      assert.ok(held.read() !== null);
      assert.equal(held.read().holder, "session:agent-session-42");
      // Sequential helper calls from the same session renew (not blocked)…
      await stateAdvance({ projectRoot: dir, runId: s0.runId, stepId: "prepare", status: "completed" });
      // …and pause releases (session hands the run off).
      await statePause({ projectRoot: dir, runId: s0.runId, stepId: "review" });
      assert.equal(held.read(), null);
    } finally {
      if (prevSession === undefined) delete process.env.ADLC_WORKFLOW_SESSION;
      else process.env.ADLC_WORKFLOW_SESSION = prevSession;
    }
  } finally {
    cleanup();
  }
});

test("state advance: records results, walks the counter, completes the last step", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const s0 = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000002", inputs: { verdict: "" } });
    const s1 = await stateAdvance({ projectRoot: dir, runId: s0.runId, stepId: "prepare", status: "completed" });
    assert.equal(s1.status, RunStatus.RUNNING);
    assert.equal(s1.currentStepId, "review");
    assert.equal(s1.stepResults.prepare.status, "completed");

    // Answer the gate via helper (the LLM-executor inline-gate path).
    const s2 = await stateAdvance({
      projectRoot: dir, runId: s0.runId, stepId: "review", status: "completed",
      output: { choice: "approve" },
    });
    assert.equal(s2.currentStepId, "finish");

    const s3 = await stateAdvance({ projectRoot: dir, runId: s0.runId, stepId: "finish", status: "completed" });
    assert.equal(s3.status, RunStatus.COMPLETED);
    // Lease released on completion.
    const lease = new Lease(join(dir, ".adlc", "workflows", "runs", s0.runId), { runId: s0.runId });
    assert.equal(lease.read(), null);
  } finally {
    cleanup();
  }
});

test("state pause + engine resume: cross-executor handoff completes the run", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    // LLM executor drives the first step, then parks at the gate.
    const s0 = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000003", inputs: { verdict: "" } });
    await stateAdvance({ projectRoot: dir, runId: s0.runId, stepId: "prepare", status: "completed" });
    const paused = await statePause({ projectRoot: dir, runId: s0.runId, stepId: "review" });
    assert.equal(paused.status, RunStatus.PAUSED);
    // Lease released on pause — the run is claimable.
    const runDir = join(dir, ".adlc", "workflows", "runs", s0.runId);
    assert.equal(new Lease(runDir, { runId: s0.runId }).read(), null);

    // CI engine resumes headless with the verdict bound via verdict_input.
    const engine = new WorkflowEngine(dir);
    const state = await engine.resume(s0.runId, { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    assert.match(state.stepResults.finish.output.stdout, /done/);
  } finally {
    cleanup();
  }
});

test("engine-paused gate answered via helper advance (handoff in reverse)", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    // CLI engine starts and pauses at the gate (non-TTY).
    const engine = new WorkflowEngine(dir);
    const state1 = await engine.execute(engine.loadWorkflow(path), { verdict: "" }, "hh000004", STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);
    assert.equal(state1.currentStepId, "review");

    // Human takes over in-session: answer the gate via the helper.
    const s2 = await stateAdvance({
      projectRoot: dir, runId: "hh000004", stepId: "review", status: "completed",
      output: { choice: "approve" },
    });
    assert.equal(s2.status, RunStatus.RUNNING);
    assert.equal(s2.currentStepId, "finish");

    // And hand back to CI (or keep driving) — engine resume completes.
    const engine2 = new WorkflowEngine(dir);
    const state3 = await engine2.resume("hh000004", null, STEP_REGISTRY);
    assert.equal(state3.status, RunStatus.COMPLETED);
  } finally {
    cleanup();
  }
});

test("lease: fresh foreign lease blocks; expired lease is taken over", () => {
  const { dir, cleanup } = makeProject();
  try {
    const runDir = join(dir, ".adlc", "workflows", "runs", "ll000001");
    const l1 = new Lease(runDir, { runId: "ll000001" });
    l1.acquire();

    // Same holder renews fine.
    l1.renew();

    // A different session (simulate by different holder string) is blocked.
    const l2 = new Lease(runDir, { runId: "ll000001" });
    l2.holder = "other-host:999";
    assert.throws(() => l2.acquire(), LeaseHeldError);

    // Expire it: forge an old heartbeat; takeover succeeds.
    fsWriteFileSync(join(runDir, "lease.json"), JSON.stringify({
      run_id: "ll000001", holder: "other-host:999",
      heartbeat_ts: Date.now() - 2 * 3600 * 1000, ttl_seconds: 900,
    }));
    l2.acquire(); // no throw
    assert.ok(l2.isValid());

    // release() never clobbers a foreign lease.
    const l3 = new Lease(runDir, { runId: "ll000001" });
    l3.holder = "third:1";
    assert.equal(l3.release(), false); // l2's lease survives
  } finally {
    cleanup();
  }
});

test("engine resume refuses while another live session holds the lease", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const engine = new WorkflowEngine(dir);
    const state1 = await engine.execute(engine.loadWorkflow(path), { verdict: "" }, "hh000005", STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);

    // Simulate a foreign live holder.
    const runDir = join(dir, ".adlc", "workflows", "runs", "hh000005");
    fsWriteFileSync(join(runDir, "lease.json"), JSON.stringify({
      run_id: "hh000005", holder: "other-host:999",
      heartbeat_ts: Date.now(), ttl_seconds: 900,
    }));

    const engine2 = new WorkflowEngine(dir);
    await assert.rejects(
      () => engine2.resume("hh000005", { verdict: "approve" }, STEP_REGISTRY),
      /locked by other-host:999/,
    );
  } finally {
    cleanup();
  }
});

test("state fail: terminal failure releases the lease", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const s0 = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000006", inputs: { verdict: "" } });
    const s1 = await stateFail({ projectRoot: dir, runId: s0.runId, error: "agent CLI crashed" });
    assert.equal(s1.status, RunStatus.FAILED);
    assert.equal(s1.error, "agent CLI crashed");
    const runDir = join(dir, ".adlc", "workflows", "runs", "hh000006");
    assert.equal(new Lease(runDir, { runId: "hh000006" }).read(), null);

    const shown = stateShow({ projectRoot: dir, runId: "hh000006" });
    assert.equal(shown.status, RunStatus.FAILED);
  } finally {
    cleanup();
  }
});

test("state advance rejects unknown step id with the valid list", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const s0 = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000007", inputs: { verdict: "" } });
    await assert.rejects(
      () => stateAdvance({ projectRoot: dir, runId: s0.runId, stepId: "nope", status: "completed" }),
      /Unknown step 'nope' in workflow 'helper-wf'. Steps: prepare, review, finish/,
    );
  } finally {
    cleanup();
  }
});

test("state helpers refuse writes when a foreign live lease holds the run", async () => {
  const { dir, cleanup } = makeProject();
  try {
    const path = writeWorkflow(dir);
    const s0 = await stateStart({ projectRoot: dir, workflowSource: path, runId: "hh000008", inputs: { verdict: "" } });
    // Release ours, forge a foreign live lease (another session's turn).
    const runDir = join(dir, ".adlc", "workflows", "runs", "hh000008");
    fsWriteFileSync(join(runDir, "lease.json"), JSON.stringify({
      run_id: "hh000008", holder: "ci-runner:42",
      heartbeat_ts: Date.now(), ttl_seconds: 900,
    }));
    await assert.rejects(
      () => stateAdvance({ projectRoot: dir, runId: "hh000008", stepId: "prepare", status: "completed" }),
      /locked by ci-runner:42/,
    );
  } finally {
    cleanup();
  }
});
