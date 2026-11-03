// Gate Decision Manifest — iteration 6 (factory-review self-heal on
// tikalk/adlc-cli#39, iteration 4: U1, U2). Builds on
// tests/workflow-gate-context{,-2,-3,-4,-5}.test.mjs.
//
// Contract pinned here:
//   U1  Each listed decision renders per ADR-391-amendment-gate-decision-
//       context §Decision Outcome step 4:
//
//         • <id> (<new|changed>) — <title>
//           Decision: <decision_line>
//           <link> · status: <status>[ (diff: <compare-url>)]
//
//       - ` — <title>` is omitted when the title is empty or equals the id.
//       - The `Decision:` line is omitted when decision_line is null.
//       - <status> is the record status, `unknown` when it has none.
//       - The ` (diff: <compare-url>)` suffix appears ONLY for `changed`
//         records AND only when the branch tracks a web (GitHub/GitLab)
//         remote. <compare-url> is
//           GitHub-style: <repo>/compare/<since>...<head>
//           GitLab:       <repo>/-/compare/<since>...<head>
//         with <since>/<head> the manifest's since_sha/head_sha (full or
//         abbreviated to >= 7 hex chars). The URL is printed in plain text
//         (bare URL, like every other link in the message — no Slack
//         `<url|text>` syntax, which record text is never allowed to carry).
//       Header, no-change sentence, `…and N more: <link>` and the final
//       `Merge request: <url>` line are unchanged.
//   U2  Exact-string snapshots of the whole message (shas normalised to
//       `<sha>`) for a 2-PDR fixture (one new, one changed), without and with
//       a GitHub remote; and exact no-context gate guards: output, the
//       gate_paused / permission_request payloads, state.json and log.jsonl
//       match the pre-feature (base 8a6316a) shape exactly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { buildGateManifest, renderGateMessage } from "../src/workflow/gate-context.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";
const GITHUB = "https://github.com/acme/repo";
const GITLAB = "https://gitlab.example.com/group/repo";

// The one place the diff-suffix spelling lives (see contract above).
const diffSuffix = (url) => ` (diff: ${url})`;

// ── fixture helpers (same shape as workflow-gate-context-5) ───────────────

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

function record({ id = null, title, fmTitle = null, status = "Proposed", decision = null }) {
  const fm = ["---"];
  if (id) fm.push(`id: ${id}`);
  if (fmTitle) fm.push(`title: ${fmTitle}`);
  if (status) fm.push(`status: ${status}`);
  fm.push("---", "");
  const body = [`# ${title}`, "", "## Context", "", "Background.", ""];
  if (decision !== null) body.push("## Decision Outcome", "", decision, "");
  body.push("## Consequences", "", "Some.", "");
  return [...fm, ...body].join("\n");
}

function initRepo(branch = "main") {
  const dir = tempDir("gate-ctx6-repo-");
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, ".gitignore", ".adlc/workflows/\n");
  return dir;
}

// The 2-PDR fixture: main has PDR-125; feature/x changes PDR-125 and adds
// PDR-127 (plus noise outside the glob).
function twoPdrRepo() {
  const dir = initRepo();
  write(dir, ".adlc/drafts/pdr/PDR-125.md", record({ title: "Billing tiers", status: "Proposed", decision: "We offer two tiers. Details follow." }));
  write(dir, "src/app.js", "v1\n");
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/x");
  write(dir, ".adlc/drafts/pdr/PDR-125.md", record({ title: "Billing tiers", status: "Accepted", decision: "We offer three tiers. Details follow." }));
  write(dir, ".adlc/drafts/pdr/PDR-127.md", record({
    title: "Self-serve onboarding",
    status: "Proposed",
    decision: "We ship self-serve onboarding for teams. A second sentence that must not be rendered.",
  }));
  write(dir, "src/app.js", "v2\n");
  const headSha = commitAll(dir, "feature work");
  return { dir, baseSha, headSha, branch: "feature/x" };
}

