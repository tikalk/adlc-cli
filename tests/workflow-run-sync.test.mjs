// Phase 0 — durable run transport (ADR-475/477/478).
//
// Contract pinned here:
//   AC-1  stateAdvance pushes refs/factory-runs/<id> to origin; the remote
//         state.json reflects the advanced step.
//   AC-2  ADLC_WORKFLOW_PUSH_INTERVAL throttles advance pushes; 0 forces them.
//   AC-3  parkRun redacts secrets out of the run dir before pushing: the
//         remote blobs and the local files carry "***", never the value.
//   AC-4  the pushed tree excludes lease.json and .push-ts (ADR-477); a
//         restored clone is claimable and resumes.
//   AC-5  a missing/unreachable remote never fails an advance (fail-soft).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { stateStart, stateAdvance, statePause } from "../src/workflow/state.mjs";
import { parkRun, restoreRun } from "../src/workflow/refs.mjs";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

// A repo with run dirs git-ignored; origin (bare) wired when asked.
function repo({ remote = false } = {}) {
  const dir = tempDir("sync-repo-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  write(dir, ".gitignore", ".adlc/workflows/\n");
  write(dir, "README.md", "base\n");
  commitAll(dir, "base");
  let bare = null;
  if (remote) {
    bare = tempDir("sync-bare-");
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "origin", "main");
  }
  return { dir, bare };
}

function cloneOf(bare) {
  const b = join(tempDir("sync-clone-"), "b");
  execFileSync("git", ["clone", "-q", bare, b]);
  configure(b);
  return b;
}

