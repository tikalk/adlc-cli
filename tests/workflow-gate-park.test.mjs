// Gate park & resume — adlc-cli slice of ADR-391-amendment-3-gate-park-and-
// resume (adlc-workspace#25). Builds on tests/workflow-gate-context*.test.mjs.
//
// Contract pinned here:
//   P1  A paused context gate's `gate_paused` and `permission_request` events
//       carry `head_sha` equal to the manifest's; a gate without `context`
//       emits neither (payload shape unchanged).
//   P2  A context gate whose `context.records` paths have uncommitted changes
//       (modified or untracked) FAILS with "uncommitted drafts: <paths>"
//       instead of pausing; committed records pause as before.
//   P3  A verdict for a gate that paused with a manifest whose head_sha is no
//       longer HEAD FAILS (halt) instead of re-pausing; no approved_sha is
//       recorded. A rejection is still honoured, and a verdict preset before
//       any pause still re-pauses (unchanged).
//   P4  `parkRun` saves the handle as runs/<id>/gate-handle.json and pushes
//       +refs/factory-runs/<id> to the remote; only a paused run parks.
//   P5  `restoreRun` fetches the ref and materializes runs/<id>/ in another
//       clone, which then resumes; it refuses an existing run dir and an
//       --issue-ref that differs from the run's inputs.issue_ref.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { parkRun, restoreRun } from "../src/workflow/refs.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "adlc-cli.mjs");

// ── fixture helpers (same shape as workflow-gate-context-6) ───────────────

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

// Same as git(), but feeds `input` on stdin (hash-object --stdin, mktree).
function gitIn(cwd, args, input) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", input }).trim();
}

