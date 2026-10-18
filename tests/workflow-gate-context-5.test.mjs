// Gate Decision Manifest — iteration 5 (factory-review self-heal on
// tikalk/adlc-cli#39, iteration 3: T2, T3, T4). Builds on
// tests/workflow-gate-context{,-2,-3,-4}.test.mjs.
//
// Contract pinned here:
//   T2  (refines S1, fail closed) A context gate's output carries a
//       machine-readable `unavailable_kind` next to the human
//       `unavailable_reason` whenever the decision list is unavailable, and
//       both are persisted in the PAUSED output. Kinds:
//         not-a-git-repo   — project root not in a git work tree / no history
//         no-target-branch — none of origin/HEAD, origin/main, origin/master,
//                            main, master exists
//         error            — anything else (git ENOENT/spawn error, timeout,
//                            rev-parse/diff/show failure, maxBuffer)
//       "Approve without list" is accepted ONLY when the shown (paused) kind
//       and the fresh kind at resume are identical AND permanent
//       (not-a-git-repo | no-target-branch); the completed output and the
//       `gate_approved` audit entry carry `unavailable_kind`. A transient
//       (`error`) kind, or shown kind != fresh kind, re-pauses: verdict
//       cleared, nothing approved, no audit entry.
//   T3  safeMrLink also rejects userinfo (`user:tok@`, `user@`), any
//       backslash, length > 2048, U+2060–U+2064 and U+00AD. Normal GitLab
//       `/-/merge_requests/N` and GitHub `/pull/N` URLs with `?x=1#y` stay
//       accepted.
//   T4  (regression guard) A record filename carrying ESC is listed as
//       `(unprintable path)`; neither the message nor decisions[] carry \x1b.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, chmodSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { buildGateManifest, renderGateMessage, safeMrLink } from "../src/workflow/gate-context.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";
const POSIX_ONLY = { skip: process.platform === "win32" };

// ── fixture helpers (same shape as workflow-gate-context-4) ───────────────

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

function commitAll(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

function record({ id = null, title, status = "Proposed", decision }) {
  const fm = ["---"];
  if (id) fm.push(`id: ${id}`);
  fm.push(`status: ${status}`, "---", "");
  return [...fm, `# ${title}`, "", "## Decision Outcome", "", decision, "", "## Consequences", "", "Some.", ""].join("\n");
}

function initRepo(branch = "main", prefix = "gate-ctx5-repo-") {
  const dir = tempDir(prefix);
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, ".gitignore", ".adlc/workflows/\n");
  return dir;
}

// main: PDR-100. feature/x: adds PDR-127.
function featureRepo() {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Old decision", decision: "We keep the old thing." }));
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/x");
  write(dir, ".adlc/drafts/pdr/PDR-127.md", record({ title: "Self-serve onboarding", decision: "We ship self-serve onboarding." }));
  const headSha = commitAll(dir, "feature work");
  return { dir, baseSha, headSha };
}

// Only branch is `develop` (no main/master/origin).
function developRepo() {
  const dir = initRepo("develop");
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  write(dir, ".adlc/drafts/pdr/PDR-7.md", record({ title: "Develop decision", decision: "We decide on develop." }));
  commitAll(dir, "pdr");
  return { dir };
}

function nonGitDir() {
  const dir = tempDir("gate-ctx5-nogit-");
  write(dir, ".adlc/drafts/pdr/PDR-1.md", record({ title: "x", decision: "y." }));
  return dir;
}

function gateYaml({ id = "review", verdict = "verdict", message = "Approve decisions?", records = [PDR_GLOB], extraContext = "" } = {}) {
  return `  - id: ${id}
    type: gate
    message: "${message}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: ${verdict}
    context:
      records: [${records.map((r) => `"${r}"`).join(", ")}]
      since: last_approved
${extraContext}`;
}

const FIN = `  - id: fin
    type: shell
    run: "echo fin"
`;