function workflowFile() {
  const path = join(tempDir("sync-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: sync-wf
  name: Sync
  version: "1.0.0"
steps:
  - id: one
    type: shell
    run: "echo one"
  - id: two
    type: shell
    run: "echo two"
`, "utf-8");
  return path;
}

function runDir(dir, runId) {
  return join(dir, ".adlc", "workflows", "runs", runId);
}

// Run a test body with a temporary ADLC_WORKFLOW_PUSH_INTERVAL value.
async function withPushInterval(seconds, fn) {
  const prev = process.env.ADLC_WORKFLOW_PUSH_INTERVAL;
  process.env.ADLC_WORKFLOW_PUSH_INTERVAL = String(seconds);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.ADLC_WORKFLOW_PUSH_INTERVAL;
    else process.env.ADLC_WORKFLOW_PUSH_INTERVAL = prev;
  }
}

function remoteRefSha(bare, runId) {
  const out = git(bare, "rev-parse", `refs/factory-runs/${runId}`);
  return out;
}

function remoteShow(bare, runId, path) {
  return git(bare, "show", `refs/factory-runs/${runId}:${path}`);
}

function remoteTree(bare, runId) {
  return git(bare, "ls-tree", "-r", "--name-only", `refs/factory-runs/${runId}`).split("\n").filter(Boolean);
}

// ── AC-1: advance pushes to origin ────────────────────────────────────────

test("AC-1: stateAdvance pushes the run ref to origin with the advanced state", async () => {
  const { dir, bare } = repo({ remote: true });
  await withPushInterval(0, async () => {
    await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "ac1" });
    assert.ok(remoteRefSha(bare, "ac1"), "start must push the run ref");
    await stateAdvance({ projectRoot: dir, runId: "ac1", stepId: "one", status: "completed" });
    const remote = JSON.parse(remoteShow(bare, "ac1", "state.json"));
    assert.equal(remote.current_step_index, 1);
    assert.equal(remote.step_results.one.status, "completed");
  });
});

// ── AC-2: throttle ────────────────────────────────────────────────────────

test("AC-2: advance pushes are throttled inside the interval and forced at 0", async () => {
  const { dir, bare } = repo({ remote: true });
  await withPushInterval(3600, async () => {
    await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "ac2" });
    const afterStart = remoteRefSha(bare, "ac2");
    await stateAdvance({ projectRoot: dir, runId: "ac2", stepId: "one", status: "completed" });
    assert.equal(remoteRefSha(bare, "ac2"), afterStart, "advance inside the interval must not push");
    const local = JSON.parse(readFileSync(join(runDir(dir, "ac2"), "state.json"), "utf-8"));
    assert.equal(local.current_step_index, 1, "local state still advances");
  });
  await withPushInterval(0, async () => {
    await stateAdvance({ projectRoot: dir, runId: "ac2", stepId: "two", status: "completed" });
    const remote = JSON.parse(remoteShow(bare, "ac2", "state.json"));
    assert.equal(remote.status, RunStatus.COMPLETED);
  });
});

// ── AC-3: park-time redaction ─────────────────────────────────────────────

test("AC-3: parkRun redacts secret values from the local run dir and the pushed ref", async () => {
  const SECRET = "supersecretvalue123456";
  const { dir, bare } = repo({ remote: true });
  const prev = process.env.TEST_TOKEN;
  process.env.TEST_TOKEN = SECRET;
  try {
    await withPushInterval(0, async () => {
      await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "ac3" });
      await stateAdvance({ projectRoot: dir, runId: "ac3", stepId: "one", status: "completed" });
      await statePause({ projectRoot: dir, runId: "ac3", stepId: "two" });

      // Seed the secret the way a real leak would: into the persisted log and state.
      const logPath = join(runDir(dir, "ac3"), "log.jsonl");
      const priorLog = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
      writeFileSync(logPath, priorLog + `{"event":"leak","note":"token ${SECRET}"}\n`, "utf-8");
      const statePath = join(runDir(dir, "ac3"), "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      state.error = `leaked ${SECRET}`;
      writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

      const handle = join(tempDir("sync-handle-"), "handle.json");
      writeFileSync(handle, JSON.stringify({ channel: "C1", thread_ts: "1.0" }), "utf-8");
      parkRun(dir, "ac3", { handleFile: handle, remote: "origin" });

      for (const rel of ["log.jsonl", "state.json"]) {
        const localText = readFileSync(join(runDir(dir, "ac3"), rel), "utf-8");
        assert.ok(!localText.includes(SECRET), `local ${rel} must be redacted`);
        assert.ok(localText.includes("***"), `local ${rel} must carry the mask`);
        const remoteText = remoteShow(bare, "ac3", rel);
        assert.ok(!remoteText.includes(SECRET), `remote ${rel} must not leak`);
        assert.ok(remoteText.includes("***"), `remote ${rel} must carry the mask`);
      }
    });
  } finally {
    if (prev === undefined) delete process.env.TEST_TOKEN;
    else process.env.TEST_TOKEN = prev;
  }
});

// ── AC-4: machine-local files stay out of the ref; restore is claimable ───

test("AC-4: the pushed tree excludes lease.json and .push-ts; restore resumes", async () => {
  const { dir, bare } = repo({ remote: true });
  await withPushInterval(0, async () => {
    await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "ac4" });
    await stateAdvance({ projectRoot: dir, runId: "ac4", stepId: "one", status: "completed" });
    await statePause({ projectRoot: dir, runId: "ac4", stepId: "two" });

    // A live foreign lease + the throttle stamp exist locally at park time.
    write(join(dir, ".adlc", "workflows", "runs", "ac4"), "lease.json", JSON.stringify({
      run_id: "ac4", holder: "otherhost:4242", heartbeat_ts: Date.now(), ttl_seconds: 3600, pid: 4242, hostname: "otherhost",
    }));
    assert.ok(existsSync(join(runDir(dir, "ac4"), ".push-ts")), "sync writes the throttle stamp");

    const handle = join(tempDir("sync-handle-"), "handle.json");
    writeFileSync(handle, JSON.stringify({ channel: "C1", thread_ts: "1.0" }), "utf-8");
    parkRun(dir, "ac4", { handleFile: handle, remote: "origin" });

    const tree = remoteTree(bare, "ac4");
    assert.ok(!tree.includes("lease.json"), `lease.json must not cross machines (tree: ${tree.join(", ")})`);
    assert.ok(!tree.includes(".push-ts"), ".push-ts must not cross machines");

    const b = cloneOf(bare);
    restoreRun(b, "ac4", { remote: "origin" });
    assert.ok(!existsSync(join(runDir(b, "ac4"), "lease.json")), "restored run must not inherit a foreign lease");

    const engine = new WorkflowEngine(b);
    const state = await engine.resume("ac4", null, STEP_REGISTRY);
    assert.equal(state.status, RunStatus.COMPLETED, "restored run must resume without a lease conflict");
  });
});

// ── AC-5: fail-soft without a remote ──────────────────────────────────────

test("AC-5: advance without an origin still succeeds (fail-soft push)", async () => {
  const { dir } = repo({ remote: false });
  await withPushInterval(0, async () => {
    await stateStart({ projectRoot: dir, workflowSource: workflowFile(), runId: "ac5" });
    const state = await stateAdvance({ projectRoot: dir, runId: "ac5", stepId: "one", status: "completed" });
    assert.equal(state.currentStepIndex, 1);
    assert.ok(existsSync(join(runDir(dir, "ac5"), "state.json")));
  });
});

// Keep CLI_ROOT referenced so the test fails loudly if the worktree moves.
test("worktree layout sanity", () => {
  assert.ok(existsSync(join(CLI_ROOT, "bin", "adlc-cli.mjs")));
});