function write(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function commitAll(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

function configure(dir) {
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
}

function pdr(title, status = "Proposed") {
  return `---\nstatus: ${status}\n---\n\n# ${title}\n\n## Decision Outcome\n\nWe decide ${title}.\n`;
}

// A repo with one committed PDR draft; run dirs are git-ignored.
function repo() {
  const dir = tempDir("gate-park-repo-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  write(dir, ".gitignore", ".adlc/workflows/\n");
  write(dir, ".adlc/drafts/pdr/PDR-001.md", pdr("Billing tiers"));
  const sha = commitAll(dir, "base");
  return { dir, sha };
}

const GATE = `  - id: review
    type: gate
    message: "Approve PDRs?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
    context:
      records: ["${PDR_GLOB}"]
      since: last_approved
`;
const PLAIN_GATE = `  - id: review
    type: gate
    message: "Approve?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
`;
const FIN = `  - id: fin
    type: shell
    run: "echo fin"
`;

function writeWorkflow(stepsYaml) {
  const path = join(tempDir("gate-park-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: park-wf
  name: Gate Park
  version: "1.0.0"
inputs:
  verdict: {type: string}
  issue_ref: {type: string, default: ""}
steps:
${stepsYaml}`, "utf-8");
  return path;
}

async function run(dir, stepsYaml, runId, inputs = { verdict: "" }) {
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const state = await engine.execute(engine.loadWorkflow(writeWorkflow(stepsYaml)), inputs, runId, STEP_REGISTRY);
  return { engine, events, state };
}

async function resume(dir, runId, inputs) {
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const state = await engine.resume(runId, inputs, STEP_REGISTRY);
  return { events, state };
}

function runDir(dir, runId) {
  return join(dir, ".adlc", "workflows", "runs", runId);
}
function persisted(dir, runId) {
  return JSON.parse(readFileSync(join(runDir(dir, runId), "state.json"), "utf-8"));
}

// ── P1: head_sha on gate events ───────────────────────────────────────────

test("P1: context gate events carry head_sha equal to HEAD", async () => {
  const { dir, sha } = repo();
  const { events, state } = await run(dir, GATE + FIN, "p1");
  assert.equal(state.status, RunStatus.PAUSED);
  const paused = events.find((e) => e.type === "gate_paused");
  const perm = events.find((e) => e.type === "permission_request");
  assert.equal(paused.head_sha, sha);
  assert.equal(perm.head_sha, sha);
});

test("P1: a gate without context emits no head_sha", async () => {
  const { dir } = repo();
  const { events } = await run(dir, PLAIN_GATE + FIN, "p1-plain");
  for (const type of ["gate_paused", "permission_request"]) {
    const e = events.find((x) => x.type === type);
    assert.ok(e, `${type} emitted`);
    assert.equal("head_sha" in e, false, `${type} must not carry head_sha`);
  }
});

// ── P2: uncommitted records halt the gate ─────────────────────────────────

test("P2: an untracked record under context.records fails the gate", async () => {
  const { dir } = repo();
  write(dir, ".adlc/drafts/pdr/PDR-002.md", pdr("Onboarding"));
  const { state } = await run(dir, GATE + FIN, "p2-untracked");
  assert.equal(state.status, RunStatus.FAILED);
  assert.match(state.error, /uncommitted drafts: .*\.adlc\/drafts\/pdr\/PDR-002\.md/);
});

test("P2: a modified record under context.records fails the gate", async () => {
  const { dir } = repo();
  write(dir, ".adlc/drafts/pdr/PDR-001.md", pdr("Billing tiers", "Accepted"));
  const { state } = await run(dir, GATE + FIN, "p2-modified");
  assert.equal(state.status, RunStatus.FAILED);
  assert.match(state.error, /uncommitted drafts: .*\.adlc\/drafts\/pdr\/PDR-001\.md/);
});

test("P2: a staged (git add, uncommitted) record under context.records fails the gate", async () => {
  const { dir } = repo();
  write(dir, ".adlc/drafts/pdr/PDR-003.md", pdr("Staged only"));
  git(dir, "add", ".adlc/drafts/pdr/PDR-003.md");
  const { state } = await run(dir, GATE + FIN, "p2-staged");
  assert.equal(state.status, RunStatus.FAILED);
  assert.match(state.error, /uncommitted drafts: .*\.adlc\/drafts\/pdr\/PDR-003\.md/);
});

test("P2: uncommitted files outside context.records do not block the gate", async () => {
  const { dir } = repo();
  write(dir, "src/scratch.js", "wip\n");
  const { state } = await run(dir, GATE + FIN, "p2-outside");
  assert.equal(state.status, RunStatus.PAUSED);
});

// ── P3: a moved head halts an answered gate ───────────────────────────────

test("P3: approve after HEAD moved since the pause fails, no approved_sha", async () => {
  const { dir } = repo();
  const { state } = await run(dir, GATE + FIN, "p3-approve");
  assert.equal(state.status, RunStatus.PAUSED);
  write(dir, "src/other.js", "x\n");
  commitAll(dir, "moves head");
  const { state: after } = await resume(dir, "p3-approve", { verdict: "approve" });
  assert.equal(after.status, RunStatus.FAILED);
  assert.match(after.error, /head moved/i);
  const gate = persisted(dir, "p3-approve").step_results.review;
  assert.equal(gate.status, StepStatus.FAILED);
  assert.equal(gate.output.approved_sha, undefined);
});

test("P3: reject after HEAD moved is still honoured", async () => {
  const { dir } = repo();
  await run(dir, GATE + FIN, "p3-reject");
  write(dir, "src/other.js", "x\n");
  commitAll(dir, "moves head");
  const { state } = await resume(dir, "p3-reject", { verdict: "reject" });
  assert.equal(state.status, RunStatus.ABORTED);
  assert.equal(persisted(dir, "p3-reject").step_results.review.output.choice, "reject");
});

test("P3: approve with an unchanged HEAD completes and records approved_sha", async () => {
  const { dir, sha } = repo();
  await run(dir, GATE + FIN, "p3-same");
  const { state } = await resume(dir, "p3-same", { verdict: "approve" });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(persisted(dir, "p3-same").step_results.review.output.approved_sha, sha);
});

test("P3: a verdict preset before any pause still re-pauses (unchanged)", async () => {
  const { dir } = repo();
  const { state } = await run(dir, GATE + FIN, "p3-preset", { verdict: "approve" });
  assert.equal(state.status, RunStatus.PAUSED);
});

// git failure is transient, unlike a genuinely moved head: fall through and
// re-pause, fail-closed, rather than halting (gate.mjs: headNow === null
// skips the moved-head-halt check entirely). Run state itself lives outside
// .git (gitignored per repo()'s .gitignore), so destroying .git only takes
// out git -- not the paused run's own files.
test("P3: HEAD unknown at resume (git destroyed) → re-pause, fail-closed", async () => {
  const { dir } = repo();
  const { state } = await run(dir, GATE + FIN, "p3-git-gone");
  assert.equal(state.status, RunStatus.PAUSED);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  const { state: after } = await resume(dir, "p3-git-gone", { verdict: "approve" });
  assert.equal(after.status, RunStatus.PAUSED, "HEAD unknown must not be approved blind");
  const gate = persisted(dir, "p3-git-gone").step_results.review;
  assert.equal(gate.status, StepStatus.PAUSED);
  assert.equal(gate.output.approved_sha, undefined);
  assert.equal(after.inputs.verdict, "", "the stale verdict is cleared, not silently reused on a later resume");
});

// ── P4/P5: park to a remote, restore in another clone ─────────────────────

// origin (bare) ← a: the run pauses and parks; b: a fresh clone restores.
function cloneSetup() {
  const bare = tempDir("gate-park-bare-");
  git(bare, "init", "-q", "--bare", "-b", "main");
  const { dir: a } = repo();
  git(a, "remote", "add", "origin", bare);
  git(a, "push", "-q", "origin", "main");
  const b = join(tempDir("gate-park-b-"), "b");
  execFileSync("git", ["clone", "-q", bare, b]);
  configure(b);
  return { bare, a, b };
}

const HANDLE = { channel: "C123", thread_ts: "1700000000.000100", request_id: "r1:review", step_id: "review", head_sha: "x", options: ["approve", "reject"], verdict_input: "verdict", issue_ref: "acme/repo#7" };

function handleFile() {
  const p = join(tempDir("gate-park-h-"), "handle.json");
  writeFileSync(p, JSON.stringify(HANDLE), "utf-8");
  return p;
}

test("P4: parkRun saves gate-handle.json and pushes the run ref to the remote", async () => {
  const { bare, a } = cloneSetup();
  await run(a, GATE + FIN, "p4", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p4", { handleFile: handleFile(), remote: "origin" });
  const local = JSON.parse(readFileSync(join(runDir(a, "p4"), "gate-handle.json"), "utf-8"));
  assert.deepEqual(local, HANDLE);
  const onRemote = git(bare, "show", "refs/factory-runs/p4:gate-handle.json");
  assert.deepEqual(JSON.parse(onRemote), HANDLE);
});

test("P4: parkRun refuses a run that is not paused", async () => {
  const { a } = cloneSetup();
  await run(a, FIN, "p4-done");
  assert.throws(() => parkRun(a, "p4-done", { handleFile: handleFile(), remote: "origin" }), /not paused/);
});

test("P5: restoreRun materializes the parked run in another clone, which resumes", async () => {
  const { a, b } = cloneSetup();
  await run(a, GATE + FIN, "p5", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p5", { handleFile: handleFile(), remote: "origin" });
  restoreRun(b, "p5", { remote: "origin", issueRef: "acme/repo#7" });
  for (const f of ["state.json", "inputs.json", "workflow.yml", "gate-handle.json"]) {
    assert.ok(existsSync(join(runDir(b, "p5"), f)), `${f} restored`);
  }
  const { state } = await resume(b, "p5", { verdict: "approve" });
  assert.equal(state.status, RunStatus.COMPLETED);
});

test("P5: restoreRun refuses an existing run dir", async () => {
  const { a } = cloneSetup();
  await run(a, GATE + FIN, "p5-exists", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p5-exists", { handleFile: handleFile(), remote: "origin" });
  assert.throws(() => restoreRun(a, "p5-exists", { remote: "origin" }), /already exists/);
});

// The loser of a concurrent restore must fail closed without touching
// anything the winner already wrote — restoreRun claims the run dir via a
// non-recursive mkdirSync (atomic at the filesystem level) before fetching,
// not an existsSync-then-write check that two racing calls could both pass.
test("P5: a second restoreRun for the same run_id does not delete what the first one wrote", async () => {
  const { a, b } = cloneSetup();
  await run(a, GATE + FIN, "p5-race", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p5-race", { handleFile: handleFile(), remote: "origin" });

  // Simulate the winner of the race: claim the directory and drop a sentinel
  // file nothing in restoreRun itself would ever write, standing in for
  // whatever the winner has materialized so far.
  const dir = runDir(b, "p5-race");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sentinel"), "winner-was-here", "utf-8");

  assert.throws(() => restoreRun(b, "p5-race", { remote: "origin" }), /already exists/);
  assert.equal(readFileSync(join(dir, "sentinel"), "utf-8"), "winner-was-here", "the loser must not delete the winner's data");
});

// The only way to get a tree entry whose flattened ls-tree -r path contains
// a ".." segment is raw plumbing (the OS itself refuses a literal ".."
// directory name) -- exactly the threat model the PR's own "Security notes"
// describe: anyone who can push refs/factory-runs/<run_id> controls what a
// restoring pod materializes.
test("P5: restoreRun ignores a path-traversal entry in a malicious parked ref", async () => {
  const { a, b } = cloneSetup();
  await run(a, GATE + FIN, "p5-traversal", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p5-traversal", { handleFile: handleFile(), remote: "origin" });

  const legitSha = gitIn(a, ["hash-object", "-w", "--stdin"], "legit content\n");
  const evilSha = gitIn(a, ["hash-object", "-w", "--stdin"], "pwned\n");
  const innerTree = gitIn(a, ["mktree"], `100644 blob ${evilSha}\toutside-evil.txt\n`);
  const topTree = gitIn(a, ["mktree"], `100644 blob ${legitSha}\tlegit.txt\n040000 tree ${innerTree}\t..\n`);
  // Verify the crafted tree really does flatten to a ".."-segment path
  // (pins the fixture itself, not just the code under test).
  assert.match(git(a, "ls-tree", "-r", topTree), /\.\.\/outside-evil\.txt/);
  const commit = gitIn(a, ["commit-tree", topTree, "-m", "malicious"], "");
  git(a, "update-ref", "refs/factory-runs/p5-traversal", commit);
  git(a, "push", "-q", "--force", "origin", "+refs/factory-runs/p5-traversal:refs/factory-runs/p5-traversal");

  const dir = restoreRun(b, "p5-traversal", { remote: "origin" });
  assert.equal(readFileSync(join(dir, "legit.txt"), "utf-8"), "legit content\n", "the legit entry still restores");
  const found = execFileSync("find", [b, "-name", "outside-evil.txt"], { encoding: "utf-8" }).trim();
  assert.equal(found, "", "the traversal entry must not be written anywhere under the clone");
});

test("P5: restoreRun refuses a mismatched issue ref and leaves no run dir", async () => {
  const { a, b } = cloneSetup();
  await run(a, GATE + FIN, "p5-issue", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p5-issue", { handleFile: handleFile(), remote: "origin" });
  assert.throws(() => restoreRun(b, "p5-issue", { remote: "origin", issueRef: "acme/repo#8" }), /issue_ref/);
  assert.equal(existsSync(runDir(b, "p5-issue")), false);
});

test("P4/P5: `workflow park` and `workflow restore` CLI round-trip", async () => {
  const { a, b } = cloneSetup();
  await run(a, GATE + FIN, "p45-cli", { verdict: "", issue_ref: "acme/repo#7" });
  const park = spawnSync(process.execPath, [CLI, "workflow", "park", "p45-cli", "--handle-file", handleFile(), "--remote", "origin"], { cwd: a, encoding: "utf-8" });
  assert.equal(park.status, 0, park.stderr);
  const restore = spawnSync(process.execPath, [CLI, "workflow", "restore", "p45-cli", "--remote", "origin", "--issue-ref", "acme/repo#7"], { cwd: b, encoding: "utf-8" });
  assert.equal(restore.status, 0, restore.stderr);
  assert.ok(existsSync(join(runDir(b, "p45-cli"), "gate-handle.json")));
});

test("P5: restoreRun rejects a remote that looks like an option (no git option injection)", async () => {
  const { a, b } = cloneSetup();
  await run(a, GATE + FIN, "p5-inject", { verdict: "", issue_ref: "acme/repo#7" });
  parkRun(a, "p5-inject", { handleFile: handleFile(), remote: "origin" });
  const marker = join(tempDir("gate-park-inj-"), "pwned");
  assert.throws(() => restoreRun(b, "p5-inject", { remote: `--upload-pack=touch ${marker}` }), /invalid remote/);
  assert.equal(existsSync(marker), false, "the injected command must never run");
  assert.throws(() => parkRun(a, "p5-inject", { handleFile: handleFile(), remote: "--receive-pack=x" }), /invalid remote/);
});
