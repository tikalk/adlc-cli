// Agent-composed gate payloads (ADR-515; adlc-workspace#164).
//
//   P1 a valid runs/<run_id>/gate-payloads/<gate_id>.json renders into the
//      gate message under its first line, and is kept in the paused output.
//   P2 a gate that declares `payload: true` and finds no file says so
//      ("no agent payload"); it still pauses.
//   P3 a gate without `payload:` and without a file keeps its message as is.
//   P4 an invalid payload falls back to the note with the reason.
//   P5 the rendered payload is capped (lines and characters).
//   P6 agent steps get ADLC_GATE_PAYLOADS and ADLC_UPCOMING_GATES (gates
//      nested in an `if` count).
//   P7 an artifact with an unsafe URL is dropped; a safe one is linked.
//   P8 approving a payload gate resumes and completes as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkflowEngine, RunStatus } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";

const POSIX = process.platform !== "win32";
const temps = [];
const tempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
process.on("exit", () => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function project() {
  const dir = tempDir("gpay-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function workflow(gateExtra = "", before = "") {
  const path = join(tempDir("gpay-wf-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow: { id: gp-wf, name: GP, version: "1.0.0" }
inputs:
  verdict: { type: string, enum: ["", approve, reject] }
steps:
${before}  - id: gate-spec
    type: gate
    message: "Approve specification and plan before implementation?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
${gateExtra}  - id: after
    type: shell
    run: echo after
`);
  return path;
}

function writePayload(dir, runId, gateId, payload) {
  const d = join(dir, ".adlc", "workflows", "runs", runId, "gate-payloads");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${gateId}.json`), typeof payload === "string" ? payload : JSON.stringify(payload));
}

async function run(dir, wfPath, runId, inputs = {}) {
  const engine = new WorkflowEngine(dir);
  return engine.execute(await engine.loadWorkflow(wfPath), inputs, runId, STEP_REGISTRY);
}

const PLAN = {
  title: "Spec gate: #151 ask through the payload",
  summary: "factory-mission asks through ADLC_STEP_QUESTION instead of prose.",
  sections: [
    { heading: "Files", body: "skills/factory/factory-mission/SKILL.md\nfactory-runbook/references/executor.md" },
    { heading: "Tests", body: "RED fixture test first, then the text edits." },
  ],
  artifacts: [{ label: "Draft MR !12", url: "https://gitlab.example/g/p/-/merge_requests/12" }],
};

test("P1: a valid payload renders under the first line and is kept in the output", async () => {
  const dir = project();
  writePayload(dir, "rp1", "gate-spec", PLAN);
  const s = await run(dir, workflow(), "rp1");
  assert.equal(s.status, RunStatus.PAUSED);
  const out = s.stepResults["gate-spec"].output;
  const lines = out.message.split("\n");
  assert.equal(lines[0], "Approve specification and plan before implementation?", "first line stays the question");
  for (const want of [PLAN.title, PLAN.summary, "Files", "SKILL.md", "Tests", "Draft MR !12", "https://gitlab.example/g/p/-/merge_requests/12"]) {
    assert.ok(out.message.includes(want), `message has ${want}`);
  }
  assert.equal(out.gate_payload.summary, PLAN.summary);
});

test("P2: `payload: true` and no file shows the note and still pauses", async () => {
  const dir = project();
  const s = await run(dir, workflow("    payload: true\n"), "rp2");
  assert.equal(s.status, RunStatus.PAUSED);
  assert.match(s.stepResults["gate-spec"].output.message, /\(no agent payload\)/);
});

test("P3: a gate without `payload:` and without a file keeps its message", async () => {
  const dir = project();
  const s = await run(dir, workflow(), "rp3");
  assert.equal(s.stepResults["gate-spec"].output.message, "Approve specification and plan before implementation?");
  assert.equal("gate_payload" in s.stepResults["gate-spec"].output, false);
});

test("P4: an invalid payload falls back to the note with the reason", async () => {
  const dir = project();
  writePayload(dir, "rp4", "gate-spec", { title: "no summary here" });
  const s = await run(dir, workflow("    payload: true\n"), "rp4");
  assert.equal(s.status, RunStatus.PAUSED);
  assert.match(s.stepResults["gate-spec"].output.message, /\(no agent payload: missing summary\)/);
  writePayload(dir, "rp4b", "gate-spec", "{not json");
  const t = await run(dir, workflow(), "rp4b");
  assert.match(t.stepResults["gate-spec"].output.message, /\(no agent payload: not JSON\)/, "a present but broken file is never silent");
});

test("P5: the rendered payload is capped", async () => {
  const dir = project();
  const sections = Array.from({ length: 20 }, (_, i) => ({ heading: `H${i}`, body: "x".repeat(400) + "\nline\nline\nline" }));
  writePayload(dir, "rp5", "gate-spec", { summary: "big", sections });
  const s = await run(dir, workflow(), "rp5");
  const msg = s.stepResults["gate-spec"].output.message;
  const block = msg.slice(msg.indexOf("\n") + 1);
  assert.ok(block.length <= 2100, `block ${block.length} chars`);
  assert.ok(block.split("\n").length <= 32, `block ${block.split("\n").length} lines`);
  assert.match(msg, /…\(truncated\)/);
});

test("P6: agent steps get ADLC_GATE_PAYLOADS and ADLC_UPCOMING_GATES", { skip: !POSIX }, async () => {
  const bin = tempDir("gpay-bin-");
  const dump = join(tempDir("gpay-dump-"), "env.json");
  writeFileSync(join(bin, "opencode"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("ADLC_")))));
console.log(JSON.stringify({ type: "text", text: "ok" }));
`);
  chmodSync(join(bin, "opencode"), 0o755);
  const dir = project();
  const path = join(tempDir("gpay-wf6-"), "workflow.yml");
  writeFileSync(path, `schema_version: "1.0"
workflow: { id: gp6, name: GP6, version: "1.0.0", integration: opencode }
inputs:
  verdict: { type: string, enum: ["", approve, reject] }
  dispatch: { type: string, default: "supervised" }
steps:
  - id: plan
    type: command
    command: factory-mission
  - id: spec-approval
    type: if
    condition: "{{ inputs.dispatch != 'autonomous' }}"
    then:
      - id: gate-spec
        type: gate
        message: "Approve?"
        options: [approve, reject]
        on_reject: abort
        verdict_input: verdict
`);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try { await run(dir, path, "rp6"); } finally { process.env.PATH = old; }
  const env = JSON.parse(readFileSync(dump, "utf-8"));
  assert.equal(env.ADLC_GATE_PAYLOADS, join(dir, ".adlc", "workflows", "runs", "rp6", "gate-payloads"));
  assert.equal(env.ADLC_UPCOMING_GATES, "gate-spec");
});

test("P7: an unsafe artifact URL is dropped; a safe one is linked", async () => {
  const dir = project();
  writePayload(dir, "rp7", "gate-spec", { summary: "s", artifacts: [
    { label: "evil", url: "javascript:alert(1)" },
    { label: "MR", url: "https://gitlab.example/g/p/-/merge_requests/3" },
  ] });
  const s = await run(dir, workflow(), "rp7");
  const msg = s.stepResults["gate-spec"].output.message;
  assert.ok(!msg.includes("javascript:"), msg);
  assert.ok(!msg.includes("evil"), msg);
  assert.ok(msg.includes("https://gitlab.example/g/p/-/merge_requests/3"), msg);
});

test("P8: approving a payload gate resumes and completes", async () => {
  const dir = project();
  writePayload(dir, "rp8", "gate-spec", PLAN);
  const wf = workflow("    payload: true\n");
  const paused = await run(dir, wf, "rp8");
  assert.equal(paused.status, RunStatus.PAUSED);
  const engine = new WorkflowEngine(dir);
  const done = await engine.resume("rp8", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(done.status, RunStatus.COMPLETED);
});

test("P9: an unsafe run id or gate id reads no payload file", async () => {
  const { readGatePayload, gatePayloadsDir } = await import("../src/workflow/gate-payload.mjs");
  const dir = project();
  assert.equal(gatePayloadsDir(dir, "../etc"), null);
  assert.deepEqual(readGatePayload(dir, "../etc", "gate-spec"), { present: false, payload: null });
  assert.deepEqual(readGatePayload(dir, "r9", "../../x"), { present: false, payload: null });
});

test("P10: an approval covers only the payload that was shown (changed file re-pauses)", async () => {
  const dir = project();
  writePayload(dir, "rp10", "gate-spec", PLAN);
  const wf = workflow("    payload: true\n");
  const paused = await run(dir, wf, "rp10");
  assert.equal(paused.status, RunStatus.PAUSED);
  assert.match(paused.stepResults["gate-spec"].output.gate_payload_sha, /^[0-9a-f]{64}$/);
  // The file changes while the run waits: the approval was for the old plan.
  writePayload(dir, "rp10", "gate-spec", { ...PLAN, summary: "a different plan" });
  const engine = new WorkflowEngine(dir);
  const again = await engine.resume("rp10", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(again.status, RunStatus.PAUSED, "approval of different content must not pass");
  const out = again.stepResults["gate-spec"].output;
  assert.equal(out.payload_changed, true);
  assert.ok(out.message.includes("a different plan"), "re-pause shows the new content");
  // Approving what is shown now completes.
  const done = await new WorkflowEngine(dir).resume("rp10", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(done.status, RunStatus.COMPLETED);
});

test("P11: a rejection is honoured even when the payload changed", async () => {
  const dir = project();
  writePayload(dir, "rp11", "gate-spec", PLAN);
  await run(dir, workflow(), "rp11");
  writePayload(dir, "rp11", "gate-spec", { ...PLAN, summary: "changed" });
  const s = await new WorkflowEngine(dir).resume("rp11", { verdict: "reject" }, STEP_REGISTRY);
  assert.notEqual(s.status, RunStatus.PAUSED);
  assert.notEqual(s.status, RunStatus.COMPLETED);
});

test("P12: a context gate re-renders a changed payload instead of reusing the old message", async () => {
  const dir = project();
  writePayload(dir, "rp12", "gate-spec", PLAN);
  const ctx = "    context:\n      records: [\".adlc/drafts/adr/*.md\"]\n      since: last_approved\n";
  await run(dir, workflow(ctx), "rp12");
  writePayload(dir, "rp12", "gate-spec", { ...PLAN, summary: "context gate, new plan" });
  const s = await new WorkflowEngine(dir).resume("rp12", { verdict: "approve" }, STEP_REGISTRY);
  assert.equal(s.status, RunStatus.PAUSED);
  assert.ok(s.stepResults["gate-spec"].output.message.includes("context gate, new plan"));
});
