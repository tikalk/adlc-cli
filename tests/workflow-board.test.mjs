// Phase 3 — factory board / pane of glass v1 (ADR-476, ADR-490 query index).
//
// Contract pinned here:
//   AC-B1  local runs are listed with status, current step and trace
//          outcome/retention; --format json emits a parseable index with
//          the required row fields.
//   AC-B2  remote-only runs (parked from another clone) appear with status
//          read from the ref; runs present locally and remotely are marked
//          synced and keep local detail.
//   AC-B3  graceful degradation: an unreachable remote degrades to a
//          local-only board (warning, exit 0); a ref whose tree lacks
//          state.json is skipped and counted, never fatal.
//   AC-B4  the remote fetch never overwrites local refs/factory-runs/*
//          (namespaced fetch destination).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateStart, stateAdvance, statePause } from "../src/workflow/state.mjs";
import { parkRun } from "../src/workflow/refs.mjs";
import { buildBoardIndex } from "../src/workflow/board.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "adlc-cli.mjs");

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

function repo({ remote = false } = {}) {
  const dir = tempDir("board-repo-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  write(dir, ".gitignore", ".adlc/workflows/\n");
  write(dir, "README.md", "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  let bare = null;
  if (remote) {
    bare = tempDir("board-bare-");
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "main");
  }
  return { dir, bare };
}

function workflowFile({ gate = false } = {}) {
  const path = join(tempDir("board-wf-"), "workflow.yml");
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
  id: board-wf
  name: Board
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

function byId(rows) {
  return new Map(rows.map((r) => [r.run_id, r]));
}

// ── AC-B1: local runs listed with detail; JSON contract ──────────────────

test("AC-B1: board lists local runs with status, step and trace outcome", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "b1-run", inputs: { issue_ref: "issue-7" } });
  await stateAdvance({ projectRoot: dir, runId: "b1-run", stepId: "one", status: "failed", error: "boom" });

  const board = buildBoardIndex({ projectRoot: dir, remote: "origin" });
  // No origin remote configured here — fetch fails softly (AC-B3 contract);
  // AC-B1 pins the local row detail regardless.
  assert.ok(board.remoteError, "no-remote repo must degrade, not throw");
  const row = byId(board.runs).get("b1-run");
  assert.ok(row, "local run must be listed");
  assert.equal(row.source, "local");
  assert.equal(row.status, "failed");
  assert.equal(row.workflow_id, "board-wf");
  assert.equal(row.outcome, "failed");
  assert.equal(row.retention_class, "full");
  assert.equal(row.issue_ref, "issue-7");
});

test("AC-B1: --format json emits a parseable index with required fields", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "b1-json" });

  const cli = spawnSync(process.execPath, [CLI, "workflow", "board", "--format", "json"], {
    cwd: dir,
    encoding: "utf-8",
  });
  assert.equal(cli.status, 0, `board --format json must exit 0 (stderr: ${cli.stderr})`);
  const doc = JSON.parse(cli.stdout);
  assert.ok(Array.isArray(doc.runs));
  const row = byId(doc.runs).get("b1-json");
  assert.ok(row, "run row must be in the JSON index");
  for (const field of ["run_id", "source", "status", "workflow_id", "updated_at"]) {
    assert.ok(field in row, `row must carry ${field}`);
  }
});

// ── AC-B2: remote-only runs; sync marking ────────────────────────────────

test("AC-B2: a second clone sees a remote-parked run with status from the ref", async () => {
  const { dir, bare } = repo({ remote: true });
  await stateStart({ projectRoot: dir, workflowSource: workflowFile({ gate: true }), runId: "b2-remote" });
  await stateAdvance({ projectRoot: dir, runId: "b2-remote", stepId: "one", status: "completed" });
  await statePause({ projectRoot: dir, runId: "b2-remote", stepId: "approve" });
  const handle = join(tempDir("board-handle-"), "handle.json");
  writeFileSync(handle, JSON.stringify({ channel: "C1", thread_ts: "1.0" }), "utf-8");
  parkRun(dir, "b2-remote", { handleFile: handle, remote: "origin" });

  const b = join(tempDir("board-clone-"), "b");
  execFileSync("git", ["clone", "-q", bare, b]);
  configure(b);

  const board = buildBoardIndex({ projectRoot: b, remote: "origin" });
  const row = byId(board.runs).get("b2-remote");
  assert.ok(row, "remote-parked run must be listed in a clone with no local runs");
  assert.equal(row.source, "remote");
  assert.equal(row.status, "paused");
  assert.equal(row.current_step_id, "approve");
  assert.equal(row.outcome, "paused");
  assert.match(row.remote_sha, /^[0-9a-f]{40}$/, "remote row carries the ref sha");
});

