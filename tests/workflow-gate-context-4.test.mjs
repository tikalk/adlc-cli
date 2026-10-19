// Gate Decision Manifest — iteration 4 (factory-review self-heal on
// tikalk/adlc-cli#39, iteration 2: S1, S2, S3, S5). Builds on
// tests/workflow-gate-context{,-2,-3}.test.mjs.
//
// Contract pinned here:
//   S1  (refines R3) A context gate whose shown pause was "Decision list
//       unavailable" (head_sha null) and whose freshly built manifest at
//       resume is ALSO unavailable ACCEPTS a bound non-reject verdict: the gate
//       completes, no `approved_sha` is recorded, state.json
//       `last_approved_sha` is not set, and log.jsonl gets a `gate_approved`
//       entry with `without_list: true` and `decisions: []` (plus the
//       unavailable reason — field name not pinned). Shown unavailable + fresh
//       list available → re-pause with the fresh list. Shown list + fresh
//       unavailable → re-pause. A verdict preset at first execution (nothing
//       shown) still pauses. Covers non-git projects and repos whose only
//       branch is e.g. `develop`.
//   S2  decisions[].path gets the same Slack escaping as the record fields
//       (& < > → entities, @here broken); `link` stays percent-encoded.
//   S3  No record-derived field (id, title, decision_line, status) nor the
//       rendered message carries a markdown link: the `](` sequence never
//       survives.
//   S5  `context.link` (optional string, templated like `message`): a
//       non-empty absolute http(s) URL without whitespace/control chars/<>|
//       adds a final message line `Merge request: <url>` and an `mr_link`
//       field to the output and gate_paused / permission_request payloads;
//       any other value adds neither (never fails the gate). Validation
//       accepts `link` (string only). Builtin factory declares input `mr_url`
//       (default "") and gate-completion gets `link: "{{ inputs.mr_url }}"`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus, WorkflowDefinition, validateWorkflow, headlessGateErrors } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { StepStatus } from "../src/workflow/base.mjs";
import { buildGateManifest, renderGateMessage } from "../src/workflow/gate-context.mjs";

const PDR_GLOB = ".adlc/drafts/pdr/*.md";

// ── fixture helpers (same shape as workflow-gate-context-3) ───────────────

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

