// Phase 1 — trace bundle v1 (ADR-490), fed by existing engine/run-log events.
//
// Contract pinned here:
//   AC-T1  run start creates trace/manifest.json, trace/events.jsonl and
//          trace/artifacts.json with a valid manifest.
//   AC-T2  transitions append ADR-362 envelopes with ADR-364 canonical types
//          and the original event name under payload.adlc.
//   AC-T3  secrets never reach events.jsonl or manifest.json.
//   AC-T4  retention is fail-closed: failed runs keep full events, successful
//          runs keep only the manifest unless a sampling policy says otherwise.
//   AC-T5  artifacts.json is content-addressed and validates.
//   AC-T6  trace files travel in the run ref (park/restore).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { stateStart, stateAdvance, statePause } from "../src/workflow/state.mjs";
import { parkRun, restoreRun } from "../src/workflow/refs.mjs";
import {
  TRACE_SCHEMA_VERSION,
  appendTraceEvent,
  recordArtifact,
  tracePaths,
} from "../src/workflow/trace.mjs";

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

function commitAll(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

function repo({ remote = false } = {}) {
  const dir = tempDir("trace-repo-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  write(dir, ".gitignore", ".adlc/workflows/\n");
  write(dir, "README.md", "base\n");
  write(dir, "skills-lock.json", JSON.stringify({ skills: [] }) + "\n");
  write(dir, ".mcp.json", JSON.stringify({ mcpServers: {} }) + "\n");
  commitAll(dir, "base");
  let bare = null;
  if (remote) {
    bare = tempDir("trace-bare-");
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "main");
  }
  return { dir, bare };
}

function cloneOf(bare) {
  const b = join(tempDir("trace-clone-"), "b");
  execFileSync("git", ["clone", "-q", bare, b]);
  configure(b);
  return b;
}

function workflowFile({ gate = false } = {}) {
  const path = join(tempDir("trace-wf-"), "workflow.yml");
  const gateStep = gate
    ? `  - id: approve
    type: gate
    message: "Approve?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
`
    : "";
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: trace-wf
  name: Trace
  version: "1.0.0"
inputs:
  verdict: {type: string, enum: ["", approve, reject]}
  issue_ref: {type: string, default: ""}
steps:
  - id: one
    type: shell
    run: "echo one"
${gateStep}  - id: two
    type: shell
    run: "echo two"
`, "utf-8");
  return path;
}

function runDir(dir, runId) {
  return join(dir, ".adlc", "workflows", "runs", runId);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readEvents(runDirAbs) {
  const path = tracePaths(runDirAbs).events;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function withEnv(name, value, fn) {
  const prev = process.env[name];
  process.env[name] = String(value);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

// ── AC-T1: run start creates the bundle ───────────────────────────────────

test("AC-T1: stateStart creates a valid trace manifest, events file and artifacts file", async () => {
  const { dir } = repo();
  const state = await stateStart({
    projectRoot: dir,
    workflowSource: workflowFile(),
    runId: "t1",
    inputs: { issue_ref: "issue-1" },
  });
  const rd = runDir(dir, "t1");
  const paths = tracePaths(rd);
  assert.ok(existsSync(paths.manifest), "manifest.json must exist");
  assert.ok(existsSync(paths.events), "events.jsonl must exist");
  assert.ok(existsSync(paths.artifacts), "artifacts.json must exist");

  const manifest = readJson(paths.manifest);
  assert.equal(manifest.schema_version, TRACE_SCHEMA_VERSION);
  assert.equal(manifest.run_id, "t1");
  assert.equal(manifest.workflow_id, state.workflowId);
  assert.equal(manifest.outcome, "running");
  assert.equal(manifest.retention_class, "pending");
  assert.equal(manifest.issue_ref, "issue-1");
  assert.match(manifest.config.skill_lock_hash, /^[0-9a-f]{64}$/);
  assert.match(manifest.config.mcp_config_hash, /^[0-9a-f]{64}$/);

  const artifacts = readJson(paths.artifacts);
  assert.equal(artifacts.schema_version, TRACE_SCHEMA_VERSION);
  assert.deepEqual(artifacts.artifacts, []);

  const events = readEvents(rd);
  assert.ok(events.length >= 1, "run_started must be recorded");
  assert.equal(events[0].payload.adlc.event, "run_started");
});

// ── AC-T2: ADR-362 envelopes with canonical types ────────────────────────

test("AC-T2: transitions append ADR-362 envelopes with canonical ADR-364 types", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "t2" });
  await stateAdvance({ projectRoot: dir, runId: "t2", stepId: "one", status: "failed", error: "boom" });

  const rd = runDir(dir, "t2");
  const events = readEvents(rd);
  const canonical = new Set(["message", "tool", "permission_request", "error", "complete", "log"]);
  for (const event of events) {
    assert.equal(event.schema_version, 1, "envelope schema_version");
    assert.equal(typeof event.agent_id, "string");
    assert.ok(event.agent_id.length > 0, "agent_id must be present");
    assert.ok(!Number.isNaN(Date.parse(event.ts)), "ts must parse");
    assert.ok(canonical.has(event.type), `canonical type, got ${event.type}`);
    assert.equal(typeof event.payload, "object");
    assert.equal(typeof event.payload.adlc.event, "string");
  }
  assert.ok(events.some((e) => e.payload.adlc.event === "step_advanced" && e.type === "log"));
  assert.ok(events.some((e) => e.payload.adlc.event === "run_failed" && e.type === "error"));

  // Mapping of gate and completion names is stable.
  const synthetic = join(tempDir("trace-map-"), "run");
  mkdirSync(synthetic, { recursive: true });
  appendTraceEvent(synthetic, { event: "gate_paused", step_id: "g" });
  appendTraceEvent(synthetic, { event: "workflow_finished", status: "completed" });
  const mapped = readEvents(synthetic);
  assert.equal(mapped[0].type, "permission_request");
  assert.equal(mapped[1].type, "complete");
});

test("AC-T2: a completed engine run ends with a complete event when retained", async () => {
  const { dir } = repo();
  await withEnv("ADLC_TRACE_SUCCESS_SAMPLE_RATE", 1, async () => {
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(engine.loadWorkflow(workflowFile()), {}, "t2-engine", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED);
    const events = readEvents(runDir(dir, "t2-engine"));
    assert.ok(events.length > 0);
    assert.equal(events.at(-1).type, "complete");
    assert.equal(events.at(-1).payload.adlc.event, "run_completed");
  });
});

// ── AC-T3: secrets never reach the trace ─────────────────────────────────

test("AC-T3: secrets in logs, step output and issue_ref are masked in the trace", async () => {
  const SECRET = "supersecrettracevalue123";
  const { dir } = repo();
  const prev = process.env.TRACE_TEST_TOKEN;
  process.env.TRACE_TEST_TOKEN = SECRET;
  try {
    const state = await stateStart({
      projectRoot: dir,
      workflowSource: workflowFile(),
      runId: "t3",
      inputs: { issue_ref: `https://bot:${SECRET}@example.test/issue/3` },
    });
    const rd = runDir(dir, "t3");
    await state.appendLog({ event: "leak", note: `token ${SECRET}` });
    await stateAdvance({
      projectRoot: dir,
      runId: "t3",
      stepId: "one",
      status: "failed",
      output: { stdout: `printed ${SECRET}` },
      error: `failed with ${SECRET}`,
    });

    // Trace files are capture-redacted; other run files are machine-local and
    // are redacted at park by redactRunDir (ADR-478).
    for (const rel of ["trace/events.jsonl", "trace/manifest.json"]) {
      const text = readFileSync(join(rd, rel), "utf-8");
      assert.ok(!text.includes(SECRET), `${rel} must not contain the secret`);
    }
    const eventsText = readFileSync(tracePaths(rd).events, "utf-8");
    assert.ok(eventsText.includes("***"), "events must carry the mask");
    const manifest = readJson(tracePaths(rd).manifest);
    assert.ok(!manifest.issue_ref.includes(SECRET));
    assert.ok(manifest.issue_ref.includes("***"));
  } finally {
    if (prev === undefined) delete process.env.TRACE_TEST_TOKEN;
    else process.env.TRACE_TEST_TOKEN = prev;
  }
});

