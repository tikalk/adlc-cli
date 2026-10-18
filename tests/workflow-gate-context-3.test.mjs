// Gate Decision Manifest — iteration 3 (factory-review self-heal on
// tikalk/adlc-cli#39: R1, R2, R3, N2, N4). Builds on
// tests/workflow-gate-context.test.mjs and tests/workflow-gate-context-2.test.mjs.
//
// Contract pinned here:
//   R1  Every record-derived field (id, title, decision_line, status) is made
//       Slack-safe at parse time, so both output.message and decisions[] are:
//         - zero-width / bidi code points U+200B–U+200F, U+202A–U+202E,
//           U+2066–U+2069 are stripped;
//         - & < > → &amp; &lt; &gt;
//         - @here / @channel / @everyone are broken with U+2060 after '@';
//         - backticks never survive.
//   R2  No-web link fallback percent-encodes each path segment (like the web
//       branch). A changed path containing a control char is listed with the
//       placeholder "(unprintable path)"; no field (id, title, path, link)
//       carries a control char, so no message line can be injected.
//   R3  A context gate accepts a bound headless non-reject verdict ONLY when it
//       previously PAUSED with a manifest whose head_sha is non-null and HEAD
//       still equals it. Otherwise the bound verdict input is cleared ("") and
//       the gate PAUSES with the freshly built manifest (gate_paused emitted,
//       no approved_sha, no gate_approved). Consequences: a verdict preset at a
//       context gate's first execution no longer approves; a shared
//       `verdict_input` cannot auto-pass a later context gate; a "Decision list
//       unavailable" pause re-pauses on approve. Reject verdicts and gates
//       without `context` are unchanged.
//   N2  A decision line's first sentence ends at [.!?] + whitespace + an
//       uppercase letter, or at end of text — abbreviations such as "e.g." /
//       "i.e." do not end it.
//   N4  When `since` (last approval sha) is not an ancestor of HEAD (rebase /
//       force-push), `since` falls back to the merge-base resolution and the
//       message is labelled accordingly ("since merge-base @<sha7>").

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { BUILTIN_WORKFLOWS } from "../src/workflow/builtins.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { buildGateManifest, renderGateMessage, parseRecord } from "../src/workflow/gate-context.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";

// ── fixture helpers (same shape as workflow-gate-context-2) ───────────────

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

