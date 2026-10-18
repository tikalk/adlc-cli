// Gate Decision Manifest — iteration 2 (adlc-workspace#22, converge-1 findings
// I1, I2, I3, N1, N2, N3, N5, N6). Builds on tests/workflow-gate-context.test.mjs.
//
// Contract pinned here (in addition to iteration 1):
//   step_results.<gate>.output.head_sha   HEAD the paused manifest was built at
//                                          (set on every PAUSE of a context gate,
//                                          incl. an on_reject: retry re-pause)
//   approve on resume: current HEAD != saved head_sha → gate PAUSES again with a
//     freshly built manifest, no approved_sha, no gate_approved log entry.
//     Else approved_sha = saved head_sha and the gate_approved log entry's
//     decisions equal the paused manifest's decisions.
//   A gate whose verdict is preset at first execution (never paused) approves
//     at the current HEAD (unchanged from iteration 1).
//   state.json top-level `run_start_sha`    HEAD at run start (kept across resume)
//   state.json top-level `last_approved_sha` most recent approval in time
//   since resolution: last_approved_sha; else the most recent merge-base among
//     origin/HEAD, origin/main, origin/master, main, master; if that merge-base
//     == HEAD (running on the target branch) → run_start_sha.
//   Wording (N1), <kind> from the record glob: pdr→product, adr→architecture,
//     chdr→change, else omitted:
//     "<N> <kind> decisions to approve (since approval|merge-base|run start @<sha7>)"
//     "No new or changed <kind> decisions since approval|merge-base|run start @<sha7>."

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";
const ADR_GLOB = ".adlc/drafts/adr/*.md";
const CHDR_GLOB = ".adlc/drafts/chdr/*.md";

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
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(dir, rel, content) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

// Workflow `shell` steps run under /bin/sh on POSIX but cmd.exe on Windows,
// so fixture steps must not use POSIX-only syntax (mkdir -p, printf, '…'
// quoting, >> redirects). File edits go through a tiny node helper instead;
// the content travels base64-encoded so no shell ever has to quote it. Only
// `&&` and double-quoted paths are left, which both shells accept.
let fixtureHelper = null;
function fileStepCmd(op, rel, text) {
  if (fixtureHelper === null) {
    fixtureHelper = join(tempDir("gate-ctx2-fx-"), "fx.mjs");
    writeFileSync(
      fixtureHelper,
      'import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";\n' +
        'import { dirname } from "node:path";\n' +
        "const [op, file, b64] = process.argv.slice(2);\n" +
        'const text = Buffer.from(b64, "base64").toString("utf-8");\n' +
        "mkdirSync(dirname(file), { recursive: true });\n" +
        'if (op === "append") appendFileSync(file, text); else writeFileSync(file, text);\n',
      "utf-8",
    );
  }
  return `node "${fixtureHelper}" ${op} "${rel}" ${Buffer.from(text, "utf-8").toString("base64")}`;
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

function initRepo(prefix = "gate-ctx2-repo-") {
  const dir = tempDir(prefix);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, ".gitignore", ".adlc/workflows/\n");
  return dir;
}

// main: PDR-100 (stale, committed before the run). feature/x: adds PDR-127.
function featureRepo() {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Stale old decision", decision: "We keep the stale thing." }));
  write(dir, "src/app.js", "v1\n");
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/x");
  write(dir, ".adlc/drafts/pdr/PDR-127.md", record({ title: "Self-serve onboarding", decision: "We ship self-serve onboarding." }));
  const headSha = commitAll(dir, "feature work");
  return { dir, baseSha, headSha };
}

function gateYaml({ id = "review", verdict = "verdict", message = "Approve decisions?", records = [PDR_GLOB], onReject = "abort", indent = "  " } = {}) {
  const i = indent;
  return `${i}- id: ${id}
${i}  type: gate
${i}  message: "${message}"
${i}  options: [approve, reject]
${i}  on_reject: ${onReject}
${i}  verdict_input: ${verdict}
${i}  context:
${i}    records: [${records.map((r) => `"${r}"`).join(", ")}]
${i}    since: last_approved
`;
}

function bumpYaml(id, file = ".adlc/drafts/pdr/PDR-127.md", indent = "  ") {
  return `${indent}- id: ${id}
${indent}  type: shell
${indent}  run: '${fileStepCmd("append", file, `Addendum-${id}\n`)} && git add .adlc/drafts && git commit -q -m ${id}'
`;
}