// ── AC-T4: fail-closed retention ─────────────────────────────────────────

test("AC-T4: a failed run keeps full events and marks retention full", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "t4-fail" });
  await stateAdvance({ projectRoot: dir, runId: "t4-fail", stepId: "one", status: "failed", error: "boom" });
  const rd = runDir(dir, "t4-fail");
  assert.ok(existsSync(tracePaths(rd).events), "failed run keeps events");
  const manifest = readJson(tracePaths(rd).manifest);
  assert.equal(manifest.outcome, "failed");
  assert.equal(manifest.retention_class, "full");
  assert.ok(manifest.finished_at);
});

test("AC-T4: a completed run keeps only the manifest under the default policy", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "t4-default" });
  await stateAdvance({ projectRoot: dir, runId: "t4-default", stepId: "one", status: "completed" });
  await stateAdvance({ projectRoot: dir, runId: "t4-default", stepId: "two", status: "completed" });
  const rd = runDir(dir, "t4-default");
  const manifest = readJson(tracePaths(rd).manifest);
  assert.equal(manifest.outcome, "completed");
  assert.equal(manifest.retention_class, "manifest-only");
  assert.ok(!existsSync(tracePaths(rd).events), "successful events are pruned by default");
  assert.ok(existsSync(tracePaths(rd).manifest), "manifest is never pruned");
});