// Workflow `shell` steps run under cmd.exe on Windows: fixture steps use only
// `&&`, `||`, `( )` and double-quoted paths; file edits go through a node
// helper with base64 content (see workflow-gate-context-2).
let fixtureHelper = null;
function fileStepCmd(op, rel, text) {
  if (fixtureHelper === null) {
    fixtureHelper = join(tempDir("gate-ctx3-fx-"), "fx.mjs");
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

function initRepo(prefix = "gate-ctx3-repo-") {
  const dir = tempDir(prefix);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, ".gitignore", ".adlc/workflows/\n");
  return dir;
}

// main: PDR-100. feature/x: adds PDR-127.
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

function gateYaml({ id = "review", verdict = "verdict", message = "Approve decisions?", records = [PDR_GLOB], onReject = "abort" } = {}) {
  return `  - id: ${id}
    type: gate
    message: "${message}"
    options: [approve, reject]
    on_reject: ${onReject}
    verdict_input: ${verdict}
    context:
      records: [${records.map((r) => `"${r}"`).join(", ")}]
      since: last_approved
`;
}

const FIN = `  - id: fin
    type: shell
    run: "echo fin"
`;

function writeWorkflow(stepsYaml, inputs = ["verdict"]) {
  const wfDir = tempDir("gate-ctx3-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf3
  name: Context Gate 3
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
const RECORD_FIELDS = ["id", "title", "decision_line", "status"];
const CONTROL = /[\x00-\x1f\x7f]/;
const INVISIBLE = /[​-‏‪-‮⁦-⁩]/;

// ── R1: record-derived fields are Slack-safe ──────────────────────────────

function slackRepo() {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/r1");
  write(
    dir,
    ".adlc/drafts/pdr/PDR-1.md",
    [
      "---",
      "id: PDR-1 <!channel> @everyone",
      "status: accepted @here",
      "---",
      "",
      "# Title <https://evil.example|click here> ```code``` <@U123> @channel ‮evil​ A & B",
      "",
      "## Decision Outcome",
      "",
      "We approve <@U123> and <!subteam^S1> now @here `x`. More.",
      "",
    ].join("\n"),
  );
  commitAll(dir, "hostile record");
  return dir;
}

test("R1: Slack control syntax in record fields is neutralised in decisions[] and the rendered message", () => {
  const dir = slackRepo();
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.unavailable, null, "fixture: manifest available");
  assert.equal(m.decisions.length, 1);
  const [d] = m.decisions;
  const message = renderGateMessage("Approve PDRs?", m);

  const haystacks = [["message", message], ...RECORD_FIELDS.map((f) => [`decisions[0].${f}`, d[f] ?? ""])];
  for (const [name, text] of haystacks) {
    for (const bad of ["<!", "<@", "<http", "`"]) {
      assert.ok(!text.includes(bad), `${name} must not contain ${JSON.stringify(bad)}: ${JSON.stringify(text)}`);
    }
    assert.ok(!/@(here|channel|everyone)\b/.test(text), `${name} must not contain a live @here/@channel/@everyone: ${JSON.stringify(text)}`);
    assert.ok(!INVISIBLE.test(text), `${name} must not contain zero-width/bidi code points: ${JSON.stringify(text)}`);
  }
  for (const f of RECORD_FIELDS) {
    assert.ok(!/[<>]/.test(d[f] ?? ""), `decisions[0].${f} must not contain a raw < or >: ${JSON.stringify(d[f])}`);
  }
  assert.ok(d.id.includes("&lt;!channel&gt;"), `< > escaped as &lt; &gt;: ${JSON.stringify(d.id)}`);
  assert.ok(d.title.includes("A &amp; B"), `& escaped as &amp;: ${JSON.stringify(d.title)}`);
  assert.ok(d.title.includes("&lt;https://evil.example|click here&gt;"), d.title);
  assert.equal(d.status, "accepted @⁠here", "@here broken with U+2060 after '@'");
  assert.ok(d.decision_line.startsWith("We approve &lt;@U123&gt; and &lt;!subteam^S1&gt; now @⁠here"), JSON.stringify(d.decision_line));
});

test("R1: the paused gate output and gate_paused event carry only neutralised record text", async () => {
  const dir = slackRepo();
  const { state, events } = await runWorkflow(dir, gateYaml(), "g3r10001");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults.review.output;
  const gp = events.find((e) => e.type === "gate_paused");
  assert.ok(gp, "gate_paused emitted");
  for (const [name, text] of [["output", JSON.stringify(out.decisions) + out.message], ["gate_paused", JSON.stringify(gp.decisions) + gp.message]]) {
    for (const bad of ["<!", "<@", "<http", "`", "@here", "@channel", "@everyone"]) {
      assert.ok(!text.includes(bad), `${name} must not contain ${JSON.stringify(bad)}: ${text}`);
    }
  }
});

// ── R2: link / path sanitising ────────────────────────────────────────────

test("R2: no web remote → link percent-encodes path segments like the web branch", () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/r2");
  write(dir, ".adlc/drafts/pdr/PDR-300 my <decision>.md", record({ title: "Spaced", decision: "Spaced decision." }));
  commitAll(dir, "spaced");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.decisions.length, 1);
  const [d] = m.decisions;
  assert.equal(d.link, ".adlc/drafts/pdr/" + encodeURIComponent("PDR-300 my <decision>.md"));
  const message = renderGateMessage("Approve PDRs?", m);
  assert.ok(!message.includes("<decision>"), message);
});