function writeWorkflow(stepsYaml, inputs = ["verdict"]) {
  const wfDir = tempDir("gate-ctx2-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf2
  name: Context Gate 2
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

function ids(decisions) {
  assert.ok(Array.isArray(decisions), `decisions must be an array, got ${JSON.stringify(decisions)}`);
  return decisions.map((d) => d.id).sort();
}

const short = (sha) => sha.slice(0, 7);

// ── I1: the approval covers exactly what was shown ─────────────────────────

test("I1: HEAD moves between pause and approve → gate re-pauses with a fresh manifest, nothing approved", async () => {
  const { dir, headSha } = featureRepo();
  const steps = gateYaml() + `  - id: fin
    type: shell
    run: "echo fin"
`;
  const { engine, state: s1 } = await runWorkflow(dir, steps, "gi100001");
  assert.equal(s1.status, RunStatus.PAUSED);
  const paused = s1.stepResults.review.output;
  assert.deepEqual(ids(paused.decisions), ["PDR-127"]);
  assert.equal(paused.head_sha, headSha, "a paused context gate persists the head_sha its manifest was built at");
  assert.equal(persistedState(dir, "gi100001").step_results.review.output.head_sha, headSha, "head_sha is in state.json");

  // Record B lands while the approver is reading the message about A.
  write(dir, ".adlc/drafts/pdr/PDR-128.md", record({ title: "Never shown", decision: "Sneaky decision." }));
  const movedSha = commitAll(dir, "sneaky");

  const events2 = [];
  engine.onEvent = (e) => events2.push(e);
  const s2 = await engine.resume("gi100001", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.PAUSED, "a stale view must not be approved (ADR-422: gates halt)");
  assert.equal(s2.currentStepId, "review");
  const out2 = s2.stepResults.review.output;
  assert.equal(s2.stepResults.review.status, StepStatus.PAUSED);
  assert.equal(out2.approved_sha, undefined, "no approved_sha for the stale view");
  assert.equal(s2.stepResults.fin, undefined, "downstream steps must not run");
  assert.deepEqual(ids(out2.decisions), ["PDR-127", "PDR-128"], "the fresh manifest lists B");
  assert.equal(out2.head_sha, movedSha);
  assert.ok(out2.message.includes("PDR-128"), out2.message);
  const gp = events2.find((e) => e.type === "gate_paused");
  assert.ok(gp, "a new gate_paused is emitted for the fresh manifest");
  assert.deepEqual(ids(gp.decisions), ["PDR-127", "PDR-128"]);
  assert.ok(!logEntries(dir, "gi100001").some((e) => e.event === "gate_approved"), "no gate_approved audit for the stale view");

  // Approving the fresh view (HEAD unchanged now) completes.
  const s3 = await engine.resume("gi100001", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s3.status, RunStatus.COMPLETED);
  assert.equal(s3.stepResults.review.output.approved_sha, movedSha);
  const audit = logEntries(dir, "gi100001").filter((e) => e.event === "gate_approved");
  assert.equal(audit.length, 1);
  assert.deepEqual(ids(audit[0].decisions), ["PDR-127", "PDR-128"]);
});

test("I1: HEAD unchanged → approved_sha = paused head_sha and the audit copies the paused manifest", async () => {
  const { dir, headSha } = featureRepo();
  const steps = gateYaml() + `  - id: fin
    type: shell
    run: "echo fin"
`;
  const { engine, state: s1 } = await runWorkflow(dir, steps, "gi100002");
  const paused = s1.stepResults.review.output;
  assert.equal(paused.head_sha, headSha, "paused output carries head_sha");
  const pausedDecisions = JSON.parse(JSON.stringify(paused.decisions));

  const s2 = await engine.resume("gi100002", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED);
  const out = s2.stepResults.review.output;
  assert.equal(out.approved_sha, paused.head_sha);
  const persisted = persistedState(dir, "gi100002");
  assert.equal(persisted.step_results.review.output.approved_sha, paused.head_sha);
  const audit = logEntries(dir, "gi100002").filter((e) => e.event === "gate_approved");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].step_id, "review");
  assert.equal(audit[0].approved_sha, paused.head_sha);
  assert.deepEqual(audit[0].decisions, pausedDecisions, "audit decisions == the paused manifest's decisions");
});

// ── I2: a stale local main must not reintroduce #19 ───────────────────────