test("AC-T4: an explicit sample rate retains successful events", async () => {
  const { dir } = repo();
  await withEnv("ADLC_TRACE_SUCCESS_SAMPLE_RATE", 1, async () => {
    await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "t4-sample" });
    await stateAdvance({ projectRoot: dir, runId: "t4-sample", stepId: "one", status: "completed" });
    await stateAdvance({ projectRoot: dir, runId: "t4-sample", stepId: "two", status: "completed" });
  });
  const rd = runDir(dir, "t4-sample");
  const manifest = readJson(tracePaths(rd).manifest);
  assert.equal(manifest.retention_class, "full-sampled");
  assert.ok(existsSync(tracePaths(rd).events), "sampled success keeps events");
});

// ── AC-T5: content-addressed artifacts ───────────────────────────────────

test("AC-T5: recordArtifact appends a content-addressed entry and rejects a bad hash", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "t5" });
  const rd = runDir(dir, "t5");
  write(rd, "evidence/report.txt", "hello trace\n");
  const expected = createHash("sha256").update("hello trace\n").digest("hex");

  recordArtifact(rd, {
    path: "evidence/report.txt",
    media_type: "text/plain",
    storage_uri: "run://evidence/report.txt",
    retention_class: "full",
    sensitivity: "internal",
    producing_event: "evt-1",
  });

  const artifacts = readJson(tracePaths(rd).artifacts);
  assert.equal(artifacts.artifacts.length, 1);
  const entry = artifacts.artifacts[0];
  assert.equal(entry.content_sha256, expected);
  assert.equal(entry.size, Buffer.byteLength("hello trace\n"));
  assert.equal(entry.media_type, "text/plain");
  assert.equal(entry.sensitivity, "internal");

  assert.throws(() => {
    recordArtifact(rd, {
      content_sha256: "not-a-hash",
      media_type: "text/plain",
      size: 1,
      storage_uri: "run://x",
      retention_class: "full",
      sensitivity: "internal",
      producing_event: "evt-2",
    });
  }, /sha256/i);
});

// ── AC-T6: trace files travel in the run ref ─────────────────────────────

test("AC-T6: park/restore carries trace files into a second clone", async () => {
  const { dir, bare } = repo({ remote: true });
  await stateStart({ projectRoot: dir, workflowSource: workflowFile({ gate: true }), runId: "t6" });
  await stateAdvance({ projectRoot: dir, runId: "t6", stepId: "one", status: "completed" });
  await statePause({ projectRoot: dir, runId: "t6", stepId: "approve" });

  const handle = join(tempDir("trace-handle-"), "handle.json");
  writeFileSync(handle, JSON.stringify({ channel: "C1", thread_ts: "1.0" }), "utf-8");
  parkRun(dir, "t6", { handleFile: handle, remote: "origin" });

  const tree = git(bare, "ls-tree", "-r", "--name-only", "refs/factory-runs/t6").split("\n").filter(Boolean);
  for (const rel of ["trace/manifest.json", "trace/events.jsonl", "trace/artifacts.json"]) {
    assert.ok(tree.includes(rel), `${rel} must be in the ref (tree: ${tree.join(", ")})`);
  }

  const b = cloneOf(bare);
  restoreRun(b, "t6", { remote: "origin" });
  const restored = runDir(b, "t6");
  const manifest = readJson(tracePaths(restored).manifest);
  assert.equal(manifest.run_id, "t6");
  assert.equal(manifest.outcome, "paused");
  assert.ok(existsSync(tracePaths(restored).events), "paused run keeps events");

  const engine = new WorkflowEngine(b);
  const state = await engine.resume("t6", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.ok(existsSync(tracePaths(restored).manifest), "restored run keeps its manifest");
});