test("AC-B2: a run present locally and remotely is marked synced and keeps local detail", async () => {
  const { dir, bare } = repo({ remote: true });
  await stateStart({ projectRoot: dir, workflowSource: workflowFile({ gate: true }), runId: "b2-sync" });
  await stateAdvance({ projectRoot: dir, runId: "b2-sync", stepId: "one", status: "completed" });
  await statePause({ projectRoot: dir, runId: "b2-sync", stepId: "approve" });
  const handle = join(tempDir("board-handle-"), "handle.json");
  writeFileSync(handle, JSON.stringify({ channel: "C1", thread_ts: "1.0" }), "utf-8");
  parkRun(dir, "b2-sync", { handleFile: handle, remote: "origin" });

  // Same clone that ran it: local state exists AND the ref is on the remote.
  const board = buildBoardIndex({ projectRoot: dir, remote: "origin" });
  const row = byId(board.runs).get("b2-sync");
  assert.ok(row);
  assert.equal(row.source, "both");
  assert.equal(row.status, "paused");
  assert.match(row.remote_sha, /^[0-9a-f]{40}$/, "synced row carries the remote sha");
});

// ── AC-B3: graceful degradation ───────────────────────────────────────────

test("AC-B3: unreachable remote degrades to a local-only board with a warning", async () => {
  const { dir } = repo();
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "b3-local" });
  git(dir, "remote", "add", "origin", join(tempDir("board-dead-"), "nosuch.git"));

  const board = buildBoardIndex({ projectRoot: dir, remote: "origin" });
  assert.ok(board.remoteError, "remoteError must be set");
  const row = byId(board.runs).get("b3-local");
  assert.ok(row, "local run still listed");
  assert.equal(row.source, "local");

  const cli = spawnSync(process.execPath, [CLI, "workflow", "board"], {
    cwd: dir,
    encoding: "utf-8",
  });
  assert.equal(cli.status, 0, "board must exit 0 when the remote is unreachable");
  assert.ok((cli.stdout + cli.stderr).includes("b3-local"), "table still renders local runs");
  assert.ok((cli.stdout + cli.stderr).toLowerCase().includes("remote"), "a remote warning is shown");
});

test("AC-B3: a ref without state.json is skipped and counted, never fatal", async () => {
  const { dir, bare } = repo({ remote: true });
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "b3-good" });
  await stateAdvance({ projectRoot: dir, runId: "b3-good", stepId: "one", status: "failed", error: "x" });

  // A garbage "run ref": a commit whose tree has no state.json.
  const tree = git(dir, "mktree", "");
  const commit = git(dir, "commit-tree", tree, "-m", "garbage");
  git(dir, "push", "-q", bare, `+${commit}:refs/factory-runs/b3-garbage`);

  const board = buildBoardIndex({ projectRoot: dir, remote: "origin" });
  assert.equal(board.remoteError, null);
  assert.ok(board.skippedRemote >= 1, "garbage ref must be counted as skipped");
  assert.ok(byId(board.runs).get("b3-good"), "good run still listed");
  assert.ok(!byId(board.runs).has("b3-garbage"), "garbage ref must not appear");
});

// ── AC-B4: namespaced fetch never touches local refs/factory-runs ────────

test("AC-B4: the remote fetch lands in refs/remotes/<remote>/, not refs/factory-runs", async () => {
  const { dir, bare } = repo({ remote: true });
  await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "b4-local-only" });
  // Local ref pushed by syncRunRef belongs to the local namespace already.

  const b = join(tempDir("board-clone-"), "b");
  execFileSync("git", ["clone", "-q", bare, b]);
  configure(b);

  buildBoardIndex({ projectRoot: b, remote: "origin" });
  const remotes = git(b, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/factory-runs/");
  assert.ok(
    remotes.split("\n").includes("refs/remotes/origin/factory-runs/b4-local-only"),
    "fetched into refs/remotes namespace",
  );
  const localRefs = git(b, "for-each-ref", "--format=%(refname)", "refs/factory-runs/");
  assert.ok(!localRefs.includes("refs/factory-runs/b4-local-only"), "local refs/factory-runs untouched");
});