test("I2: local main behind origin/main → merge-base with origin/main wins, stale drafts not listed", async () => {
  const origin = tempDir("gate-ctx2-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "main");
  // origin/main advances with drafts; local main is never updated.
  git(dir, "checkout", "-q", "-b", "tmp");
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Stale draft on origin", decision: "Old." }));
  write(dir, ".adlc/drafts/pdr/PDR-101.md", record({ title: "Another stale draft", decision: "Old too." }));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "drafts on origin/main");
  git(dir, "push", "-q", "origin", "tmp:main");
  git(dir, "fetch", "-q", "origin");
  const originMain = git(dir, "rev-parse", "origin/main");
  // Branch cut from origin/main (the usual mission flow).
  git(dir, "checkout", "-q", "-b", "feature/i2", "origin/main");
  git(dir, "branch", "-q", "-D", "tmp");
  write(dir, ".adlc/drafts/pdr/PDR-127.md", record({ title: "Real new decision", decision: "We do it." }));
  commitAll(dir, "feature");
  assert.notEqual(git(dir, "rev-parse", "main"), originMain, "fixture: local main is behind origin/main");

  const { state } = await runWorkflow(dir, gateYaml(), "gi200001");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults.review.output;
  assert.deepEqual(ids(out.decisions), ["PDR-127"], "drafts already on origin/main are not listed");
  assert.equal(out.since_sha, originMain, "since = the most recent merge-base among candidates");
  assert.ok(!out.message.includes("PDR-100") && !out.message.includes("PDR-101"), out.message);
});

// ── I3: running on the target branch ───────────────────────────────────────

test("I3: run on main; a step commits a PDR before the gate → listed since run start; run_start_sha persisted", async () => {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Committed before the run", decision: "Old." }));
  const startSha = commitAll(dir, "base");
  const steps = `  - id: draft
    type: shell
    run: '${fileStepCmd("write", ".adlc/drafts/pdr/PDR-200.md", "# Drafted in run\n\n## Decision Outcome\n\nWe decide in run.\n")} && git add .adlc/drafts && git commit -q -m draft'
` + gateYaml() + `  - id: fin
    type: shell
    run: "echo fin"
`;
  const { engine, state } = await runWorkflow(dir, steps, "gi300001");
  assert.equal(state.status, RunStatus.PAUSED);
  assert.equal(state.stepResults.draft.status, StepStatus.COMPLETED, "fixture commit step ran");
  assert.notEqual(git(dir, "rev-parse", "HEAD"), startSha);
  const out = state.stepResults.review.output;
  assert.equal(out.no_changes, false, out.message);
  assert.deepEqual(ids(out.decisions), ["PDR-200"]);
  assert.equal(out.decisions[0].change, "new");
  assert.equal(out.since_sha, startSha, "since = run-start sha when merge-base == HEAD");
  assert.equal(persistedState(dir, "gi300001").run_start_sha, startSha, "state.json carries run_start_sha");

  const s2 = await engine.resume("gi300001", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED);
  assert.equal(persistedState(dir, "gi300001").run_start_sha, startSha, "resume keeps the original run_start_sha");
});

// ── N1: kind-specific wording and since-label ─────────────────────────────

test("N1: header names the kind (pdr→product) and 'since merge-base @sha'", async () => {
  const { dir, baseSha } = featureRepo();
  write(dir, ".adlc/drafts/pdr/PDR-129.md", record({ title: "Second", decision: "Two." }));
  commitAll(dir, "second");
  const { state } = await runWorkflow(dir, gateYaml(), "gn100001");
  const msg = state.stepResults.review.output.message;
  assert.ok(msg.includes(`2 product decisions to approve (since merge-base @${short(baseSha)})`), msg);
});

for (const [glob, kind, rec] of [
  [ADR_GLOB, "architecture", ".adlc/drafts/adr/ADR-010.md"],
  [CHDR_GLOB, "change", ".adlc/drafts/chdr/CHDR-010.md"],
]) {
  test(`N1: ${glob} → '${kind} decisions' in header and no-change sentence`, async () => {
    const dir = initRepo();
    write(dir, "README.md", "x\n");
    const baseSha = commitAll(dir, "base");
    git(dir, "checkout", "-q", "-b", "feature/n1");
    write(dir, rec, record({ title: "T one", decision: "D one." }));
    write(dir, rec.replace("010", "011"), record({ title: "T two", decision: "D two." }));
    commitAll(dir, "recs");
    const { state } = await runWorkflow(dir, gateYaml({ records: [glob] }), `gn1${kind.slice(0, 4)}`);
    const msg = state.stepResults.review.output.message;
    assert.ok(msg.includes(`2 ${kind} decisions to approve (since merge-base @${short(baseSha)})`), msg);

    const nc = initRepo();
    write(nc, "README.md", "x\n");
    const ncBase = commitAll(nc, "base");
    git(nc, "checkout", "-q", "-b", "feature/n1nc");
    write(nc, "src/a.js", "1\n");
    commitAll(nc, "code");
    const { state: s2 } = await runWorkflow(nc, gateYaml({ records: [glob] }), `gn2${kind.slice(0, 4)}`);
    const m2 = s2.stepResults.review.output.message;
    assert.ok(m2.includes(`No new or changed ${kind} decisions since merge-base @${short(ncBase)}.`), m2);
  });
}

