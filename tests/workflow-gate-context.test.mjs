// Gate Decision Manifest tests (ADR-391-amendment-gate-decision-context,
// adlc-workspace#22, fixes agentic-container#19).
//
// A `gate` step may declare `context: { records: [<glob>...], since: last_approved }`.
// When it pauses, the gate output (and the gate_paused / permission_request
// events) carry the decisions the approver is asked to approve, computed as
// `git diff <since>..HEAD` restricted to the record globs, run in the engine's
// projectRoot (the git repo — `new WorkflowEngine(projectRoot)`).
//
// Contract pinned here (the implementer must follow these names):
//   output.decisions        [{ id, title, decision_line, status, change: "new"|"changed", path, link }]
//   output.since_sha        full sha the diff starts from
//   output.no_changes       boolean
//   output.truncated_count  integer >= 0 (records beyond the 10-item cap)
//   output.message          rendered text (static gate message + manifest)
//   output.approved_sha     HEAD sha at approval (set when the gate completes with approve)
// `since` resolution: output.approved_sha of the most recent previously
// approved context gate in step_results; else `git merge-base HEAD main`
// (the target branch defaults to `main`; tests never name another branch).
// On approval an audit entry carrying { step_id, approved_sha, decisions } is
// appended to runs/<run_id>/log.jsonl (event name is the implementer's choice).
//
// Criteria 8 (agentic-container hitl-bridge-sink) and 9 (live drill) are out
// of scope for unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WorkflowEngine,
  WorkflowDefinition,
  validateWorkflow,
  headlessGateErrors,
  RunStatus,
} from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "adlc-cli.mjs");
const PDR_GLOB = ".adlc/drafts/pdr/*.md";

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

function commitAll(dir, msg) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

function record({ id = null, title, status = "Proposed", decision, section = "Decision Outcome", extra = "" }) {
  const fm = ["---"];
  if (id) fm.push(`id: ${id}`);
  fm.push(`status: ${status}`, "---", "");
  return [
    ...fm,
    `# ${title}`,
    "",
    "## Context and Problem Statement",
    "",
    `Background for ${title}.${extra ? "\n\n" + extra : ""}`,
    "",
    `## ${section}`,
    "",
    decision,
    "",
    "## Consequences",
    "",
    "Some consequences.",
    "",
  ].join("\n");
}