test("R2: a record filename with a newline cannot inject message lines", { skip: process.platform === "win32" }, () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/r2nl");
  write(dir, ".adlc/drafts/pdr/PDR-3\nInjected: <!channel>.md", "# x\n");
  write(dir, ".adlc/drafts/pdr/PDR-4.md", record({ title: "Normal", decision: "Normal decision." }));
  commitAll(dir, "newline path");
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.unavailable, null);
  assert.equal(m.decisions.length, 2, JSON.stringify(m.decisions));
  for (const d of m.decisions) {
    for (const f of ["id", "title", "path", "link"]) {
      assert.ok(!CONTROL.test(String(d[f] ?? "")), `decision.${f} must not carry a control char: ${JSON.stringify(d[f])}`);
    }
  }
  const message = renderGateMessage("Approve PDRs?", m);
  const lines = message.split("\n");
  assert.ok(!lines.some((l) => l.startsWith("Injected")), `no injected line:\n${message}`);
  assert.ok(!message.includes("<!channel>"), message);
  assert.ok(message.includes("(unprintable path)"), `control-char path listed with a placeholder:\n${message}`);
  assert.ok(message.includes("PDR-4"), message);
});

// ── R3: no approval of an unseen manifest ─────────────────────────────────

test("R3: verdict preset at a context gate's first execution → pauses (verdict cleared); resume approve approves the shown manifest", async () => {
  const { dir, headSha } = featureRepo();
  const { engine, events, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, "g3r30001", { verdict: "approve" });
  assert.equal(s1.status, RunStatus.PAUSED, "an unseen manifest must never be approved");
  assert.equal(s1.currentStepId, "review");
  assert.equal(s1.stepResults.review.status, StepStatus.PAUSED);
  const out1 = s1.stepResults.review.output;
  assert.equal(out1.approved_sha, undefined);
  assert.equal(out1.head_sha, headSha);
  assert.deepEqual(ids(out1.decisions), ["PDR-127"]);
  assert.equal(s1.inputs.verdict, "", "the bound verdict input is cleared");
  assert.equal(s1.stepResults.fin, undefined);
  assert.ok(events.some((e) => e.type === "gate_paused" && e.step_id === "review"), "gate_paused emitted");
  assert.ok(!logEntries(dir, "g3r30001").some((e) => e.event === "gate_approved"), "no gate_approved");
  assert.equal(persistedState(dir, "g3r30001").last_approved_sha, undefined, "no last_approved_sha");

  const s2 = await engine.resume("g3r30001", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED);
  assert.equal(s2.stepResults.review.output.approved_sha, headSha);
  const audit = logEntries(dir, "g3r30001").filter((e) => e.event === "gate_approved");
  assert.equal(audit.length, 1);
  assert.deepEqual(ids(audit[0].decisions), ["PDR-127"]);
});

