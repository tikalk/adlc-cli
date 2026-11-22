// Gate Decision Manifest — iteration 7: runs dispatched onto a target branch.
// Builds on tests/workflow-gate-context{,-2,-3,-4,-5,-6}.test.mjs.
//
// A run dispatched with `target-branch::<name>` (adlc-team-skills#188,
// adlc-argo-wf!104) is cloned with `git clone --branch <name> --single-branch`,
// so the clone has origin/<name> and nothing else: no origin/HEAD, no
// origin/main. Before this fix the gate only looked for origin/HEAD,
// origin/main, origin/master, main, master and said "Decision list
// unavailable: no target branch (…) to compare against".
//
// Contract pinned here:
//   TB1  With a target branch (env ADLC_TARGET_BRANCH, else the run's
//        `target_branch` input, else `target_branch` in the WORKFLOW_INPUTS
//        JSON), the base is the merge-base of HEAD with origin/<target>, ahead
//        of the default candidates.
//   TB2  origin/<target> missing locally → one
//        `git fetch origin +refs/heads/<t>:refs/remotes/origin/<t>`, then retry.
//   TB3  origin/<target> missing on the remote too → the default candidates
//        decide, exactly as without a target branch; when none exists the
//        reason lists origin/<target> first, kind `no-target-branch`.
//   TB4  No target branch set → identical manifest to before.
//   TB5  The name is validated like a git branch name and never reaches git
//        as an option; an invalid name counts as "no target branch".

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import {
  TARGET_BRANCH_ENV,
  buildGateManifest,
  runTargetBranch,
  safeBranchName,
} from "../src/workflow/gate-context.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";
const TARGET = "factory-test/x";

// ── fixture helpers ───────────────────────────────────────────────────────

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
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

function record(title, decision) {
  return ["---", "status: Proposed", "---", "", `# ${title}`, "", "## Decision Outcome", "", decision, ""].join("\n");
}

// A bare remote built from a seed repo. `branches` maps branch name → list
// of PDR files committed on it, in order; the first branch is the remote's
// HEAD. Later branches fork from the first.
function remoteWith(branches) {
  const names = Object.keys(branches);
  const seed = tempDir("gate-ctx7-seed-");
  git(seed, "init", "-q", "-b", names[0]);
  configure(seed);
  write(seed, ".gitignore", ".adlc/workflows/\n");
  write(seed, "README.md", "seed\n");
  commitAll(seed, "seed");
  const tips = {};
  for (const [i, name] of names.entries()) {
    if (i > 0) git(seed, "checkout", "-q", "-b", name, names[0]);
    for (const file of branches[name]) {
      write(seed, `.adlc/drafts/pdr/${file}`, record(file, `We decide ${file}.`));
      commitAll(seed, `${name}: ${file}`);
    }
    tips[name] = git(seed, "rev-parse", "HEAD");
  }
  git(seed, "checkout", "-q", names[0]);
  const remote = join(tempDir("gate-ctx7-remote-"), "remote.git");
  git(dirname(remote), "clone", "-q", "--bare", seed, remote);
  return { remote, tips };
}

// What the mission pod does: a single-branch clone of `branch`, then a
// mission branch adding PDR-900 on top.
function missionClone(remote, branch) {
  const parent = tempDir("gate-ctx7-clone-");
  const dir = join(parent, "workspace");
  git(parent, "clone", "-q", "--branch", branch, "--single-branch", remote, dir);
  configure(dir);
  git(dir, "checkout", "-q", "-b", "mission/1532");
  write(dir, ".adlc/drafts/pdr/PDR-900.md", record("Mission decision", "We decide in the mission."));
  const head = commitAll(dir, "mission work");
  return { dir, head };
}

const paths = (m) => m.decisions.map((d) => d.path);

// ── TB1: the bug, and the fix, on a single-branch clone ──────────────────

test("TB1: single-branch clone of factory-test/x → without a target the list is unavailable (the bug)", () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const { dir } = missionClone(remote, TARGET);
  assert.equal(git(dir, "for-each-ref", "--format=%(refname)", "refs/remotes"), `refs/remotes/origin/${TARGET}`, "fixture: only remote branch");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.unavailable_kind, "no-target-branch");
  assert.equal(m.unavailable, "no target branch (origin/HEAD, origin/main, origin/master, main, master) to compare against");
});