// New git repo on `main` with a gitignored run-state dir.
function initRepo() {
  const dir = tempDir("gate-ctx-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, ".gitignore", ".adlc/workflows/\n");
  return dir;
}

// The #20 / f1fac0a shape: main carries an old committed draft (PDR-100) and
// PDR-125; the feature branch adds PDR-127 and changes PDR-125 (plus noise
// outside the PDR glob). main then advances after the branch point so the
// merge-base differs from main's tip.
function standardRepo() {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Stale old decision", decision: "We keep the stale thing. It is old." }));
  write(dir, ".adlc/drafts/pdr/PDR-125.md", record({ title: "Billing tiers", status: "Proposed", decision: "We offer two tiers. Details follow." }));
  write(dir, ".adlc/drafts/adr/ADR-001.md", record({ title: "Use Postgres", decision: "We use Postgres. Because." }));
  write(dir, "src/app.js", "console.log('v1');\n");
  const baseSha = commitAll(dir, "base");

  git(dir, "checkout", "-q", "-b", "feature/x");
  write(dir, ".adlc/drafts/pdr/PDR-127.md", record({
    title: "Self-serve onboarding",
    status: "Proposed",
    decision: "We ship self-serve onboarding for teams. A second sentence that must not be rendered.",
    extra: "SECRET_TOKEN=s3cr3t-value-123",
  }));
  write(dir, ".adlc/drafts/pdr/PDR-125.md", record({ title: "Billing tiers", status: "Accepted", decision: "We offer three tiers. Details follow." }));
  write(dir, ".adlc/drafts/adr/ADR-001.md", record({ title: "Use Postgres", decision: "We use Postgres 16. Because." }));
  write(dir, "src/app.js", "console.log('v2');\n");
  const headSha = commitAll(dir, "feature work");
  // File timestamps never count (brief): bump the stale draft's mtime.
  const now = new Date();
  utimesSync(join(dir, ".adlc/drafts/pdr/PDR-100.md"), now, now);

  git(dir, "checkout", "-q", "main");
  write(dir, ".adlc/drafts/pdr/PDR-140.md", record({ title: "Main-only decision", decision: "Lives on main only." }));
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Stale old decision", decision: "Changed on main later." }));
  commitAll(dir, "main advances");
  git(dir, "checkout", "-q", "feature/x");
  return { dir, baseSha, headSha };
}

// Feature branch whose only change is outside the record globs.
function noChangeRepo() {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-100.md", record({ title: "Stale old decision", decision: "We keep the stale thing." }));
  write(dir, "src/app.js", "console.log('v1');\n");
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/y");
  write(dir, "src/app.js", "console.log('v2');\n");
  const headSha = commitAll(dir, "code only");
  const now = new Date();
  utimesSync(join(dir, ".adlc/drafts/pdr/PDR-100.md"), now, now);
  return { dir, baseSha, headSha };
}

function gateYaml({ message = "Approve product decisions before architecture?", context = `
    context:
      records: ["${PDR_GLOB}"]
      since: last_approved`, id = "review", verdict = "verdict" } = {}) {
  return `  - id: ${id}
    type: gate
    message: "${message}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: ${verdict}${context}
`;
}

function writeWorkflow(stepsYaml, inputs = ["verdict"]) {
  const wfDir = tempDir("gate-ctx-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf
  name: Context Gate
  version: "1.0.0"
inputs:
${inputs.map((i) => `  ${i}: {type: string}`).join("\n")}
steps:
${stepsYaml}`, "utf-8");
  return path;
}

function engineFor(dir) {
  const engine = new WorkflowEngine(dir);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  return { engine, events };
}

async function runToGate(dir, stepsYaml, runId, inputs = { verdict: "" }, inputNames) {
  const path = writeWorkflow(stepsYaml, inputNames);
  const { engine, events } = engineFor(dir);
  const state = await engine.execute(engine.loadWorkflow(path), inputs, runId, STEP_REGISTRY);
  return { engine, events, state };
}

function byId(decisions) {
  assert.ok(Array.isArray(decisions), `decisions must be an array, got ${JSON.stringify(decisions)}`);
  return [...decisions].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// Text of one decision's bullet: from its id to the next listed id (or end).
function bulletFor(message, id, allIds) {
  const start = message.indexOf(id);
  assert.ok(start >= 0, `message should mention ${id}:\n${message}`);
  let end = message.length;
  for (const other of allIds) {
    if (other === id) continue;
    const at = message.indexOf(other, start + id.length);
    if (at >= 0 && at < end) end = at;
  }
  return message.slice(start, end);
}

const CONTROL_EXCEPT_NL_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

// ── Criterion 1: new + changed records listed with full fields ───────────

test("context gate: lists exactly the new and changed records since merge-base (not the stale committed draft)", async () => {
  const { dir, baseSha } = standardRepo();
  const { state } = await runToGate(dir, gateYaml(), "gc000001");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults.review.output;
  assert.equal(state.stepResults.review.status, StepStatus.PAUSED);

  assert.ok(Array.isArray(out.decisions), "output.decisions must be an array");
  const ds = byId(out.decisions);
  assert.deepEqual(ds.map((d) => [d.id, d.change]), [["PDR-125", "changed"], ["PDR-127", "new"]]);
  assert.equal(out.since_sha, baseSha, "since must be merge-base(HEAD, main), not main's tip");
  assert.equal(out.no_changes, false);
  assert.equal(out.truncated_count, 0);

  const [p125, p127] = ds;
  assert.equal(p127.title, "Self-serve onboarding");
  assert.equal(p127.status, "Proposed");
  assert.equal(p127.path, ".adlc/drafts/pdr/PDR-127.md");
  assert.equal(typeof p127.link, "string");
  assert.ok(p127.link.includes("PDR-127.md"), `link should point at the record: ${p127.link}`);
  assert.ok(p127.decision_line.startsWith("We ship self-serve onboarding for teams"));
  assert.ok(!p127.decision_line.includes("second sentence"), "decision_line is the first sentence only");

  assert.equal(p125.title, "Billing tiers");
  assert.equal(p125.status, "Accepted");
  assert.ok(p125.decision_line.startsWith("We offer three tiers"));
  assert.equal(p125.path, ".adlc/drafts/pdr/PDR-125.md");
});

test("context gate: rendered message = static message + manifest with id, change, title, decision, status, link", async () => {
  const { dir, baseSha } = standardRepo();
  const { state } = await runToGate(dir, gateYaml(), "gc000002");
  const msg = state.stepResults.review.output.message;
  assert.equal(typeof msg, "string");
  assert.ok(msg.startsWith("Approve product decisions before architecture?"), msg);
  assert.ok(msg.includes("2 decisions to approve"), msg);
  assert.ok(msg.includes(`since ${baseSha.slice(0, 7)}`), msg);

  const ids = ["PDR-125", "PDR-127"];
  const b127 = bulletFor(msg, "PDR-127", ids);
  assert.ok(b127.includes("(new)"), b127);
  assert.ok(b127.includes("Self-serve onboarding"), b127);
  assert.ok(b127.includes("We ship self-serve onboarding for teams"), b127);
  assert.ok(b127.includes("Proposed"), b127);
  assert.ok(b127.includes("PDR-127.md"), b127);

  const b125 = bulletFor(msg, "PDR-125", ids);
  assert.ok(b125.includes("(changed)"), b125);
  assert.ok(b125.includes("Billing tiers"), b125);
  assert.ok(b125.includes("We offer three tiers"), b125);
  assert.ok(b125.includes("Accepted"), b125);

  // Only records under context.records: no stale draft, no ADR, no code.
  assert.ok(!msg.includes("PDR-100"), "stale draft committed before the run must not be listed");
  assert.ok(!msg.includes("PDR-140"), "main-only record must not be listed");
  assert.ok(!msg.includes("ADR-001"), "records outside the glob must not be listed");
  assert.ok(!msg.includes("app.js"));
  assert.ok(!msg.includes("drafted"));
});

test("context gate: gate_paused and permission_request carry the manifest", async () => {
  const { dir, baseSha } = standardRepo();
  const { state, events } = await runToGate(dir, gateYaml(), "gc000003");
  const out = state.stepResults.review.output;
  for (const type of ["gate_paused", "permission_request"]) {
    const ev = events.find((e) => e.type === type);
    assert.ok(ev, `${type} emitted`);
    assert.equal(ev.message, out.message, `${type}.message is the rendered text`);
    assert.ok(Array.isArray(ev.decisions), `${type}.decisions`);
    assert.deepEqual(byId(ev.decisions), byId(out.decisions));
    assert.equal(ev.since_sha, baseSha);
    assert.equal(ev.no_changes, false);
    assert.equal(ev.truncated_count, 0);
  }
  // Existing payload fields are kept.
  const gp = events.find((e) => e.type === "gate_paused");
  assert.equal(gp.step_id, "review");
  assert.deepEqual(gp.options, ["approve", "reject"]);
  assert.equal(gp.verdict_input, "verdict");
  const pr = events.find((e) => e.type === "permission_request");
  assert.equal(pr.tool, "workflow-gate");
  assert.equal(pr.request_id, "gc000003:review");
});

test("context gate: `since` defaults to last_approved when omitted", async () => {
  const { dir, baseSha } = standardRepo();
  const steps = gateYaml({ context: `
    context:
      records: ["${PDR_GLOB}"]` });
  const { state } = await runToGate(dir, steps, "gc000004");
  const out = state.stepResults.review.output;
  assert.equal(out.since_sha, baseSha);
  assert.deepEqual(byId(out.decisions).map((d) => d.id), ["PDR-125", "PDR-127"]);
});

test("context gate: id from filename stem when frontmatter has none; frontmatter id wins otherwise; `## Decision` fallback", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/z");
  write(dir, ".adlc/drafts/pdr/PDR-150.md", record({ title: "Stem id", decision: "Stem decision. More." }));
  write(dir, ".adlc/drafts/pdr/pricing-change.md", record({ id: "PDR-151", title: "Frontmatter id", decision: "Fm decision. More." }));
  write(dir, ".adlc/drafts/pdr/PDR-152.md", record({ title: "Plain decision heading", section: "Decision", decision: "Plain section decision! Trailing." }));
  commitAll(dir, "records");
  const { state } = await runToGate(dir, gateYaml(), "gc000005");
  const ds = byId(state.stepResults.review.output.decisions);
  assert.deepEqual(ds.map((d) => d.id), ["PDR-150", "PDR-151", "PDR-152"]);
  assert.ok(ds[0].decision_line.startsWith("Stem decision"));
  assert.ok(!ds[0].decision_line.includes("More"));
  assert.equal(ds[1].path, ".adlc/drafts/pdr/pricing-change.md");
  assert.equal(ds[1].title, "Frontmatter id");
  assert.ok(ds[2].decision_line.startsWith("Plain section decision"));
  assert.ok(!ds[2].decision_line.includes("Trailing"));
  for (const d of ds) assert.equal(d.change, "new");
});

// ── Criterion 2: no changes → explicit wording, never "drafted" ───────────

test("context gate: no record changes since merge-base → no_changes, empty decisions, explicit wording, still pauses", async () => {
  const { dir, baseSha } = noChangeRepo();
  const { state, events } = await runToGate(dir, gateYaml({ message: "Approve PDRs before architecture?" }), "gc000006");
  assert.equal(state.status, RunStatus.PAUSED, "a no-change gate still halts (ADR-422)");
  const out = state.stepResults.review.output;
  assert.deepEqual(out.decisions, []);
  assert.equal(out.no_changes, true);
  assert.equal(out.truncated_count, 0);
  assert.equal(out.since_sha, baseSha);
  assert.ok(out.message.startsWith("Approve PDRs before architecture?"), out.message);
  assert.ok(out.message.includes("No new or changed"), out.message);
  assert.ok(out.message.includes(baseSha.slice(0, 7)), "no-change sentence names the since sha");
  assert.ok(!out.message.includes("drafted"), out.message);
  assert.ok(!out.message.includes("PDR-100"), "stale committed draft is never listed");

  const gp = events.find((e) => e.type === "gate_paused");
  assert.equal(gp.no_changes, true);
  assert.deepEqual(gp.decisions, []);
  assert.equal(gp.message, out.message);
});

// ── Criterion 3: second gate uses the previous approval's approved_sha ────

test("context gate: approval records approved_sha = HEAD and an audit entry in log.jsonl", async () => {
  const { dir, headSha } = standardRepo();
  const { engine } = await runToGate(dir, gateYaml() + `  - id: fin
    type: shell
    run: "echo fin"
`, "gc000007");
  const state = await engine.resume("gc000007", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(state.status, RunStatus.COMPLETED);
  const out = state.stepResults.review.output;
  assert.equal(out.choice, "approve");
  assert.equal(out.approved_sha, headSha);

  const runDir = join(dir, ".adlc", "workflows", "runs", "gc000007");
  const persisted = JSON.parse(readFileSync(join(runDir, "state.json"), "utf-8"));
  assert.equal(persisted.step_results.review.output.approved_sha, headSha);

  const log = readFileSync(join(runDir, "log.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const audit = log.find((e) => e.step_id === "review" && e.approved_sha === headSha && Array.isArray(e.decisions));
  assert.ok(audit, `log.jsonl must carry an audit copy of the approved manifest:\n${log.map((e) => JSON.stringify(e)).join("\n")}`);
  assert.deepEqual(byId(audit.decisions).map((d) => d.id), ["PDR-125", "PDR-127"]);
});

test("context gate: second context gate lists only records changed after the first gate's approved_sha", async () => {
  const { dir, headSha } = standardRepo();
  const steps =
    gateYaml({ id: "gate-a", verdict: "va", message: "Approve PDRs (A)?" }) +
    `  - id: bump
    type: shell
    run: "echo Addendum >> .adlc/drafts/pdr/PDR-125.md && git add .adlc/drafts && git commit -q -m bump"
` +
    gateYaml({ id: "gate-b", verdict: "vb", message: "Approve PDRs (B)?" });
  const { engine, state: s1 } = await runToGate(dir, steps, "gc000008", { va: "", vb: "" }, ["va", "vb"]);
  assert.equal(s1.currentStepId, "gate-a");
  assert.deepEqual(byId(s1.stepResults["gate-a"].output.decisions).map((d) => d.id), ["PDR-125", "PDR-127"]);

  const s2 = await engine.resume("gc000008", { va: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.PAUSED);
  assert.equal(s2.currentStepId, "gate-b");
  assert.equal(s2.stepResults.bump.status, StepStatus.COMPLETED, "fixture commit step ran");
  assert.notEqual(git(dir, "rev-parse", "HEAD"), headSha, "bump created a new commit");

  assert.equal(s2.stepResults["gate-a"].output.approved_sha, headSha);
  const outB = s2.stepResults["gate-b"].output;
  assert.equal(outB.since_sha, headSha, "gate B diffs from gate A's approved_sha");
  assert.deepEqual(byId(outB.decisions).map((d) => [d.id, d.change]), [["PDR-125", "changed"]]);
  assert.equal(outB.no_changes, false);
  assert.ok(!outB.message.includes("PDR-127"), outB.message);
});

// ── Criterion 4: cap at 10 ───────────────────────────────────────────────

test("context gate: 25 changed records → 10 listed, truncated_count 15, 'and 15 more'", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/many");
  const ids = [];
  for (let i = 200; i < 225; i++) {
    ids.push(`PDR-${i}`);
    write(dir, `.adlc/drafts/pdr/PDR-${i}.md`, record({ title: `Decision ${i}`, decision: `We do ${i}.` }));
  }
  commitAll(dir, "many");
  const { state, events } = await runToGate(dir, gateYaml(), "gc000009");
  const out = state.stepResults.review.output;
  assert.equal(out.decisions?.length, 10);
  assert.equal(out.truncated_count, 15);
  assert.equal(out.no_changes, false);
  assert.ok(out.message.includes("and 15 more"), out.message);
  const listed = ids.filter((id) => out.message.includes(id));
  assert.equal(listed.length, 10, `exactly 10 records rendered, got ${listed.length}`);
  const gp = events.find((e) => e.type === "gate_paused");
  assert.equal(gp.truncated_count, 15);
  assert.equal(gp.decisions?.length, 10);
});

// ── Criterion 5: unparseable records never block the gate ─────────────────

test("context gate: malformed records are listed with title fallback + link and the gate still pauses", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/bad");
  write(dir, ".adlc/drafts/pdr/PDR-130.md", "---\n: : :\n\tbad: [unclosed\nno closing fence, no heading, no decision section\n");
  write(dir, ".adlc/drafts/pdr/PDR-131.md", "just some prose without any structure\n");
  write(dir, ".adlc/drafts/pdr/PDR-132.md", record({ title: "Good one", decision: "We are fine." }));
  commitAll(dir, "bad records");
  const { state, events } = await runToGate(dir, gateYaml(), "gc000010");
  assert.equal(state.status, RunStatus.PAUSED, "parse failure must never fail the gate");
  assert.equal(state.stepResults.review.status, StepStatus.PAUSED);
  const ds = byId(state.stepResults.review.output.decisions);
  assert.deepEqual(ds.map((d) => d.id), ["PDR-130", "PDR-131", "PDR-132"]);
  for (const d of ds.slice(0, 2)) {
    assert.equal(typeof d.title, "string");
    assert.ok(d.title.includes(d.id), `title falls back to the filename: ${d.title}`);
    assert.equal(d.decision_line, null);
    assert.ok(d.link.includes(`${d.id}.md`));
    assert.equal(d.change, "new");
  }
  assert.ok(ds[2].decision_line.startsWith("We are fine"));
  const msg = state.stepResults.review.output.message;
  for (const id of ["PDR-130", "PDR-131", "PDR-132"]) assert.ok(msg.includes(id), msg);
  assert.ok(events.some((e) => e.type === "gate_paused"));
});

// ── Security: only record fields rendered, control chars stripped ─────────

test("context gate: rendered message strips ANSI/control chars from record fields and leaks no other content", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/evil");
  write(dir, ".adlc/drafts/pdr/PDR-160.md", record({
    title: "Evil \x1b[31mRed\x1b[0m title\x07",
    decision: "We \x1b]0;pwned\x07decide. Rest.",
    extra: "SECRET_TOKEN=s3cr3t-value-123",
  }));
  write(dir, "secrets.env", "API_KEY=do-not-leak-999\n");
  commitAll(dir, "evil");
  const { state, events } = await runToGate(dir, gateYaml(), "gc000011");
  const out = state.stepResults.review.output;
  assert.equal(out.decisions?.length, 1);
  assert.ok(out.message.includes("PDR-160"), out.message);
  assert.ok(out.message.includes("Evil"), out.message);
  assert.ok(!out.message.includes("\x1b"), "raw ESC must not reach the message");
  assert.ok(!CONTROL_EXCEPT_NL_TAB.test(out.message), JSON.stringify(out.message));
  assert.ok(!out.message.includes("s3cr3t-value-123"), "record body outside title/decision must not be rendered");
  assert.ok(!out.message.includes("do-not-leak-999"));
  for (const type of ["gate_paused", "permission_request"]) {
    const ev = events.find((e) => e.type === type);
    assert.ok(!CONTROL_EXCEPT_NL_TAB.test(ev.message), `${type}.message`);
    assert.ok(!JSON.stringify(ev.decisions ?? null).includes("\\u001b"), `${type}.decisions must not carry ESC`);
  }
});

// ── Criterion 6: gates without context are unchanged (expected to pass now) ─

test("no-context gate: message unchanged, no manifest keys, pauses and completes as before", async () => {
  const { dir } = standardRepo();
  const steps = gateYaml({ context: "", message: "Product decisions drafted. Approve PDRs before architecture?" }) + `  - id: fin
    type: shell
    run: "echo fin"
`;
  const { engine, events, state } = await runToGate(dir, steps, "gc000012");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults.review.output;
  assert.equal(out.message, "Product decisions drafted. Approve PDRs before architecture?");
  assert.equal(out.decisions, undefined);
  assert.equal(out.since_sha, undefined);
  assert.equal(out.no_changes, undefined);
  const gp = events.find((e) => e.type === "gate_paused");
  assert.equal(gp.message, "Product decisions drafted. Approve PDRs before architecture?");
  assert.equal(gp.decisions, undefined);
  const pr = events.find((e) => e.type === "permission_request");
  assert.equal(pr.message, gp.message);
  assert.equal(pr.decisions, undefined);

  const s2 = await engine.resume("gc000012", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED);
  assert.equal(s2.stepResults.review.output.choice, "approve");
});

test("context gate outside a git repo: never fails, still pauses with the static message first (expected to pass now)", async () => {
  const dir = tempDir("gate-ctx-nogit-");
  write(dir, ".adlc/drafts/pdr/PDR-1.md", record({ title: "x", decision: "y." }));
  const { state, events } = await runToGate(dir, gateYaml(), "gc000013");
  assert.equal(state.status, RunStatus.PAUSED);
  assert.ok(state.stepResults.review.output.message.startsWith("Approve product decisions before architecture?"));
  assert.ok(events.some((e) => e.type === "gate_paused"));
});

// ── Criterion 7: validation ─────────────────────────────────────────────

function defWithContext(contextYaml) {
  return WorkflowDefinition.fromString(`schema_version: "1.0"
workflow:
  id: ctx-validate
  name: V
  version: "1.0.0"
inputs:
  verdict: {type: string}
steps:
  - id: g
    type: gate
    message: "ok?"
    options: [approve, reject]
    verdict_input: verdict
${contextYaml}
`);
}

test("validate: accepts a valid context (with and without since) (expected to pass now)", () => {
  assert.deepEqual(validateWorkflow(defWithContext(`    context:
      records: ["${PDR_GLOB}", ".adlc/drafts/adr/*.md"]
      since: last_approved`), STEP_REGISTRY), []);
  assert.deepEqual(validateWorkflow(defWithContext(`    context:
      records:
        - "${PDR_GLOB}"`), STEP_REGISTRY), []);
});

const INVALID_CONTEXTS = [
  ["unknown key inside context", `    context:
      records: ["${PDR_GLOB}"]
      bogus_key: 1`, ["context", "bogus_key"]],
  ["records is a string", `    context:
      records: "${PDR_GLOB}"`, ["context", "records"]],
  ["records is empty", `    context:
      records: []`, ["context", "records"]],
  ["records has a non-string", `    context:
      records: ["${PDR_GLOB}", 3]`, ["context", "records"]],
  ["records missing", `    context:
      since: last_approved`, ["context", "records"]],
  ["since is not last_approved", `    context:
      records: ["${PDR_GLOB}"]
      since: yesterday`, ["context", "since"]],
  ["context is not a mapping", `    context: "${PDR_GLOB}"`, ["context"]],
];

for (const [name, yaml, mustMention] of INVALID_CONTEXTS) {
  test(`validate: rejects context — ${name}`, () => {
    const errors = validateWorkflow(defWithContext(yaml), STEP_REGISTRY);
    const hit = errors.find((e) => mustMention.every((m) => e.includes(m)));
    assert.ok(hit, `expected an error mentioning ${mustMention.join(" + ")}, got ${JSON.stringify(errors)}`);
  });
}

test("cli: `workflow validate` rejects an unknown context key with a non-zero exit", () => {
  const cwd = tempDir("gate-ctx-cli-");
  const path = join(cwd, "wf.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-cli
  name: C
  version: "1.0.0"
steps:
  - id: g
    type: gate
    message: "ok?"
    options: [approve, reject]
    context:
      records: ["${PDR_GLOB}"]
      nope: true
`, "utf-8");
  const r = spawnSync(process.execPath, [CLI, "workflow", "validate", path], { cwd, encoding: "utf-8" });
  assert.notEqual(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok((r.stderr + r.stdout).includes("nope"));
});

// ── Builtins: factory gates declare context, neutral wording ──────────────

const FACTORY_GATE_RECORDS = {
  "gate-product": ".adlc/drafts/pdr/*.md",
  "gate-architecture": ".adlc/drafts/adr/*.md",
  "gate-completion": ".adlc/drafts/chdr/*.md",
};

test("builtin factory: stage gates declare context.records and neutral messages", () => {
  const engine = new WorkflowEngine(tempDir("gate-ctx-builtin-"));
  const def = engine.loadWorkflow("factory");
  for (const [gateId, glob] of Object.entries(FACTORY_GATE_RECORDS)) {
    const step = def.steps.find((s) => s.id === gateId);
    assert.ok(step, gateId);
    assert.equal(step.type, "gate");
    assert.ok(step.context && Array.isArray(step.context.records), `${gateId} declares context.records`);
    assert.ok(step.context.records.includes(glob), `${gateId} records include ${glob}`);
    assert.ok(!/drafted/i.test(step.message), `${gateId} message must not claim 'drafted': ${step.message}`);
  }
  assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
  assert.deepEqual(headlessGateErrors(def), []);
});

test("builtin factory: gate-product pauses with the PDR manifest from the run's git repo", async () => {
  const { dir, baseSha } = standardRepo();
  const engine = new WorkflowEngine(dir);
  const def = engine.loadWorkflow("factory");
  const stubDef = new WorkflowDefinition({
    ...def.data,
    steps: def.steps.map((s) => (s.type === "command" ? { id: s.id, type: "shell", run: `echo ${s.id}` } : s)),
  }, null, def.sourceYaml);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const state = await engine.execute(stubDef, { verdict: "" }, "gc000014", STEP_REGISTRY);
  assert.equal(state.status, RunStatus.PAUSED);
  assert.equal(state.currentStepId, "gate-product");
  const out = state.stepResults["gate-product"].output;
  assert.ok(Array.isArray(out.decisions), "gate-product output.decisions");
  assert.deepEqual(byId(out.decisions).map((d) => [d.id, d.change]), [["PDR-125", "changed"], ["PDR-127", "new"]]);
  assert.equal(out.since_sha, baseSha);
  assert.ok(!out.message.includes("drafted"));
  const gp = events.find((e) => e.type === "gate_paused");
  assert.equal(gp.step_id, "gate-product");
  assert.equal(gp.message, out.message);
});