test("N1: unknown record glob → kind omitted ('2 decisions to approve (since merge-base @sha)')", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/n1x");
  write(dir, "docs/decisions/D-1.md", record({ title: "A", decision: "A." }));
  write(dir, "docs/decisions/D-2.md", record({ title: "B", decision: "B." }));
  commitAll(dir, "recs");
  const { state } = await runWorkflow(dir, gateYaml({ records: ["docs/decisions/*.md"] }), "gn100004");
  const msg = state.stepResults.review.output.message;
  assert.ok(msg.includes(`2 decisions to approve (since merge-base @${short(baseSha)})`), msg);
});

test("N1: no-change sentence — product kind + 'since merge-base @sha.'", async () => {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Old", decision: "Old." }));
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/nc");
  write(dir, "src/a.js", "1\n");
  commitAll(dir, "code");
  const { state } = await runWorkflow(dir, gateYaml(), "gn100005");
  const msg = state.stepResults.review.output.message;
  assert.ok(msg.includes(`No new or changed product decisions since merge-base @${short(baseSha)}.`), msg);
});

test("N1: second gate after approval → 'since approval @sha' in header and no-change sentence", async () => {
  const { dir, headSha } = featureRepo();
  const steps =
    gateYaml({ id: "gate-a", verdict: "va" }) +
    bumpYaml("bump") +
    gateYaml({ id: "gate-b", verdict: "vb" }) +
    gateYaml({ id: "gate-c", verdict: "vc" });
  const { engine } = await runWorkflow(dir, steps, "gn100006", { va: "", vb: "", vc: "" }, ["va", "vb", "vc"]);
  const s2 = await engine.resume("gn100006", { va: "approve" }, STEP_REGISTRY);
  assert.equal(s2.currentStepId, "gate-b");
  const mB = s2.stepResults["gate-b"].output.message;
  assert.match(mB, new RegExp(`1 product decisions? to approve \\(since approval @${short(headSha)}\\)`), mB);

  const bApproved = git(dir, "rev-parse", "HEAD");
  const s3 = await engine.resume("gn100006", { vb: "approve" }, STEP_REGISTRY);
  assert.equal(s3.currentStepId, "gate-c");
  const mC = s3.stepResults["gate-c"].output.message;
  assert.ok(mC.includes(`No new or changed product decisions since approval @${short(bApproved)}.`), mC);
});

test("N1: run on main with no record change → 'since run start @sha.'", async () => {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Old", decision: "Old." }));
  const startSha = commitAll(dir, "base");
  const { state } = await runWorkflow(dir, gateYaml(), "gn100007");
  const msg = state.stepResults.review.output.message;
  assert.ok(msg.includes(`No new or changed product decisions since run start @${short(startSha)}.`), msg);

  // And the header form when a run-time commit adds a record.
  const steps = bumpYaml("bump", ".adlc/drafts/pdr/PDR-100.md") + gateYaml();
  const { state: s2 } = await runWorkflow(dir, steps, "gn100008");
  const m2 = s2.stepResults.review.output.message;
  assert.match(m2, new RegExp(`1 product decisions? to approve \\(since run start @${short(startSha)}\\)`), m2);
});

// ── N2: only the first 10 (sorted) records are parsed ─────────────────────

