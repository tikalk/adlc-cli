// Supervised factory workflow: publish-spec + gate-spec packet (ADR-521 Amendment 1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus, validateWorkflow, headlessGateErrors } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SUPERVISED_YAML = readFileSync(
  join(ROOT, "workflows", "factory", "supervised", "workflow.yml"),
  "utf-8",
);

const POSIX = process.platform !== "win32";
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

function installFakeAgent() {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
if (process.env.FAKE_OUTPUT !== undefined && process.env.ADLC_STEP_OUTPUT) {
  fs.mkdirSync(require("node:path").dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
  fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, process.env.FAKE_OUTPUT);
}
console.log(JSON.stringify({ type: "text", text: "ok" }));
process.exit(Number(process.env.FAKE_EXIT || 0));
`);
  chmodSync(script, 0o755);
  return bin;
}

function project() {
  const dir = tempDir("supervised-proj-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  // Create origin/main ref so gate-context merge-base resolution has a target branch.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: dir });
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
  return dir;
}

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const RUN_BRANCH_CODE_HELPER = `#!/usr/bin/env bash
[ "\${1:-}" = "--kind" ] && [ "\${2:-}" = "code" ] || { echo "run-branch: expected --kind code, got $*" >&2; exit 8; }
git switch -q factory/mission/p-12 2>/dev/null || git switch -q -c factory/mission/p-12
echo factory/mission/p-12
`;

test("factory-supervised passes workflow + headless gate validation and wires gate-spec context", async () => {
  const engine = new WorkflowEngine(tempDir("supervised-val-"));
  const def = await engine.loadWorkflow(join(ROOT, "workflows", "factory", "supervised", "workflow.yml"));
  assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
  assert.deepEqual(headlessGateErrors(def), []);
  assert.deepEqual(def.steps.map((s) => s.id), ["plan", "publish-spec", "gate-spec", "execute"]);
  const gate = def.steps.find((s) => s.id === "gate-spec");
  assert.deepEqual(gate.context.records, [".adlc/drafts/adr/*.md", ".adlc/drafts/pdr/*.md"]);
  assert.equal(gate.context.since, "last_approved");
  assert.equal(gate.context.link, "{{ steps.publish-spec.output.mr_url | default(steps.plan.output.mr_url) }}");
});

test("publish-spec runs factory-runbook helpers with --kind code and links mr_url on gate-spec", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), RUN_BRANCH_CODE_HELPER);
  writeFileSync(join(helperDir, "open-mr.sh"), `#!/usr/bin/env bash
[ "\${1:-}" = "--kind" ] && [ "\${2:-}" = "code" ] || { echo "open-mr: expected --kind code, got $*" >&2; exit 8; }
[ -n "$ADLC_RUN_ID" ] && [ "$ADLC_STEP_ID" = "publish-spec" ] || exit 9
printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/88"}' > "$ADLC_STEP_OUTPUT"
echo https://gl.test/g/p/-/merge_requests/88
`);
  const wf = join(tempDir("sup-wf-"), "workflow.yml");
  writeFileSync(wf, SUPERVISED_YAML);

  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "0", FAKE_OUTPUT: undefined }, async () => {
    const engine = new WorkflowEngine(dir);
    const events = [];
    engine.onEvent = (e) => events.push(e);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup1", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    assert.equal(state.stepResults["publish-spec"].output.mr_url, "https://gl.test/g/p/-/merge_requests/88");
    const paused = events.find((e) => e.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/88");
  });
});

test("gate-spec falls back to steps.plan.output.mr_url and lists committed proposal records when helpers are skipped", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  // Simulate plan branch + committed proposal record on the mission branch.
  execFileSync("git", ["switch", "-q", "-c", "factory/mission/p-12"], { cwd: dir });
  mkdirSync(join(dir, ".adlc", "drafts", "adr"), { recursive: true });
  writeFileSync(
    join(dir, ".adlc", "drafts", "adr", "ADR-001.md"),
    "---\nstatus: proposed\ndate: 2026-11-18\napprovers: [Lior Kanfi]\nproposed-by: rsup2\nsource: \"plan.md\"\n---\n\n# ADR-001: Use SQLite cache\n\n## Decision Outcome\n\nChosen option: SQLite cache.\n",
  );
  execFileSync("git", ["add", ".adlc/drafts/adr/ADR-001.md"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs(adlc): factory-mission plan"], { cwd: dir });

  const wf = join(tempDir("sup-wf-"), "workflow.yml");
  writeFileSync(wf, SUPERVISED_YAML);

  await withEnv({
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_EXIT: "0",
    FAKE_OUTPUT: JSON.stringify({ mr_url: "https://gl.test/g/p/-/merge_requests/91" }),
  }, async () => {
    const engine = new WorkflowEngine(dir);
    const events = [];
    engine.onEvent = (e) => events.push(e);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup2", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    assert.match(state.stepResults["publish-spec"].output.skipped, /publish-spec: skipped/);
    const paused = events.find((e) => e.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/91");
    assert.match(paused.message, /ADR-001/);
    assert.match(paused.message, /status: proposed/);
  });
});

test("publish-spec fails closed when open-mr exits non-zero", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), RUN_BRANCH_CODE_HELPER);
  writeFileSync(join(helperDir, "open-mr.sh"), "#!/usr/bin/env bash\necho 'open-mr: tracker token lacks api scope' >&2\nexit 2\n");
  const wf = join(tempDir("sup-wf-"), "workflow.yml");
  writeFileSync(wf, SUPERVISED_YAML);

  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "0", FAKE_OUTPUT: undefined }, async () => {
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup3", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.match(state.stepResults["publish-spec"].error, /open-mr: tracker token lacks api scope/);
  });
});