test("TB1: single-branch clone of factory-test/x + targetBranch → compares against origin/factory-test/x", () => {
  const { remote, tips } = remoteWith({ [TARGET]: ["PDR-100.md"] });
  const { dir, head } = missionClone(remote, TARGET);
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: TARGET });
  assert.equal(m.unavailable, null, `list must be built: ${m.unavailable}`);
  assert.equal(m.since_basis, "merge-base");
  assert.equal(m.since_sha, tips[TARGET], "base is the target branch tip");
  assert.equal(m.head_sha, head);
  assert.deepEqual(paths(m), [".adlc/drafts/pdr/PDR-900.md"], "only the mission's record, not the target's PDR-100");
});

test("TB1: target branch wins over origin/main when both exist", () => {
  // main has nothing; the target branch already carries PDR-200 (approved
  // there). Compared against main, PDR-200 would be listed as the mission's.
  const { remote, tips } = remoteWith({ main: [], [TARGET]: ["PDR-200.md"] });
  const parent = tempDir("gate-ctx7-full-");
  const dir = join(parent, "workspace");
  git(parent, "clone", "-q", remote, dir); // full clone: origin/HEAD → main
  configure(dir);
  git(dir, "checkout", "-q", "-b", "mission/1", `origin/${TARGET}`);
  write(dir, ".adlc/drafts/pdr/PDR-900.md", record("Mission", "We decide."));
  commitAll(dir, "mission");

  const without = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.deepEqual(paths(without), [".adlc/drafts/pdr/PDR-200.md", ".adlc/drafts/pdr/PDR-900.md"], "fixture: main as base lists the target's record too");

  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: TARGET });
  assert.equal(m.since_sha, tips[TARGET]);
  assert.deepEqual(paths(m), [".adlc/drafts/pdr/PDR-900.md"]);
});

test("TB1: HEAD on the target branch itself → run-start basis, as on main", () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const parent = tempDir("gate-ctx7-on-target-");
  const dir = join(parent, "workspace");
  git(parent, "clone", "-q", "--branch", TARGET, "--single-branch", remote, dir);
  configure(dir);
  const start = git(dir, "rev-parse", "HEAD");
  write(dir, ".adlc/drafts/pdr/PDR-901.md", record("On target", "We decide."));
  commitAll(dir, "on target");
  // The push moves origin/<target> too (no plain fetch: newer git would also
  // create origin/HEAD, which the default candidates would then find).
  git(dir, "push", "-q", "origin", `HEAD:${TARGET}`);
  assert.equal(git(dir, "for-each-ref", "--format=%(refname)", "refs/remotes"), `refs/remotes/origin/${TARGET}`, "fixture: only remote branch");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: TARGET, runStartSha: start });
  assert.equal(m.since_basis, "run-start");
  assert.equal(m.since_sha, start);
  assert.deepEqual(paths(m), [".adlc/drafts/pdr/PDR-901.md"]);
});

// ── TB2: one fetch when origin/<target> is missing locally ───────────────

test("TB2: origin/<target> missing locally → fetched once, then used", () => {
  const { remote, tips } = remoteWith({ [TARGET]: ["PDR-100.md"] });
  const { dir } = missionClone(remote, TARGET);
  git(dir, "update-ref", "-d", `refs/remotes/origin/${TARGET}`);
  assert.equal(git(dir, "for-each-ref", "refs/remotes"), "", "fixture: no remote-tracking ref left");

  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: TARGET });
  assert.equal(m.unavailable, null, `list must be built after the fetch: ${m.unavailable}`);
  assert.equal(m.since_sha, tips[TARGET]);
  assert.deepEqual(paths(m), [".adlc/drafts/pdr/PDR-900.md"]);
  assert.equal(git(dir, "rev-parse", `refs/remotes/origin/${TARGET}`), tips[TARGET], "the fetch wrote the remote-tracking ref");
});

// ── TB3: target missing everywhere → the default candidates decide ───────