// Observability: a PATH shim logs every git invocation the engine makes; a
// record beyond the first 10 must never be read (`git show <sha>:<path>` or
// any other command naming its path). POSIX only.
test("N2: 25 changed records → first 10 by sorted path listed; records 11-25 are never read", { skip: process.platform === "win32" }, async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/many");
  const all = [];
  // Written in reverse so creation order != sorted order.
  for (let i = 224; i >= 200; i--) {
    all.push(`PDR-${i}`);
    write(dir, `.adlc/drafts/pdr/PDR-${i}.md`, record({ title: `Decision ${i}`, decision: `We do ${i}.` }));
  }
  commitAll(dir, "many");
  const sorted = [...all].sort();
  const first10 = sorted.slice(0, 10);
  const rest = sorted.slice(10);

  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
  const shimDir = tempDir("gate-ctx2-shim-");
  const logFile = join(shimDir, "calls.log");
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${oldPath}`;
  let state;
  try {
    ({ state } = await runWorkflow(dir, gateYaml(), "gn200001"));
  } finally {
    process.env.PATH = oldPath;
  }
  const out = state.stepResults.review.output;
  assert.deepEqual(out.decisions.map((d) => d.id), first10, "deterministic: first 10 by sorted path, in order");
  assert.equal(out.truncated_count, 15);
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf-8").split("\n").filter(Boolean) : [];
  assert.ok(calls.length > 0, "shim observed the engine's git calls");
  const readsBeyond = calls.filter((c) => rest.some((id) => c.includes(`${id}.md`)));
  assert.deepEqual(readsBeyond, [], "records beyond the first 10 must not be parsed");
});

// ── N3: since = most recent approval in time ──────────────────────────────

// gate-b is approved, then re-approved when the `if` body re-runs on resume.
// Its re-execution must diff from its own earlier approval (the most recent
// approval in time), not from gate-a's older one — insertion order of
// step_results is not approval order.
test("N3: re-approval inside a re-run body → since = last_approved_sha (most recent in time); persisted at run level", async () => {
  const { dir, headSha } = featureRepo();
  const steps =
    gateYaml({ id: "gate-a", verdict: "va" }) +
    `  - id: blk
    type: if
    condition: true
    then:
` +
    bumpYaml("bump1", ".adlc/drafts/pdr/PDR-127.md", "      ") +
    gateYaml({ id: "gate-b", verdict: "vb", indent: "      " }) +
    bumpYaml("bump2", ".adlc/drafts/pdr/PDR-100.md", "      ") +
    gateYaml({ id: "gate-c", verdict: "vc", indent: "      " });
  const { engine, state: s1 } = await runWorkflow(dir, steps, "gn300001", { va: "approve", vb: "approve", vc: "" }, ["va", "vb", "vc"]);
  assert.equal(s1.status, RunStatus.PAUSED);
  assert.equal(s1.currentStepId, "gate-c");
  assert.equal(s1.stepResults["gate-a"].output.approved_sha, headSha);
  const bFirst = s1.stepResults["gate-b"].output.approved_sha;
  assert.ok(bFirst && bFirst !== headSha, "fixture: gate-b approved after bump1");
  assert.equal(persistedState(dir, "gn300001").last_approved_sha, bFirst, "state.json last_approved_sha = most recent approval");

  // Resume re-runs the `if` body: bump1 commits again, gate-b re-executes.
  const s2 = await engine.resume("gn300001", { vc: "approve" }, STEP_REGISTRY);
  const outB = s2.stepResults["gate-b"].output;
  assert.equal(outB.since_sha, bFirst, "gate-b's re-approval diffs from the most recent approval (its own), not gate-a's");
  assert.ok(outB.approved_sha && outB.approved_sha !== bFirst);
  // gate-c's view (paused before the body re-ran) is stale → re-pauses (I1).
  assert.equal(s2.status, RunStatus.PAUSED);
  assert.equal(s2.stepResults["gate-c"].output.since_sha, outB.approved_sha, "gate-c diffs from gate-b's re-approval");
  assert.equal(persistedState(dir, "gn300001").last_approved_sha, outB.approved_sha, "re-approval updates last_approved_sha");
});

// ── N5: more-link for multi-glob gates; ssh remotes with a port ───────────

function setUpstream(dir, branch, url) {
  git(dir, "remote", "add", "origin", url);
  git(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  git(dir, "config", `branch.${branch}.remote`, "origin");
  git(dir, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
}

test("N5: multi-glob gate → '…and N more' link points at the common parent dir", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/n5");
  for (let i = 0; i < 8; i++) write(dir, `.adlc/drafts/pdr/PDR-${300 + i}.md`, record({ title: `P${i}`, decision: `P${i}.` }));
  for (let i = 0; i < 8; i++) write(dir, `.adlc/drafts/adr/ADR-${300 + i}.md`, record({ title: `A${i}`, decision: `A${i}.` }));
  commitAll(dir, "recs");
  setUpstream(dir, "feature/n5", "https://github.com/acme/repo.git");
  const { state } = await runWorkflow(dir, gateYaml({ records: [PDR_GLOB, ADR_GLOB] }), "gn500001");
  const out = state.stepResults.review.output;
  assert.equal(out.truncated_count, 6);
  const m = out.message.match(/and 6 more: (\S+)/);
  assert.ok(m, out.message);
  const link = m[1].replace(/\/$/, "");
  assert.ok(link.startsWith("https://github.com/acme/repo/"), link);
  assert.ok(link.endsWith("/feature/n5/.adlc/drafts"), `link must cover both globs (common parent .adlc/drafts): ${link}`);
});

test("N5: ssh://git@host:2222/group/repo.git remote → https://host/group/repo links (port dropped)", async () => {
  const { dir } = featureRepo();
  setUpstream(dir, "feature/x", "ssh://git@git.example.com:2222/group/repo.git");
  const { state } = await runWorkflow(dir, gateYaml(), "gn500002");
  const [d] = state.stepResults.review.output.decisions;
  assert.equal(d.id, "PDR-127");
  assert.ok(d.link.startsWith("https://git.example.com/group/repo/"), d.link);
  assert.ok(!d.link.includes("2222"), d.link);
  assert.ok(d.link.endsWith("PDR-127.md"), d.link);
});

// ── N6: reject → retry; paths with spaces/unicode ─────────────────────────

test("N6: on_reject: retry → re-pauses with a manifest (head_sha, gate_paused), later approval completes", async () => {
  const { dir, headSha } = featureRepo();
  const steps = gateYaml({ onReject: "retry" }) + `  - id: fin
    type: shell
    run: "echo fin"
`;
  const { engine, state: s1 } = await runWorkflow(dir, steps, "gn600001");
  assert.equal(s1.status, RunStatus.PAUSED);

  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume("gn600001", { verdict: "reject" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.PAUSED, "retry re-pauses");
  const out2 = s2.stepResults.review.output;
  assert.equal(out2.choice, "reject");
  assert.deepEqual(ids(out2.decisions), ["PDR-127"], "re-pause still carries the manifest");
  assert.equal(out2.approved_sha, undefined);
  assert.equal(out2.head_sha, headSha, "retry re-pause persists head_sha for the next approval");
  const gp = events.find((e) => e.type === "gate_paused");
  assert.ok(gp, "retry re-pause emits gate_paused");
  assert.deepEqual(ids(gp.decisions), ["PDR-127"]);
  assert.equal(s2.inputs.verdict, "", "retry clears the bound verdict");

  const s3 = await engine.resume("gn600001", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s3.status, RunStatus.COMPLETED);
  assert.equal(s3.stepResults.review.output.approved_sha, headSha);
  assert.equal(s3.stepResults.fin.status, StepStatus.COMPLETED);
});

test("N6: record paths with spaces and unicode → correct id/title and URL-encoded link (regression guard)", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/n6");
  const spaced = ".adlc/drafts/pdr/PDR-300 my decision.md";
  const uni = ".adlc/drafts/pdr/PDR-301-ünï 決定.md";
  write(dir, spaced, record({ title: "Spaced title", decision: "Spaced decision." }));
  write(dir, uni, record({ id: "PDR-301", title: "Ünïcødé 決定 title", decision: "Unicode decision." }));
  commitAll(dir, "odd paths");
  setUpstream(dir, "feature/n6", "https://github.com/acme/repo.git");
  const { state } = await runWorkflow(dir, gateYaml(), "gn600002");
  const out = state.stepResults.review.output;
  const byPath = Object.fromEntries(out.decisions.map((d) => [d.path, d]));
  assert.ok(byPath[spaced], JSON.stringify(out.decisions));
  assert.ok(byPath[uni], JSON.stringify(out.decisions));
  assert.equal(byPath[spaced].id, "PDR-300 my decision");
  assert.equal(byPath[spaced].title, "Spaced title");
  assert.ok(byPath[spaced].link.endsWith("PDR-300%20my%20decision.md"), byPath[spaced].link);
  assert.equal(byPath[uni].id, "PDR-301");
  assert.equal(byPath[uni].title, "Ünïcødé 決定 title");
  assert.ok(byPath[uni].link.endsWith(encodeURIComponent("PDR-301-ünï 決定.md")), byPath[uni].link);
  assert.ok(!/[ À-￿]/.test(byPath[uni].link), `link must be URL-encoded: ${byPath[uni].link}`);
  assert.ok(out.message.includes("Spaced title") && out.message.includes("Ünïcødé 決定 title"), out.message);
});