function initRepo(branch = "main", prefix = "gate-ctx4-repo-") {
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

// Only branch is `develop` (no main/master/origin): base commit, then PDR-7.
function developRepo() {
  const dir = initRepo("develop");
  write(dir, "README.md", "x\n");
  const baseSha = commitAll(dir, "base");
  write(dir, ".adlc/drafts/pdr/PDR-7.md", record({ title: "Develop decision", decision: "We decide on develop." }));
  const headSha = commitAll(dir, "pdr");
  return { dir, baseSha, headSha };
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
  const wfDir = tempDir("gate-ctx4-wf-");
  const path = join(wfDir, "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow:
  id: ctx-wf4
  name: Context Gate 4
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

const RECORD_FIELDS = ["id", "title", "decision_line", "status"];

// ── S1: an unavailable list must not deadlock ─────────────────────────────

// Pauses once with "Decision list unavailable", then ONE approve resume must
// complete the run without recording any approval sha.
async function assertUnavailableApproveCompletes(dir, runId) {
  const { engine, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, runId);
  assert.equal(s1.status, RunStatus.PAUSED);
  const out1 = s1.stepResults.review.output;
  assert.ok(out1.message.includes("Decision list unavailable"), out1.message);
  assert.equal(out1.head_sha, null, "fixture: unavailable manifest has head_sha null");

  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume(runId, { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.COMPLETED, "shown unavailable + fresh unavailable → approve completes the gate");
  assert.equal(s2.stepResults.review.status, StepStatus.COMPLETED);
  const out2 = s2.stepResults.review.output;
  assert.equal(out2.choice, "approve");
  assert.equal(out2.approved_sha, undefined, "no approved_sha without a list");
  assert.equal(s2.stepResults.fin?.status, StepStatus.COMPLETED, "the run continues past the gate");
  assert.ok(!events.some((e) => e.type === "gate_paused"), "no re-pause");
  assert.equal(persistedState(dir, runId).last_approved_sha, undefined, "last_approved_sha is not set");

  const audit = logEntries(dir, runId).filter((e) => e.event === "gate_approved");
  assert.equal(audit.length, 1, `one gate_approved audit entry: ${JSON.stringify(audit)}`);
  assert.equal(audit[0].step_id, "review");
  assert.equal(audit[0].without_list, true, JSON.stringify(audit[0]));
  assert.deepEqual(audit[0].decisions, []);
  assert.ok(!audit[0].approved_sha, `no approved_sha in the audit: ${JSON.stringify(audit[0])}`);
}

test("S1: non-git project — unavailable pause + ONE approve resume completes, no approval sha, audit without_list", async () => {
  const dir = tempDir("gate-ctx4-nogit-");
  write(dir, ".adlc/drafts/pdr/PDR-1.md", record({ title: "x", decision: "y." }));
  await assertUnavailableApproveCompletes(dir, "g4s10001");
});

test("S1: git repo whose only branch is `develop` — unavailable pause + approve completes without approval sha", async () => {
  const { dir } = developRepo();
  await assertUnavailableApproveCompletes(dir, "g4s10002");
});

test("S1: shown unavailable, list buildable by resume (main branch created) → re-pause with the fresh list (expected to pass now)", async () => {
  const { dir, baseSha, headSha } = developRepo();
  const { engine, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, "g4s10003");
  assert.equal(s1.stepResults.review.output.head_sha, null, "fixture: first pause is unavailable");

  git(dir, "branch", "main", baseSha);
  const events = [];
  engine.onEvent = (e) => events.push(e);
  const s2 = await engine.resume("g4s10003", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.PAUSED, "a list never shown must not be approved");
  assert.equal(s2.currentStepId, "review");
  const out2 = s2.stepResults.review.output;
  assert.equal(out2.approved_sha, undefined);
  assert.equal(out2.head_sha, headSha);
  assert.deepEqual(ids(out2.decisions), ["PDR-7"]);
  assert.equal(s2.inputs.verdict, "", "bound verdict cleared");
  assert.equal(s2.stepResults.fin, undefined);
  assert.ok(events.some((e) => e.type === "gate_paused" && e.step_id === "review"), "gate_paused re-emitted with the list");
  assert.ok(!logEntries(dir, "g4s10003").some((e) => e.event === "gate_approved"));
});

// Superseded 2026-10-19 by ADR-391-amendment-3 §4: HEAD moved since the
// shown list, so the approval halts (was: re-pause with "Decision list
// unavailable"). Re-pause remains only when git cannot report HEAD at all.
test("S1: shown a list, HEAD moved and fresh build unavailable at resume → halt, not approved blind", async () => {
  const { dir, headSha } = featureRepo();
  const { engine, state: s1 } = await runWorkflow(dir, gateYaml() + FIN, "g4s10004");
  assert.equal(s1.stepResults.review.output.head_sha, headSha, "fixture: first pause shows a list");
  assert.deepEqual(ids(s1.stepResults.review.output.decisions), ["PDR-127"]);

  // HEAD moves and no target branch is left → the fresh list is unavailable.
  write(dir, "src/other.js", "x\n");
  commitAll(dir, "more");
  git(dir, "branch", "-D", "main");
  const s2 = await engine.resume("g4s10004", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s2.status, RunStatus.FAILED);
  assert.match(s2.error, /head moved since the gate paused/);
  assert.equal(s2.stepResults.review.output.approved_sha, undefined);
  assert.equal(s2.stepResults.fin, undefined);
  assert.ok(!logEntries(dir, "g4s10004").some((e) => e.event === "gate_approved"));
});

test("S1 guard: verdict preset at first execution with an unavailable list still pauses (expected to pass now)", async () => {
  const dir = tempDir("gate-ctx4-nogit-");
  write(dir, ".adlc/drafts/pdr/PDR-1.md", record({ title: "x", decision: "y." }));
  const { state } = await runWorkflow(dir, gateYaml() + FIN, "g4s10005", { verdict: "approve" });
  assert.equal(state.status, RunStatus.PAUSED, "nothing was shown yet");
  assert.equal(state.inputs.verdict, "");
  assert.ok(!logEntries(dir, "g4s10005").some((e) => e.event === "gate_approved"));
});

// ── S2: decisions[].path is Slack-safe ────────────────────────────────────

test("S2: record file `PDR-<!channel> @here.md` → path escaped everywhere, link percent-encoded", { skip: process.platform === "win32" }, async () => {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/s2");
  const file = "PDR-<!channel> @here.md";
  write(dir, `.adlc/drafts/pdr/${file}`, record({ title: "Channel", decision: "Channel decision." }));
  commitAll(dir, "hostile filename");

  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.unavailable, null);
  assert.equal(m.decisions.length, 1);
  const [d] = m.decisions;
  assert.ok(!/[<>]/.test(d.path), `decisions[].path must not contain a raw < or >: ${JSON.stringify(d.path)}`);
  assert.ok(!d.path.includes("<!"), d.path);
  assert.ok(!/@(here|channel|everyone)\b/.test(d.path), `no live @here in path: ${JSON.stringify(d.path)}`);
  assert.equal(d.path, ".adlc/drafts/pdr/PDR-&lt;!channel&gt; @⁠here.md", "same escaping as other record fields");
  assert.equal(d.link, ".adlc/drafts/pdr/" + encodeURIComponent(file), "link stays percent-encoded");

  const { state, events } = await runWorkflow(dir, gateYaml(), "g4s20001");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults.review.output;
  const gp = events.find((e) => e.type === "gate_paused");
  const pr = events.find((e) => e.type === "permission_request");
  assert.ok(gp && pr, "gate_paused and permission_request emitted");
  for (const [name, decisions] of [["output", out.decisions], ["gate_paused", gp.decisions], ["permission_request", pr.decisions]]) {
    const text = JSON.stringify(decisions);
    assert.ok(!text.includes("<!"), `${name} decisions must not contain "<!": ${text}`);
    assert.ok(!text.includes("@here"), `${name} decisions must not contain a live @here: ${text}`);
    assert.equal(decisions[0].link, ".adlc/drafts/pdr/" + encodeURIComponent(file));
  }
});

// ── S3: markdown links neutralised in record fields ───────────────────────

function markdownRepo() {
  const dir = initRepo();
  write(dir, "README.md", "x\n");
  commitAll(dir, "base");
  git(dir, "checkout", "-q", "-b", "feature/s3");
  write(
    dir,
    ".adlc/drafts/pdr/PDR-5.md",
    record({
      id: "PDR-5 [id](https://evil.example/id)",
      status: "accepted [s](https://evil.example/s)",
      title: "Click [y](https://evil) now",
      decision: "We do [x](javascript:alert(1)) and ![img](https://evil.example/p.png) today. More.",
    }),
  );
  commitAll(dir, "markdown record");
  return dir;
}

test("S3: markdown links in record fields never survive as `](` in decisions[] or the message", () => {
  const dir = markdownRepo();
  const m = buildGateManifest({ records: [PDR_GLOB], projectRoot: dir });
  assert.equal(m.unavailable, null);
  assert.equal(m.decisions.length, 1);
  const [d] = m.decisions;
  const message = renderGateMessage("Approve PDRs?", m);
  for (const [name, text] of [["message", message], ...RECORD_FIELDS.map((f) => [`decisions[0].${f}`, d[f] ?? ""])]) {
    assert.ok(!text.includes("]("), `${name} must not contain a markdown link "](": ${JSON.stringify(text)}`);
  }
  // The text itself is still shown (neutralised, not dropped).
  assert.ok(d.title.includes("y") && d.title.includes("https://evil"), d.title);
  assert.ok(d.decision_line.includes("javascript:alert(1)"), d.decision_line);
});

test("S3: paused gate output and events carry no `](` from record fields", async () => {
  const dir = markdownRepo();
  const { state, events } = await runWorkflow(dir, gateYaml(), "g4s30001");
  assert.equal(state.status, RunStatus.PAUSED);
  const out = state.stepResults.review.output;
  const gp = events.find((e) => e.type === "gate_paused");
  const pr = events.find((e) => e.type === "permission_request");
  for (const [name, payload] of [["output", out], ["gate_paused", gp], ["permission_request", pr]]) {
    const text = JSON.stringify(payload.decisions) + payload.message;
    assert.ok(!text.includes("]("), `${name} must not contain "](": ${text}`);
  }
});

// ── S5: gate-completion merge-request link via context.link ───────────────

const LINK_CTX = `      link: "{{ inputs.mr_url }}"\n`;
const MR = "https://gitlab.example.com/group/repo/-/merge_requests/42";

async function runLinkGate(runId, mrUrl) {
  const { dir } = featureRepo();
  const inputs = mrUrl === undefined ? { verdict: "" } : { verdict: "", mr_url: mrUrl };
  return runWorkflow(dir, gateYaml({ extraContext: LINK_CTX }), runId, inputs, ["verdict", "mr_url"]);
}

test("S5: context.link set to an https URL → final `Merge request:` line and mr_link in output and events", async () => {
  const { state, events } = await runLinkGate("g4s50001", MR);
  assert.equal(state.status, RunStatus.PAUSED, `gate pauses: ${JSON.stringify(state.stepResults.review)}`);
  const out = state.stepResults.review.output;
  const lines = out.message.split("\n");
  assert.equal(lines[lines.length - 1], `Merge request: ${MR}`, out.message);
  assert.ok(out.message.includes("PDR-127"), "decision list still rendered before the link");
  assert.ok(out.message.indexOf("PDR-127") < out.message.indexOf("Merge request:"), out.message);
  assert.equal(out.mr_link, MR);
  for (const type of ["gate_paused", "permission_request"]) {
    const e = events.find((x) => x.type === type);
    assert.ok(e, type);
    assert.equal(e.mr_link, MR, `${type} carries mr_link`);
    assert.ok(e.message.includes(`Merge request: ${MR}`), `${type} message`);
  }
});

test("S5: http:// URL is accepted too", async () => {
  const url = "http://git.internal/repo/pull/7";
  const { state } = await runLinkGate("g4s50002", url);
  assert.equal(state.stepResults.review.output.mr_link, url);
  assert.ok(state.stepResults.review.output.message.endsWith(`Merge request: ${url}`));
});

for (const [name, value] of [
  ["unset input", undefined],
  ["empty input", ""],
  ["javascript: URL", "javascript:alert(1)"],
  ["Slack link syntax with |", "https://x|y"],
  ["angle-bracketed URL", "<https://x>"],
  ["relative path", "merge_requests/42"],
  ["URL with whitespace", "https://x.example/a b"],
  ["URL with a newline", "https://x.example/a\nInjected"],
]) {
  test(`S5: context.link ${name} → no Merge request line, no mr_link, gate still pauses normally`, async () => {
    const { state, events } = await runLinkGate(`g4s5x${Buffer.from(name).toString("hex").slice(0, 10)}`, value);
    assert.equal(state.status, RunStatus.PAUSED, JSON.stringify(state.stepResults.review));
    assert.equal(state.stepResults.review.status, StepStatus.PAUSED);
    const out = state.stepResults.review.output;
    assert.ok(!out.message.includes("Merge request"), out.message);
    assert.ok(!("mr_link" in out), `no mr_link: ${JSON.stringify(out.mr_link)}`);
    assert.ok(out.message.includes("PDR-127"), "manifest still rendered");
    assert.ok(!out.message.split("\n").some((l) => l.startsWith("Injected")), out.message);
    const gp = events.find((e) => e.type === "gate_paused");
    assert.ok(gp && !("mr_link" in gp), "gate_paused carries no mr_link");
  });
}

test("S5 guard: context gate without link has no Merge request line and no mr_link (expected to pass now)", async () => {
  const { dir } = featureRepo();
  const { state } = await runWorkflow(dir, gateYaml(), "g4s50003");
  const out = state.stepResults.review.output;
  assert.ok(!out.message.includes("Merge request"));
  assert.ok(!("mr_link" in out));
});

function defWithContext(contextYaml) {
  return WorkflowDefinition.fromString(`schema_version: "1.0"
workflow:
  id: ctx-validate4
  name: V
  version: "1.0.0"
inputs:
  verdict: {type: string}
  mr_url: {type: string, default: ""}
steps:
  - id: g
    type: gate
    message: "ok?"
    options: [approve, reject]
    verdict_input: verdict
${contextYaml}
`);
}

test("S5: validate accepts context.link as a string (literal or templated)", () => {
  for (const link of [`"{{ inputs.mr_url }}"`, `"https://example.com/mr/1"`, `""`]) {
    const errors = validateWorkflow(defWithContext(`    context:
      records: ["${PDR_GLOB}"]
      since: last_approved
      link: ${link}`), STEP_REGISTRY);
    assert.deepEqual(errors, [], `link ${link}`);
  }
});

for (const [name, value] of [["number", "3"], ["list", "[a, b]"], ["mapping", "{a: 1}"], ["boolean", "true"]]) {
  test(`S5: validate rejects a non-string context.link (${name}) (expected to pass now: unknown key today)`, () => {
    const errors = validateWorkflow(defWithContext(`    context:
      records: ["${PDR_GLOB}"]
      link: ${value}`), STEP_REGISTRY);
    assert.ok(errors.some((e) => e.includes("context") && e.includes("link")), JSON.stringify(errors));
  });
}

test("S5: builtin factory declares optional input mr_url and gate-completion context.link", () => {
  const engine = new WorkflowEngine(tempDir("gate-ctx4-builtin-"));
  const def = engine.loadWorkflow("factory");
  const inputs = def.data.inputs ?? {};
  assert.ok(inputs.mr_url, `factory declares input mr_url: ${JSON.stringify(inputs)}`);
  assert.equal(inputs.mr_url.default, "", "mr_url defaults to empty");
  assert.notEqual(inputs.mr_url.required, true);
  const completion = def.steps.find((s) => s.id === "gate-completion");
  assert.equal(completion.context.link, "{{ inputs.mr_url }}");
  for (const id of ["gate-product", "gate-architecture"]) {
    const g = def.steps.find((s) => s.id === id);
    assert.ok(!("link" in g.context), `${id} has no link`);
  }
  assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
  assert.deepEqual(headlessGateErrors(def), []);
});