// Makes `branch` track `origin` at `url` without any network access.
function setUpstream(dir, branch, url) {
  git(dir, "remote", "add", "origin", url);
  git(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  git(dir, "config", `branch.${branch}.remote`, "origin");
  git(dir, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
}

function gateYaml({ id = "review", verdict = "verdict", message = "Approve product decisions before architecture?", context = true, extraContext = "" } = {}) {
  const ctx = context
    ? `
    context:
      records: ["${PDR_GLOB}"]
      since: last_approved
${extraContext}`
    : "\n";
  return `  - id: ${id}
    type: gate
    message: "${message}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: ${verdict}${ctx}`;
}

const FIN = `  - id: fin
    type: shell
    run: "echo fin"
`;

function writeWorkflow(stepsYaml, inputs = ["verdict"]) {
  const wfDir = tempDir("gate-ctx6-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf6
  name: Context Gate 6
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

// Replace every hex sha (7..40 chars) with <sha> so snapshots are stable.
const normShas = (s) => s.replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");

// The lines of one bullet: from `• <id> ` to the next bullet / trailer.
function bulletLines(message, id) {
  const lines = message.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`• ${id} `) || l === `• ${id}`);
  assert.ok(start >= 0, `no bullet for ${id}:\n${message}`);
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && lines[i].startsWith("  "); i++) out.push(lines[i]);
  return out;
}

// Asserts `url` is <base><sep>compare/<since>...<head> for the given shas.
function assertCompareUrl(url, base, sep, sinceSha, headSha) {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${sep}compare/([0-9a-f]{7,40})\\.\\.\\.([0-9a-f]{7,40})$`);
  const m = url.match(re);
  assert.ok(m, `compare URL ${url} must match ${base}${sep}compare/<since>...<head>`);
  assert.ok(sinceSha.startsWith(m[1]), `compare since ${m[1]} must be since_sha ${sinceSha}`);
  assert.ok(headSha.startsWith(m[2]), `compare head ${m[2]} must be head_sha ${headSha}`);
}

const DIFF_RE = / \(diff: (\S+)\)$/;

// ── U1: bullet layout ─────────────────────────────────────────────────────

test("U1: bullet line is `• <id> (<change>) — <title>`", () => {
  const { dir } = twoPdrRepo();
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const msg = renderGateMessage("Approve PDRs?", m);
  assert.equal(bulletLines(msg, "PDR-127")[0], "• PDR-127 (new) — Self-serve onboarding", msg);
  assert.equal(bulletLines(msg, "PDR-125")[0], "• PDR-125 (changed) — Billing tiers", msg);
});

test("U1: second line is `  Decision: <decision_line>` (first sentence only)", () => {
  const { dir } = twoPdrRepo();
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const msg = renderGateMessage("Approve PDRs?", m);
  assert.equal(bulletLines(msg, "PDR-127")[1], "  Decision: We ship self-serve onboarding for teams.", msg);
  assert.equal(bulletLines(msg, "PDR-125")[1], "  Decision: We offer three tiers.", msg);
});

test("U1: third line is `  <link> · status: <status>` (lowercase label, after the link)", () => {
  const { dir } = twoPdrRepo();
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const msg = renderGateMessage("Approve PDRs?", m);
  assert.deepEqual(bulletLines(msg, "PDR-127"), [
    "• PDR-127 (new) — Self-serve onboarding",
    "  Decision: We ship self-serve onboarding for teams.",
    "  .adlc/drafts/pdr/PDR-127.md · status: Proposed",
  ]);
  assert.ok(!msg.includes("Status:"), `old 'Status:' prefix must be gone:\n${msg}`);
});

test("U1: title equal to id → no ` — <title>` on the bullet line", () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/t");
  write(dir, ".adlc/drafts/pdr/PDR-5.md", record({ title: "PDR-5", fmTitle: "PDR-5", decision: "We do five." }));
  commitAll(dir, "rec");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.decisions[0].title, "PDR-5", "fixture: title equals id");
  const msg = renderGateMessage("Approve PDRs?", m);
  assert.equal(bulletLines(msg, "PDR-5")[0], "• PDR-5 (new)", msg);
  assert.ok(!msg.includes("—"), msg);
});

test("U1: empty title → no ` — ` on the bullet line (synthetic manifest)", () => {
  const manifest = {
    decisions: [{ id: "PDR-9", title: "", decision_line: "We do nine.", status: "Proposed", change: "new", path: ".adlc/drafts/pdr/PDR-9.md", link: ".adlc/drafts/pdr/PDR-9.md" }],
    since_sha: "a".repeat(40),
    since_basis: "merge-base",
    head_sha: "b".repeat(40),
    no_changes: false,
    truncated_count: 0,
    total: 1,
    unavailable: null,
    unavailable_kind: null,
    more_link: ".adlc/drafts/pdr",
    kind: "product",
  };
  const msg = renderGateMessage("Approve PDRs?", manifest);
  assert.deepEqual(bulletLines(msg, "PDR-9"), [
    "• PDR-9 (new)",
    "  Decision: We do nine.",
    "  .adlc/drafts/pdr/PDR-9.md · status: Proposed",
  ]);
});

test("U1: no decision line → the `Decision:` line is omitted; no status → `status: unknown`", () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/d");
  write(dir, ".adlc/drafts/pdr/PDR-6.md", record({ title: "No outcome yet", status: null, decision: null }));
  commitAll(dir, "rec");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.decisions[0].decision_line, null, "fixture: no decision line");
  assert.equal(m.decisions[0].status, null, "fixture: no status");
  const msg = renderGateMessage("Approve PDRs?", m);
  assert.deepEqual(bulletLines(msg, "PDR-6"), [
    "• PDR-6 (new) — No outcome yet",
    "  .adlc/drafts/pdr/PDR-6.md · status: unknown",
  ]);
  assert.ok(!msg.includes("Decision:"), msg);
});

test("U1: no web remote → no `(diff` anywhere, even for a changed record", () => {
  const { dir } = twoPdrRepo();
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const msg = renderGateMessage("Approve PDRs?", m);
  assert.ok(!msg.includes("(diff"), msg);
  assert.equal(bulletLines(msg, "PDR-125")[2], "  .adlc/drafts/pdr/PDR-125.md · status: Accepted", msg);
});

test("U1: GitHub https remote → changed record gets ` (diff: <repo>/compare/<since>...<head>)`; new record none", () => {
  const { dir, baseSha, headSha, branch } = twoPdrRepo();
  setUpstream(dir, branch, `${GITHUB}.git`);
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.since_sha, baseSha, "fixture: since = merge-base");
  assert.equal(m.head_sha, headSha);
  const msg = renderGateMessage("Approve PDRs?", m);

  const changed = bulletLines(msg, "PDR-125");
  const link125 = `${GITHUB}/blob/feature/x/.adlc/drafts/pdr/PDR-125.md`;
  assert.ok(changed[2].startsWith(`  ${link125} · status: Accepted (diff: `), changed[2]);
  const dm = changed[2].match(DIFF_RE);
  assert.ok(dm, `diff suffix at the end of the link line: ${changed[2]}`);
  assertCompareUrl(dm[1], GITHUB, "/", baseSha, headSha);

  const added = bulletLines(msg, "PDR-127");
  assert.equal(added[2], `  ${GITHUB}/blob/feature/x/.adlc/drafts/pdr/PDR-127.md · status: Proposed`, "new record: no diff");
  assert.equal(msg.split("(diff").length - 1, 1, `exactly one diff suffix:\n${msg}`);
});

test("U1: GitLab remote → compare URL uses `/-/compare/`", () => {
  const { dir, baseSha, headSha, branch } = twoPdrRepo();
  setUpstream(dir, branch, `${GITLAB}.git`);
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const msg = renderGateMessage("Approve PDRs?", m);
  const line = bulletLines(msg, "PDR-125")[2];
  assert.ok(line.startsWith(`  ${GITLAB}/-/blob/feature/x/.adlc/drafts/pdr/PDR-125.md · status: Accepted (diff: `), line);
  const dm = line.match(DIFF_RE);
  assert.ok(dm, line);
  assertCompareUrl(dm[1], GITLAB, "/-/", baseSha, headSha);
  assert.ok(!bulletLines(msg, "PDR-127")[2].includes("(diff"), msg);
});

test("U1: scp-style git@github.com remote → https compare URL", () => {
  const { dir, baseSha, headSha, branch } = twoPdrRepo();
  setUpstream(dir, branch, "git@github.com:acme/repo.git");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  const msg = renderGateMessage("Approve PDRs?", m);
  const dm = bulletLines(msg, "PDR-125")[2].match(DIFF_RE);
  assert.ok(dm, msg);
  assertCompareUrl(dm[1], GITHUB, "/", baseSha, headSha);
});

test("U1: compare URL starts at the approval sha on a later gate (since = last approval)", async () => {
  const { dir, branch } = twoPdrRepo();
  setUpstream(dir, branch, `${GITHUB}.git`);
  const steps =
    gateYaml({ id: "gate-a", verdict: "va", message: "A?" }) +
    `  - id: bump
    type: shell
    run: "echo Addendum >> .adlc/drafts/pdr/PDR-125.md && git add .adlc/drafts && git commit -q -m bump"
` +
    gateYaml({ id: "gate-b", verdict: "vb", message: "B?" });
  const { engine } = await runWorkflow(dir, steps, "g6u10001", { va: "", vb: "" }, ["va", "vb"]);
  const s2 = await engine.resume("g6u10001", { va: "approve" }, STEP_REGISTRY);
  assert.equal(s2.currentStepId, "gate-b", JSON.stringify(s2.stepResults["gate-b"]));
  const outB = s2.stepResults["gate-b"].output;
  const approved = s2.stepResults["gate-a"].output.approved_sha;
  assert.equal(outB.since_sha, approved, "fixture: since = approval");
  const dm = bulletLines(outB.message, "PDR-125")[2].match(DIFF_RE);
  assert.ok(dm, outB.message);
  assertCompareUrl(dm[1], GITHUB, "/", approved, outB.head_sha);
});

test("U1: header, `…and N more` and final `Merge request:` lines are unchanged around the new layout", async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  const baseSha = commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/many");
  for (let i = 200; i < 213; i++) write(dir, `.adlc/drafts/pdr/PDR-${i}.md`, record({ title: `Decision ${i}`, decision: `We do ${i}.` }));
  commitAll(dir, "many");
  const mr = "https://gitlab.example.com/group/repo/-/merge_requests/42";
  const { state } = await runWorkflow(dir, gateYaml({ extraContext: `      link: "{{ inputs.mr_url }}"\n` }), "g6u10002", { verdict: "", mr_url: mr }, ["verdict", "mr_url"]);
  assert.equal(state.status, RunStatus.PAUSED);
  const lines = state.stepResults.review.output.message.split("\n");
  assert.equal(lines[0], "Approve product decisions before architecture?");
  assert.equal(lines[1], "");
  assert.equal(lines[2], `13 product decisions to approve (since merge-base @${baseSha.slice(0, 7)}):`);
  assert.equal(lines[3], "• PDR-200 (new) — Decision 200");
  assert.equal(lines[4], "  Decision: We do 200.");
  assert.equal(lines[5], "  .adlc/drafts/pdr/PDR-200.md · status: Proposed");
  assert.equal(lines.filter((l) => l.startsWith("• ")).length, 10);
  assert.equal(lines[lines.length - 2], "…and 3 more: .adlc/drafts/pdr");
  assert.equal(lines[lines.length - 1], `Merge request: ${mr}`);
});

// ── U2: exact snapshots ───────────────────────────────────────────────────

const SNAPSHOT_NO_REMOTE = [
  "Approve product decisions before architecture?",
  "",
  "2 product decisions to approve (since merge-base @<sha>):",
  "• PDR-125 (changed) — Billing tiers",
  "  Decision: We offer three tiers.",
  "  .adlc/drafts/pdr/PDR-125.md · status: Accepted",
  "• PDR-127 (new) — Self-serve onboarding",
  "  Decision: We ship self-serve onboarding for teams.",
  "  .adlc/drafts/pdr/PDR-127.md · status: Proposed",
].join("\n");

const SNAPSHOT_GITHUB = [
  "Approve product decisions before architecture?",
  "",
  "2 product decisions to approve (since merge-base @<sha>):",
  "• PDR-125 (changed) — Billing tiers",
  "  Decision: We offer three tiers.",
  `  ${GITHUB}/blob/feature/x/.adlc/drafts/pdr/PDR-125.md · status: Accepted${diffSuffix(`${GITHUB}/compare/<sha>...<sha>`)}`,
  "• PDR-127 (new) — Self-serve onboarding",
  "  Decision: We ship self-serve onboarding for teams.",
  `  ${GITHUB}/blob/feature/x/.adlc/drafts/pdr/PDR-127.md · status: Proposed`,
].join("\n");

test("U2 snapshot: 2-PDR fixture, no web remote — exact message (output and both events)", async () => {
  const { dir } = twoPdrRepo();
  const { state, events } = await runWorkflow(dir, gateYaml(), "g6u20001");
  assert.equal(state.status, RunStatus.PAUSED);
  const msg = state.stepResults.review.output.message;
  assert.equal(normShas(msg), SNAPSHOT_NO_REMOTE);
  for (const type of ["gate_paused", "permission_request"]) {
    assert.equal(events.find((e) => e.type === type)?.message, msg, `${type}.message`);
  }
});

test("U2 snapshot: 2-PDR fixture, GitHub remote — exact message with links and (diff)", async () => {
  const { dir, branch } = twoPdrRepo();
  setUpstream(dir, branch, `${GITHUB}.git`);
  const { state, events } = await runWorkflow(dir, gateYaml(), "g6u20002");
  assert.equal(state.status, RunStatus.PAUSED);
  const msg = state.stepResults.review.output.message;
  assert.equal(normShas(msg), SNAPSHOT_GITHUB);
  for (const type of ["gate_paused", "permission_request"]) {
    assert.equal(events.find((e) => e.type === type)?.message, msg, `${type}.message`);
  }
});

// ── U2: no-context gate is exactly the pre-feature shape (guards) ─────────

const NO_CTX_MESSAGE = "Product decisions drafted. Approve PDRs before architecture?";
const MANIFEST_KEYS = [
  "decisions", "since_sha", "since_basis", "no_changes", "truncated_count", "head_sha", "approved_sha",
  "mr_link", "without_list", "unavailable", "unavailable_reason", "unavailable_kind", "total", "more_link",
];

function withoutTs(event) {
  assert.ok(event, "event emitted");
  assert.equal(typeof event.ts, "string");
  const { ts, ...rest } = event;
  return rest;
}

function assertNoManifestKeys(obj, where) {
  for (const k of MANIFEST_KEYS) assert.ok(!(k in obj), `${where} must not carry '${k}': ${JSON.stringify(obj)}`);
  for (const k of Object.keys(obj)) assert.ok(!k.startsWith("unavailable"), `${where} must not carry '${k}'`);
}

test("U2 guard: no-context gate pause — output, gate_paused, permission_request exactly the base shape", async () => {
  const { dir } = twoPdrRepo();
  const { state, events } = await runWorkflow(dir, gateYaml({ context: false, message: NO_CTX_MESSAGE }) + FIN, "g6u20003");
  assert.equal(state.status, RunStatus.PAUSED);
  assert.equal(state.stepResults.review.status, StepStatus.PAUSED);
  const out = state.stepResults.review.output;
  assert.deepEqual(out, {
    message: NO_CTX_MESSAGE,
    options: ["approve", "reject"],
    on_reject: "abort",
    show_file: undefined,
    choice: null,
  });
  assertNoManifestKeys(out, "output");

  assert.deepEqual(withoutTs(events.find((e) => e.type === "gate_paused")), {
    type: "gate_paused",
    run_id: "g6u20003",
    step_id: "review",
    message: NO_CTX_MESSAGE,
    options: ["approve", "reject"],
    on_reject: "abort",
    verdict_input: "verdict",
  });
  assert.deepEqual(withoutTs(events.find((e) => e.type === "permission_request")), {
    type: "permission_request",
    tool: "workflow-gate",
    request_id: "g6u20003:review",
    run_id: "g6u20003",
    step_id: "review",
    message: NO_CTX_MESSAGE,
    options: ["approve", "reject"],
    verdict_input: "verdict",
  });

  const persisted = persistedState(dir, "g6u20003");
  assert.ok(!("run_start_sha" in persisted), `state.json must not carry run_start_sha: ${JSON.stringify(persisted)}`);
  assert.ok(!("last_approved_sha" in persisted), "state.json must not carry last_approved_sha");
  assert.deepEqual(persisted.step_results.review.output, {
    message: NO_CTX_MESSAGE,
    options: ["approve", "reject"],
    on_reject: "abort",
    choice: null,
  });
});

test("U2 guard: no-context gate approve — completed output, state.json and log.jsonl exactly the base shape", async () => {
  const { dir } = twoPdrRepo();
  const { engine } = await runWorkflow(dir, gateYaml({ context: false, message: NO_CTX_MESSAGE }) + FIN, "g6u20004");
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume("g6u20004", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED);
  assert.equal(s2.stepResults.fin?.status, StepStatus.COMPLETED);
  const out = s2.stepResults.review.output;
  assert.deepEqual(out, {
    message: NO_CTX_MESSAGE,
    options: ["approve", "reject"],
    on_reject: "abort",
    show_file: undefined,
    choice: "approve",
  });
  assertNoManifestKeys(out, "completed output");
  assert.ok(!events.some((e) => e.type === "gate_paused" || e.type === "permission_request"), "approval emits no pause events");

  const persisted = persistedState(dir, "g6u20004");
  assert.ok(!("run_start_sha" in persisted), "state.json must not carry run_start_sha after completion");
  assert.ok(!("last_approved_sha" in persisted), "state.json must not carry last_approved_sha after approval");
  assert.deepEqual(persisted.step_results.review.output, {
    message: NO_CTX_MESSAGE,
    options: ["approve", "reject"],
    on_reject: "abort",
    choice: "approve",
  });

  const log = logEntries(dir, "g6u20004");
  assert.ok(log.length > 0, "fixture: log.jsonl written");
  for (const e of log) {
    assert.notEqual(e.event, "gate_approved", `no gate_approved audit entry: ${JSON.stringify(e)}`);
    for (const k of ["decisions", "approved_sha", "since_sha", "without_list", "unavailable_kind"]) {
      assert.ok(!(k in e), `log entry must not carry '${k}': ${JSON.stringify(e)}`);
    }
  }
});