test("TB3: target missing on the remote, origin/main exists → same manifest as without a target", () => {
  const { remote } = remoteWith({ main: ["PDR-100.md"] });
  const parent = tempDir("gate-ctx7-fallback-");
  const dir = join(parent, "workspace");
  git(parent, "clone", "-q", remote, dir);
  configure(dir);
  git(dir, "checkout", "-q", "-b", "mission/2");
  write(dir, ".adlc/drafts/pdr/PDR-900.md", record("Mission", "We decide."));
  commitAll(dir, "mission");

  const without = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const withMissing = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: "no-such-branch" });
  assert.equal(without.unavailable, null);
  assert.deepEqual(withMissing, without);
});

test("TB3: target missing and no default candidate → reason lists origin/<target> first", () => {
  const { remote } = remoteWith({ develop: [] });
  const { dir } = missionClone(remote, "develop");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: "release/9" });
  assert.equal(m.unavailable_kind, "no-target-branch");
  assert.equal(m.unavailable, "no target branch (origin/release/9, origin/HEAD, origin/main, origin/master, main, master) to compare against");
});

// ── TB4: no target branch → unchanged ─────────────────────────────────────

test("TB4: no target (null, empty, invalid) → identical manifest to the call without one", () => {
  const { remote } = remoteWith({ main: ["PDR-100.md"] });
  const parent = tempDir("gate-ctx7-same-");
  const dir = join(parent, "workspace");
  git(parent, "clone", "-q", remote, dir);
  configure(dir);
  git(dir, "checkout", "-q", "-b", "mission/3");
  write(dir, ".adlc/drafts/pdr/PDR-900.md", record("Mission", "We decide."));
  commitAll(dir, "mission");
  const base = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  for (const targetBranch of [null, undefined, "", "   ", "bad name", "--upload-pack=x"]) {
    assert.deepEqual(buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch }), base, JSON.stringify(targetBranch));
  }
});

// ── TB5: validation ───────────────────────────────────────────────────────

test("TB5: safeBranchName accepts git branch names and rejects anything else", () => {
  for (const ok of ["main", "factory-test/retest-1336", "release/1.2.3", "feat/a_b+c", "x"]) {
    assert.equal(safeBranchName(ok), ok, ok);
  }
  assert.equal(safeBranchName("refs/heads/factory-test/x"), "factory-test/x", "refs/heads/ prefix dropped");
  assert.equal(safeBranchName("  main\n"), "main", "surrounding whitespace trimmed");
  for (const bad of [
    "", " ", "HEAD", "-x", "--upload-pack=touch /tmp/p", "a..b", "a//b", "/a", "a/", "a.", ".a", "a/.b",
    "a.lock", "a/b.lock/c", "a b", "a\tb", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a@{1}", "$(id)",
    "a;b", "a|b", "a<b>", "a`b`", "ä", "a‮b", "x".repeat(256), null, undefined, 42, {},
  ]) {
    assert.equal(safeBranchName(bad), null, JSON.stringify(bad));
  }
});

test("TB5: an option-looking target never reaches git as an option", () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const { dir } = missionClone(remote, TARGET);
  git(dir, "update-ref", "-d", `refs/remotes/origin/${TARGET}`);
  const marker = join(tempDir("gate-ctx7-marker-"), "pwned");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir, targetBranch: `--upload-pack=touch ${marker}` });
  assert.equal(m.unavailable_kind, "no-target-branch", "treated as no target branch");
  assert.equal(existsSync(marker), false, "nothing was executed");
});