test("R3: builtin factory — approving gate-product does not auto-pass gate-architecture (shared verdict input)", async () => {
  const { dir, headSha } = featureRepo();
  // The builtin factory YAML with each `command` step swapped for a shell
  // stub (resume re-reads the run's workflow.yml copy, so the stub must be
  // real YAML); intent-architecture commits an ADR nobody has been shown.
  const adrCmd = `${fileStepCmd("write", ".adlc/drafts/adr/ADR-9.md", "# Unseen ADR\n\n## Decision Outcome\n\nWe never showed this.\n")} && git add .adlc/drafts && git commit -q -m adr`;
  const yaml = BUILTIN_WORKFLOWS.factory.yaml.replace(
    /^( {4})type: command\n {4}command: ([\w-]+)\n/gm,
    (_, i, cmd) => `${i}type: shell\n${i}run: '${cmd === "factory-architect" ? adrCmd : `echo ${cmd}`}'\n`,
  );
  assert.ok(!yaml.includes("type: command"), "fixture: every command step stubbed");
  assert.ok(yaml.includes("verdict_input: verdict"), "fixture: builtin gates keep the shared verdict input");
  const wfPath = join(tempDir("gate-ctx3-wf-"), "factory.yml");
  writeFileSync(wfPath, yaml, "utf-8");
  const engine = new WorkflowEngine(dir);
  const stubDef = engine.loadWorkflow(wfPath);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s1 = await engine.execute(stubDef, { verdict: "" }, "g3r30002", STEP_REGISTRY);
  assert.equal(s1.status, RunStatus.PAUSED);
  assert.equal(s1.currentStepId, "gate-product");

  events.length = 0;
  const s2 = await engine.resume("g3r30002", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.stepResults["gate-product"].output.approved_sha, headSha, "gate-product approved what it showed");
  assert.equal(s2.stepResults["intent-architecture"]?.status, StepStatus.COMPLETED, "fixture: ADR commit step ran");
  assert.equal(s2.status, RunStatus.PAUSED, "gate-architecture must pause, not inherit gate-product's verdict");
  assert.equal(s2.currentStepId, "gate-architecture");
  const arch = s2.stepResults["gate-architecture"];
  assert.equal(arch.status, StepStatus.PAUSED);
  assert.equal(arch.output.approved_sha, undefined);
  assert.deepEqual(ids(arch.output.decisions), ["ADR-9"]);
  assert.equal(s2.inputs.verdict, "", "shared verdict input cleared at the unseen gate");
  assert.equal(s2.stepResults.execute, undefined, "downstream steps must not run");
  assert.ok(events.some((e) => e.type === "gate_paused" && e.step_id === "gate-architecture"), "gate_paused for gate-architecture");
  const approvals = logEntries(dir, "g3r30002").filter((e) => e.event === "gate_approved");
  assert.deepEqual(approvals.map((e) => e.step_id), ["gate-product"], "no gate_approved for gate-architecture");
  assert.ok(!JSON.stringify(approvals).includes("Unseen ADR"), "an unseen record is never in an approval audit");
  assert.equal(persistedState(dir, "g3r30002").last_approved_sha, headSha, "since is not moved past the unseen records");

  // Approving the now-shown architecture list completes that gate; the next
  // context gate (gate-completion) pauses in turn.
  const archHead = git(dir, "rev-parse", "HEAD");
  const s3 = await engine.resume("g3r30002", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s3.stepResults["gate-architecture"].output.approved_sha, archHead);
  assert.equal(s3.status, RunStatus.PAUSED);
  assert.equal(s3.currentStepId, "gate-completion");
  assert.equal(s3.stepResults["gate-completion"].output.approved_sha, undefined);
  const approvals3 = logEntries(dir, "g3r30002").filter((e) => e.event === "gate_approved");
  assert.deepEqual(approvals3.map((e) => e.step_id), ["gate-product", "gate-architecture"]);
});

test("R3: 'Decision list unavailable' pause (head_sha null) + approve → re-pauses, nothing approved", async () => {
  const dir = tempDir("gate-ctx3-nogit-");
  write(dir, ".adlc/drafts/pdr/PDR-1.md", record({ title: "x", decision: "y." }));
  const { engine, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, "g3r30003");
  assert.equal(s1.status, RunStatus.PAUSED);
  assert.ok(s1.stepResults.review.output.message.includes("Decision list unavailable"), s1.stepResults.review.output.message);
  assert.equal(s1.stepResults.review.output.head_sha, null, "fixture: unavailable manifest has head_sha null");

  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume("g3r30003", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.PAUSED, "an unavailable list cannot be approved");
  assert.equal(s2.currentStepId, "review");
  assert.equal(s2.stepResults.review.status, StepStatus.PAUSED);
  assert.equal(s2.stepResults.review.output.approved_sha, undefined);
  assert.equal(s2.stepResults.fin, undefined);
  assert.equal(s2.inputs.verdict, "", "bound verdict cleared");
  assert.ok(events.some((e) => e.type === "gate_paused" && e.step_id === "review"), "gate_paused re-emitted");
  assert.ok(!logEntries(dir, "g3r30003").some((e) => e.event === "gate_approved"));
});

test("R3 guard: verdict 'reject' preset at first execution still rejects immediately (expected to pass now)", async () => {
  const { dir } = featureRepo();
  const { state } = await runWorkflow(dir, gateYaml() + FIN, "g3r30004", { verdict: "reject" });
  assert.equal(state.status, RunStatus.ABORTED);
  assert.equal(state.stepResults.review.output.choice, "reject");
  assert.equal(state.stepResults.fin, undefined);
});