function writeWorkflow(stepsYaml, inputs = ["verdict"]) {
  const wfDir = tempDir("gate-ctx5-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf5
  name: Context Gate 5
  version: "1.0.0"
inputs:
${inputs.map((i) => `  ${i}: {type: string}`).join("\n")}
steps:
${stepsYaml}`, "utf-8");
  return path;
}

async function runWorkflow(dir, stepsYaml, runId, inputs = { verdict: "" }, inputNames = ["verdict"]) {
  const path = writeWorkflow(stepsYaml, inputNames);
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const state = await engine.execute(engine.loadWorkflow(path), inputs, runId, STEP_REGISTRY);
  return { engine, events, state };
}

function runDir(dir, runId) {
  return join(dir, ".adlc", "workflows", "runs", runId);
}
function persistedState(dir, runId) {
  return JSON.parse(readFileSync(join(runDir(dir, runId), "state.json"), "utf-8"));
}
function logEntries(dir, runId) {
  const p = join(runDir(dir, runId), "log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Runs `fn` with PATH replaced by `pathValue` (restored afterwards).
async function withPath(pathValue, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = pathValue;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

// A fake `git` (POSIX sh) that exits non-zero for `git diff …` and execs the
// real git for everything else: a transient failure mid-manifest.
function diffFailingGitDir() {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
  const shimDir = tempDir("gate-ctx5-shim-");
  writeFileSync(
    join(shimDir, "git"),
    `#!/bin/sh\ncase "$1" in\n  diff) exit 128 ;;\nesac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shimDir, "git"), 0o755);
  return shimDir;
}

// Asserts a resume left the gate paused with nothing approved.
function assertRePausedNothingApproved(dir, runId, s2, events) {
  assert.equal(s2.status, RunStatus.PAUSED, `must fail closed (re-pause): ${JSON.stringify(s2.stepResults.review)}`);
  assert.equal(s2.currentStepId, "review");
  assert.equal(s2.stepResults.review.status, StepStatus.PAUSED);
  const out2 = s2.stepResults.review.output;
  assert.equal(out2.approved_sha, undefined, "no approved_sha");
  assert.notEqual(out2.without_list, true, "not approved without list");
  assert.equal(s2.inputs.verdict, "", "bound verdict cleared");
  assert.equal(s2.stepResults.fin, undefined, "the run does not continue past the gate");
  assert.ok(events.some((e) => e.type === "gate_paused" && e.step_id === "review"), "gate_paused re-emitted");
  assert.equal(persistedState(dir, runId).last_approved_sha, undefined);
  assert.ok(!logEntries(dir, runId).some((e) => e.event === "gate_approved"), "no gate_approved audit entry");
}

// ── T2: permanent kinds still complete with ONE approve ───────────────────

async function assertPermanentKindApproveCompletes(dir, runId, kind) {
  const { engine, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, runId);
  assert.equal(s1.status, RunStatus.PAUSED);
  const out1 = s1.stepResults.review.output;
  assert.ok(out1.message.includes("Decision list unavailable"), out1.message);
  assert.equal(out1.head_sha, null, "fixture: unavailable manifest has head_sha null");
  assert.equal(out1.unavailable_kind, kind, `paused output carries unavailable_kind: ${JSON.stringify(out1)}`);
  assert.equal(typeof out1.unavailable_reason, "string", "paused output carries the human unavailable_reason");
  assert.ok(out1.unavailable_reason.length > 0);
  const persisted = persistedState(dir, runId).step_results?.review?.output;
  assert.equal(persisted?.unavailable_kind, kind, "unavailable_kind persisted in state.json's paused output");

  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume(runId, { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED, `same permanent kind (${kind}) → approve completes`);
  const out2 = s2.stepResults.review.output;
  assert.equal(out2.choice, "approve");
  assert.equal(out2.approved_sha, undefined);
  assert.equal(out2.without_list, true);
  assert.equal(out2.unavailable_kind, kind);
  assert.equal(s2.stepResults.fin?.status, StepStatus.COMPLETED);
  assert.ok(!events.some((e) => e.type === "gate_paused"), "no re-pause");

  const audit = logEntries(dir, runId).filter((e) => e.event === "gate_approved");
  assert.equal(audit.length, 1, JSON.stringify(audit));
  assert.equal(audit[0].without_list, true);
  assert.equal(audit[0].unavailable_kind, kind, `audit carries unavailable_kind: ${JSON.stringify(audit[0])}`);
  assert.deepEqual(audit[0].decisions, []);
}

test("T2: non-git project → unavailable_kind 'not-a-git-repo' at pause; ONE approve completes; audit carries the kind", async () => {
  await assertPermanentKindApproveCompletes(nonGitDir(), "g5t20001", "not-a-git-repo");
});

test("T2: develop-only repo → unavailable_kind 'no-target-branch' at pause; ONE approve completes; audit carries the kind", async () => {
  const { dir } = developRepo();
  await assertPermanentKindApproveCompletes(dir, "g5t20002", "no-target-branch");
});

test("T2 guard: an available list carries no unavailable_kind (expected to pass now)", async () => {
  const { dir } = featureRepo();
  const { state } = await runWorkflow(dir, gateYaml() + FIN, "g5t20003");
  const out = state.stepResults.review.output;
  assert.equal(state.status, RunStatus.PAUSED);
  assert.ok(Array.isArray(out.decisions) && out.decisions.length === 1);
  assert.ok(out.unavailable_kind === undefined || out.unavailable_kind === null, JSON.stringify(out.unavailable_kind));
});

// ── T2: transient failures fail closed ────────────────────────────────────

test("T2: transient `git diff` failure at pause AND resume → kind 'error', re-pauses, nothing approved", POSIX_ONLY, async () => {
  const { dir } = featureRepo();
  const shimDir = diffFailingGitDir();
  const path = `${shimDir}:${process.env.PATH}`;
  const runId = "g5t20004";

  const { engine, state: s1 } = await withPath(path, () => runWorkflow(dir, gateYaml() + FIN, runId));
  assert.equal(s1.status, RunStatus.PAUSED);
  const out1 = s1.stepResults.review.output;
  assert.ok(out1.message.includes("Decision list unavailable"), `fixture: diff failure → unavailable:\n${out1.message}`);
  assert.equal(out1.head_sha, null);
  assert.equal(out1.unavailable_kind, "error", `diff failure is transient: ${JSON.stringify(out1)}`);

  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await withPath(path, () => engine.resume(runId, { verdict: "approve" }, STEP_REGISTRY));
  assertRePausedNothingApproved(dir, runId, s2, events);
  assert.equal(s2.stepResults.review.output.unavailable_kind, "error");
});

test("T2: git missing from PATH (spawn ENOENT) at pause AND resume → kind 'error', re-pauses, nothing approved", POSIX_ONLY, async () => {
  const { dir } = featureRepo();
  const emptyBin = tempDir("gate-ctx5-nogitbin-");
  const runId = "g5t20005";

  const { engine, state: s1 } = await withPath(emptyBin, () => runWorkflow(dir, gateYaml() + FIN, runId));
  assert.equal(s1.status, RunStatus.PAUSED);
  const out1 = s1.stepResults.review.output;
  assert.ok(out1.message.includes("Decision list unavailable"), out1.message);
  assert.equal(out1.unavailable_kind, "error", `a git spawn error is not 'not-a-git-repo': ${JSON.stringify(out1)}`);

  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await withPath(emptyBin, () => engine.resume(runId, { verdict: "approve" }, STEP_REGISTRY));
  assertRePausedNothingApproved(dir, runId, s2, events);
});

// ── T2: shown kind must equal fresh kind ──────────────────────────────────

test("T2: shown 'error' (diff failure), fresh 'no-target-branch' at resume → re-pause", POSIX_ONLY, async () => {
  const { dir } = featureRepo();
  const shimDir = diffFailingGitDir();
  const runId = "g5t20006";
  const { engine, state: s1 } = await withPath(`${shimDir}:${process.env.PATH}`, () => runWorkflow(dir, gateYaml() + FIN, runId));
  assert.equal(s1.stepResults.review.output.unavailable_kind, "error", "fixture: shown kind is error");

  git(dir, "branch", "-D", "main"); // no target branch left; real git from here on
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume(runId, { verdict: "approve" }, STEP_REGISTRY);
  assertRePausedNothingApproved(dir, runId, s2, events);
  assert.equal(s2.stepResults.review.output.unavailable_kind, "no-target-branch", "the fresh kind is what is now shown");
});

test("T2: shown 'no-target-branch', fresh 'not-a-git-repo' at resume (.git moved away) → re-pause", async () => {
  const { dir } = developRepo();
  const runId = "g5t20007";
  const { engine, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, runId);
  assert.equal(s1.stepResults.review.output.unavailable_kind, "no-target-branch", "fixture: shown kind is no-target-branch");

  renameSync(join(dir, ".git"), join(dir, ".git-moved"));
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume(runId, { verdict: "approve" }, STEP_REGISTRY);
  assertRePausedNothingApproved(dir, runId, s2, events);
  assert.equal(s2.stepResults.review.output.unavailable_kind, "not-a-git-repo");
});

// ── T3: safeMrLink hardening ──────────────────────────────────────────────

const GITLAB_MR = "https://gitlab.example.com/group/repo/-/merge_requests/42";
const GITHUB_PR = "https://github.com/org/repo/pull/7";

for (const [name, value] of [
  ["userinfo user:token@", "https://user:tok@gitlab.example.com/group/repo/-/merge_requests/42"],
  ["userinfo user@", "https://user@gitlab.example.com/group/repo/-/merge_requests/42"],
  ["backslash in authority", "https://gitlab.example.com\\@evil.example/x"],
  ["backslash in path", "https://gitlab.example.com/group\\repo/-/merge_requests/42"],
  ["length 2049", `${GITLAB_MR}?p=${"a".repeat(2049 - GITLAB_MR.length - 3)}`],
  ["U+2060 word joiner", `${GITLAB_MR}⁠`],
  ["U+2061 function application", `https://gitlab.example.com/gr⁡oup/repo/-/merge_requests/42`],
  ["U+2062 invisible times", `${GITLAB_MR}?x=⁢`],
  ["U+2063 invisible separator", `${GITLAB_MR}#⁣y`],
  ["U+2064 invisible plus", `https://gitlab.example.com/group/repo/-/merge_requests/4⁤2`],
  ["U+00AD soft hyphen", `https://git­lab.example.com/group/repo/-/merge_requests/42`],
]) {
  test(`T3: safeMrLink rejects ${name}`, () => {
    assert.equal(safeMrLink(value), null, value.length > 200 ? `length ${value.length}` : JSON.stringify(value));
  });
}

for (const [name, value] of [
  ["GitLab MR with ?x=1#y", `${GITLAB_MR}?x=1#y`],
  ["GitHub PR with ?x=1#y", `${GITHUB_PR}?x=1#y`],
  ["plain GitLab MR", GITLAB_MR],
  ["plain GitHub PR", GITHUB_PR],
  ["length exactly 2048", `${GITLAB_MR}?p=${"a".repeat(2048 - GITLAB_MR.length - 3)}`],
]) {
  test(`T3: safeMrLink accepts ${name} (expected to pass now)`, () => {
    assert.equal(value.length <= 2048, true);
    assert.equal(safeMrLink(value), value);
  });
}

const LINK_CTX = `      link: "{{ inputs.mr_url }}"\n`;

async function runLinkGate(runId, mrUrl) {
  const { dir } = featureRepo();
  return runWorkflow(dir, gateYaml({ extraContext: LINK_CTX }), runId, { verdict: "", mr_url: mrUrl }, ["verdict", "mr_url"]);
}

for (const [name, value] of [
  ["userinfo", "https://user:tok@gitlab.example.com/group/repo/-/merge_requests/42"],
  ["backslash", "https://gitlab.example.com\\@evil.example/x"],
  ["U+2060", `${GITLAB_MR}⁠`],
]) {
  test(`T3: context.link with ${name} → no Merge request line, no mr_link, gate still pauses`, async () => {
    const { state, events } = await runLinkGate(`g5t3x${Buffer.from(name).toString("hex").slice(0, 10)}`, value);
    assert.equal(state.status, RunStatus.PAUSED);
    const out = state.stepResults.review.output;
    assert.ok(!out.message.includes("Merge request"), out.message);
    assert.ok(!("mr_link" in out), `no mr_link: ${JSON.stringify(out.mr_link)}`);
    assert.ok(out.message.includes("PDR-127"), "manifest still rendered");
    const gp = events.find((e) => e.type === "gate_paused");
    assert.ok(gp && !("mr_link" in gp), "gate_paused carries no mr_link");
  });
}

test("T3: context.link GitHub PR with ?x=1#y → accepted as the final Merge request line (expected to pass now)", async () => {
  const url = `${GITHUB_PR}?x=1#y`;
  const { state } = await runLinkGate("g5t30001", url);
  const out = state.stepResults.review.output;
  assert.equal(out.mr_link, url);
  assert.ok(out.message.endsWith(`Merge request: ${url}`), out.message);
});

// ── T4: ESC in a record filename (regression guard) ───────────────────────

test("T4: record filename with ESC → listed as (unprintable path); no \\x1b in message or decisions[] (regression guard)", POSIX_ONLY, async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/esc");
  write(dir, ".adlc/drafts/pdr/PDR-901-\x1b[31mRED\x1b[0m.md", record({ title: "Esc", decision: "Esc decision." }));
  write(dir, ".adlc/drafts/pdr/PDR-902.md", record({ title: "Normal", decision: "Normal decision." }));
  commitAll(dir, "esc path");

  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.unavailable, null);
  assert.equal(m.decisions.length, 2, JSON.stringify(m.decisions));
  assert.ok(!JSON.stringify(m.decisions).includes("\\u001b"), `decisions[] carry no ESC: ${JSON.stringify(m.decisions)}`);
  assert.ok(m.decisions.some((d) => d.path === "(unprintable path)"), JSON.stringify(m.decisions));
  const message = renderGateMessage("Approve PDRs?", m);
  assert.ok(!message.includes("\x1b"), JSON.stringify(message));
  assert.ok(message.includes("(unprintable path)"), message);
  assert.ok(message.includes("PDR-902"), message);

  const { state, events } = await runWorkflow(dir, gateYaml() + FIN, "g5t40001");
  const out = state.stepResults.review.output;
  assert.ok(!out.message.includes("\x1b"), JSON.stringify(out.message));
  assert.ok(!JSON.stringify(out.decisions).includes("\\u001b"), JSON.stringify(out.decisions));
  assert.ok(out.message.includes("(unprintable path)"), out.message);
  for (const type of ["gate_paused", "permission_request"]) {
    const e = events.find((x) => x.type === type);
    assert.ok(e, type);
    assert.ok(!JSON.stringify(e).includes("\\u001b"), `${type} carries no ESC`);
  }
});