test("TB5: runTargetBranch — env, then inputs.target_branch, then WORKFLOW_INPUTS; invalid values skipped", () => {
  const wi = (v) => JSON.stringify({ issue_ref: "x#1", target_branch: v });
  assert.equal(runTargetBranch({ env: {}, inputs: {} }), null);
  assert.equal(runTargetBranch({ env: {}, inputs: null }), null);
  assert.equal(runTargetBranch({ env: { [TARGET_BRANCH_ENV]: "a" }, inputs: { target_branch: "b" } }), "a");
  assert.equal(runTargetBranch({ env: { WORKFLOW_INPUTS: wi("c") }, inputs: { target_branch: "b" } }), "b");
  assert.equal(runTargetBranch({ env: { WORKFLOW_INPUTS: wi("c") }, inputs: {} }), "c");
  assert.equal(runTargetBranch({ env: { [TARGET_BRANCH_ENV]: "", WORKFLOW_INPUTS: wi("c") } }), "c", "empty env var is unset");
  assert.equal(runTargetBranch({ env: { [TARGET_BRANCH_ENV]: "-bad" }, inputs: { target_branch: "b" } }), "b", "invalid env skipped");
  assert.equal(runTargetBranch({ env: { WORKFLOW_INPUTS: "{not json" } }), null);
  assert.equal(runTargetBranch({ env: { WORKFLOW_INPUTS: "[\"a\"]" } }), null);
  assert.equal(runTargetBranch({ env: { WORKFLOW_INPUTS: JSON.stringify({ target_branch: 7 }) } }), null);
});

// ── engine: the gate step reads the run's target branch ──────────────────

function writeWorkflow(inputNames) {
  const wfDir = tempDir("gate-ctx7-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf7
  name: Context Gate 7
  version: "1.0.0"
inputs:
${inputNames.map((i) => `  ${i}: {type: string, default: ""}`).join("\n")}
steps:
  - id: gate-spec
    type: gate
    message: "Approve the spec?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
    context:
      records: ["${PDR_GLOB}"]
      since: last_approved
`, "utf-8");
  return path;
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of [TARGET_BRANCH_ENV, "WORKFLOW_INPUTS"]) {
    saved[key] = process.env[key];
    if (key in vars) process.env[key] = vars[key];
    else delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function pausedGate(dir, runId, inputs, inputNames) {
  const engine = new WorkflowEngine(dir);
  const state = await engine.execute(engine.loadWorkflow(writeWorkflow(inputNames)), inputs, runId, STEP_REGISTRY);
  assert.equal(state.status, RunStatus.PAUSED, JSON.stringify(state.stepResults["gate-spec"]));
  assert.equal(state.stepResults["gate-spec"].status, StepStatus.PAUSED);
  return state.stepResults["gate-spec"].output;
}

const LISTED = "1 product decision to approve (since merge-base @";

test("engine: no target branch on a single-branch clone → 'Decision list unavailable' (the retest symptom)", async () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const { dir } = missionClone(remote, TARGET);
  const out = await withEnv({}, () => pausedGate(dir, "g7e00001", { verdict: "" }, ["verdict"]));
  assert.ok(out.message.includes("Decision list unavailable: no target branch (origin/HEAD, origin/main, origin/master, main, master) to compare against."), out.message);
});

test("engine: ADLC_TARGET_BRANCH → the gate lists the mission's decision", async () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const { dir } = missionClone(remote, TARGET);
  const out = await withEnv({ [TARGET_BRANCH_ENV]: TARGET }, () => pausedGate(dir, "g7e00002", { verdict: "" }, ["verdict"]));
  assert.ok(out.message.includes(LISTED), out.message);
  assert.ok(out.message.includes("PDR-900"), out.message);
  assert.equal(out.unavailable_kind, undefined);
});

test("engine: declared target_branch input → the gate lists the mission's decision", async () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const { dir } = missionClone(remote, TARGET);
  const out = await withEnv({}, () =>
    pausedGate(dir, "g7e00003", { verdict: "", target_branch: TARGET }, ["verdict", "target_branch"]));
  assert.ok(out.message.includes(LISTED), out.message);
});

test("engine: WORKFLOW_INPUTS.target_branch (input not declared) → the gate lists the mission's decision", async () => {
  const { remote } = remoteWith({ [TARGET]: [] });
  const { dir } = missionClone(remote, TARGET);
  const out = await withEnv({ WORKFLOW_INPUTS: JSON.stringify({ target_branch: TARGET, issue_ref: "g/p#1532" }) }, () =>
    pausedGate(dir, "g7e00004", { verdict: "" }, ["verdict"]));
  assert.ok(out.message.includes(LISTED), out.message);
});