test("R3 guard: gate WITHOUT context + preset approve still completes at first execution (expected to pass now)", async () => {
  const { dir } = featureRepo();
  const steps = `  - id: review
    type: gate
    message: "Plain gate"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
` + FIN;
  const { state } = await runWorkflow(dir, steps, "g3r30005", { verdict: "approve" });
  assert.equal(state.status, RunStatus.COMPLETED);
  assert.equal(state.stepResults.review.output.choice, "approve");
  assert.equal(state.stepResults.review.output.approved_sha, undefined);
  assert.equal(state.inputs.verdict, "approve", "no-context gates do not clear the verdict");
});

// ── N2: firstSentence does not cut at abbreviations ───────────────────────

for (const [decision, expected] of [
  ["Use e.g. Postgres for storage. More.", "Use e.g. Postgres for storage."],
  ["Pick a store, i.e. Postgres, for state. Next one.", "Pick a store, i.e. Postgres, for state."],
  ["We ship self-serve onboarding. A second sentence.", "We ship self-serve onboarding."],
  ["Done! Next.", "Done!"],
  ["Version 2.0 ships now", "Version 2.0 ships now"],
]) {
  test(`N2: decision line ${JSON.stringify(decision)} → ${JSON.stringify(expected)}`, () => {
    const r = parseRecord(".adlc/drafts/pdr/PDR-1.md", record({ title: "T", decision }));
    assert.equal(r.decision_line, expected);
  });
}

// ── N4: since that is no longer an ancestor of HEAD ───────────────────────

test("N4: branch rewritten onto a main that changed records after gate A's approval → gate B falls back to merge-base", async () => {
  const { dir, headSha } = featureRepo();
  const rewrite = `  - id: rewrite
    type: shell
    run: 'git checkout -q main && ${fileStepCmd("write", ".adlc/drafts/pdr/PDR-140.md", "# Main-only\n\n## Decision Outcome\n\nLives on main.\n")} && ${fileStepCmd("append", ".adlc/drafts/pdr/PDR-100.md", "Changed on main.\n")} && git add .adlc/drafts && git commit -q -m main2 && git checkout -q feature/x && git rebase -q main'
`;
  const steps = gateYaml({ id: "gate-a", verdict: "va" }) + rewrite + gateYaml({ id: "gate-b", verdict: "vb" });
  const { engine, state: s1 } = await runWorkflow(dir, steps, "g3n40001", { va: "", vb: "" }, ["va", "vb"]);
  assert.equal(s1.currentStepId, "gate-a");
  const s2 = await engine.resume("g3n40001", { va: "approve" }, STEP_REGISTRY);
  assert.equal(s2.stepResults["gate-a"].output.approved_sha, headSha);
  assert.equal(s2.stepResults.rewrite.status, StepStatus.COMPLETED, `fixture: rewrite ran: ${JSON.stringify(s2.stepResults.rewrite)}`);
  const main2 = git(dir, "rev-parse", "main");
  assert.equal(git(dir, "merge-base", "HEAD", "main"), main2, "fixture: feature/x rebased onto main2");
  assert.notEqual(git(dir, "merge-base", "HEAD", headSha), headSha, "fixture: gate A's approval sha is no longer an ancestor");

  assert.equal(s2.status, RunStatus.PAUSED);
  assert.equal(s2.currentStepId, "gate-b");
  const outB = s2.stepResults["gate-b"].output;
  assert.ok(!ids(outB.decisions).includes("PDR-140"), `main's new record must not be listed: ${outB.message}`);
  assert.ok(!ids(outB.decisions).includes("PDR-100"), `main's changed record must not be listed: ${outB.message}`);
  assert.equal(outB.since_sha, main2, "since falls back to the merge-base");
  assert.ok(outB.message.includes(`since merge-base @${short(main2)}`), outB.message);
});
