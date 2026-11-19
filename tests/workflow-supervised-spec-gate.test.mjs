// Supervised factory workflow: run-branch + publish-spec + gate-spec + run-branch-execute (ADR-521 Amendment 1, ADR-431-amendment).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WorkflowEngine, RunStatus, validateWorkflow, headlessGateErrors } from "../src/workflow/engine.mjs";
import { restoreRun } from "../src/workflow/refs.mjs";
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

function installFakeAgent(extraJs = "") {
  const bin = tempDir("fake-agent-bin-");
  const script = join(bin, "opencode");
  writeFileSync(script, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
${extraJs}
if (process.env.FAKE_OUTPUT !== undefined && process.env.ADLC_STEP_OUTPUT) {
  fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
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
  // Create origin/main ref so gate-context merge-base resolution has target branch.
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: dir });
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
  return dir;
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

// Mirrors factory-runbook/scripts/bash/run-branch.sh --kind code behavior
// including origin fetch + single-branch clone checkout without --track.
const REAL_EQUIVALENT_RUN_BRANCH_SH = `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "--kind" ] && [ "\${2:-}" = "code" ] || { echo "run-branch: expected --kind code, got $*" >&2; exit 8; }
[ -n "\${ADLC_RUN_ID:-}" ] || exit 0
if [ -n "\${ADLC_ISSUE_REF:-}" ]; then
  [[ "$ADLC_ISSUE_REF" =~ ^(([A-Za-z0-9_][A-Za-z0-9._-]*/)+([A-Za-z0-9_][A-Za-z0-9._-]*))#([0-9]+)$ ]] || { echo "invalid ADLC_ISSUE_REF" >&2; exit 2; }
  branch="factory/mission/\${BASH_REMATCH[3]}-\${BASH_REMATCH[4]}"
else
  branch="factory/mission/run-\${ADLC_RUN_ID}"
fi
on_origin=0
if git remote get-url origin >/dev/null 2>&1 && git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch -q origin "+refs/heads/$branch:refs/remotes/origin/$branch"
  on_origin=1
fi
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git switch -q "$branch"
  [ "$on_origin" = 0 ] || git merge -q --ff-only "origin/$branch"
elif [ "$on_origin" = 1 ]; then
  git switch -q -c "$branch" "refs/remotes/origin/$branch"
else
  git switch -q -c "$branch"
fi
echo "$branch"
`;

test("factory-supervised passes workflow + headless gate validation and wires gate-spec context", async () => {
  const engine = new WorkflowEngine(tempDir("supervised-val-"));
  const def = await engine.loadWorkflow(join(ROOT, "workflows", "factory", "supervised", "workflow.yml"));
  assert.deepEqual(validateWorkflow(def, STEP_REGISTRY), []);
  assert.deepEqual(headlessGateErrors(def), []);
  assert.deepEqual(def.steps.map((s) => s.id), [
    "run-branch",
    "plan",
    "publish-spec",
    "gate-spec",
    "run-branch-execute",
    "execute",
  ]);
  const gate = def.steps.find((s) => s.id === "gate-spec");
  assert.equal(
    gate.message,
    "Approve specification and plan before implementation? (If status: proposed ADR/PDR drafts are listed, reject this gate, promote them to docs/adlc/memory/ via /architect-clarify + /architect-implement or /product-clarify + /product-implement, and re-run factory-supervised.)",
  );
  assert.deepEqual(gate.context.records, [".adlc/drafts/adr/*.md", ".adlc/drafts/pdr/*.md"]);
  assert.equal(gate.context.since, "last_approved");
  assert.equal(gate.context.link, "{{ steps.publish-spec.output.mr_url | default(steps.plan.output.mr_url) }}");
});

test("publish-spec runs factory-runbook helpers with --kind code and links mr_url on gate-spec", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
  writeFileSync(join(helperDir, "open-mr.sh"), `#!/usr/bin/env bash
[ "\${1:-}" = "--kind" ] && [ "\${2:-}" = "code" ] || { echo "open-mr: expected --kind code, got $*" >&2; exit 8; }
[ -n "$ADLC_RUN_ID" ] && [ "$ADLC_STEP_ID" = "publish-spec" ] || exit 9
[ "$(git rev-parse --abbrev-ref HEAD)" = "factory/mission/p-12" ] || exit 10
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
    assert.equal(state.stepResults["run-branch"].status, "completed");
    assert.equal(state.stepResults["publish-spec"].output.mr_url, "https://gl.test/g/p/-/merge_requests/88");
    const paused = events.find((e) => e.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/88");
  });
});

test("run-branch switches off main before plan commits proposals, and gate-spec falls back to steps.plan.output.mr_url when open-mr is skipped", { skip: !POSIX }, async () => {
  // Fake plan agent asserts run-branch already switched from main to factory/mission/p-12,
  // then commits ADR-001.md on HEAD without touching git switch itself.
  const bin = installFakeAgent(`
if (process.env.ADLC_STEP_ID === "plan") {
  const cur = cp.execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
  if (cur !== "factory/mission/p-12") {
    console.error("expected plan to start on factory/mission/p-12, got " + cur);
    process.exit(12);
  }
  fs.mkdirSync(".adlc/drafts/adr", { recursive: true });
  fs.writeFileSync(
    ".adlc/drafts/adr/ADR-001.md",
    "---\\nstatus: proposed\\ndate: 2026-11-18\\napprovers: [Lior Kanfi]\\nproposed-by: rsup2\\nsource: \\"plan.md\\"\\n---\\n\\n# ADR-001: Use SQLite cache\\n\\n## Decision Outcome\\n\\nChosen option: SQLite cache.\\n"
  );
  cp.execFileSync("git", ["add", ".adlc/drafts/adr/ADR-001.md"]);
  cp.execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs(adlc): factory-mission plan"]);
}
`);
  const dir = project();
  const baseSha = execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: dir, encoding: "utf-8" }).trim();
  // Install run-branch.sh only; omit open-mr.sh so publish-spec skips open-mr.sh and gate-spec falls back to steps.plan.output.mr_url.
  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);

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
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: dir, encoding: "utf-8" }).trim(), baseSha);
    assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim(), "factory/mission/p-12");
    assert.match(state.stepResults["publish-spec"].output.skipped, /publish-spec: skipped open-mr\.sh/);
    const paused = events.find((e) => e.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/91");
    assert.match(paused.message, /ADR-001/);
    assert.match(paused.message, /status: proposed/);
  });
});

test("all three helper steps skip cleanly when no factory-runbook or factory-mission helpers are installed", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const wf = join(tempDir("sup-wf-"), "workflow.yml");
  writeFileSync(wf, SUPERVISED_YAML);

  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "0", FAKE_OUTPUT: undefined }, async () => {
    const engine = new WorkflowEngine(dir);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-nohelpers", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    assert.match(state.stepResults["run-branch"].output.skipped, /run-branch: skipped run-branch\.sh \(factory-runbook helpers not installed\)/);
    assert.match(state.stepResults["publish-spec"].output.skipped, /publish-spec: skipped run-branch\.sh, open-mr\.sh \(factory-runbook helpers not installed\)/);

    const resumed = await new WorkflowEngine(dir).resume("rsup-nohelpers", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.match(resumed.stepResults["run-branch-execute"].output.skipped, /run-branch-execute: skipped run-branch\.sh \(factory-runbook helpers not installed\)/);
  });
});

test("re-dispatch on fresh single-branch main clone switches onto existing origin/factory/mission/p-12 (R1) before plan commits R2", { skip: !POSIX }, async () => {
  // Set up a bare origin with main at M0 and factory/mission/p-12 already at R1.
  const remote = tempDir("sup-remote-");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);

  const seed = tempDir("sup-seed-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: seed });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base M0"], { cwd: seed });
  const m0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf-8" }).trim();
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: seed });

  execFileSync("git", ["switch", "-q", "-c", "factory/mission/p-12"], { cwd: seed });
  mkdirSync(join(seed, ".adlc", "drafts", "adr"), { recursive: true });
  writeFileSync(
    join(seed, ".adlc", "drafts", "adr", "ADR-001.md"),
    "---\nstatus: proposed\ndate: 2026-11-18\napprovers: [Lior Kanfi]\nproposed-by: rsup-r1\nsource: \"plan.md\"\n---\n\n# ADR-001: First bounce proposal\n\n## Decision Outcome\n\nChosen option: R1.\n",
  );
  execFileSync("git", ["add", ".adlc/drafts/adr/ADR-001.md"], { cwd: seed });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs(adlc): R1 proposal"], { cwd: seed });
  const r1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf-8" }).trim();
  execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/factory/mission/p-12"], { cwd: seed });

  // Fresh single-branch main clone (matches production runner clone).
  const cloneDir = join(tempDir("sup-clone-wrap-"), "repo");
  execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", remote, cloneDir]);
  mkdirSync(join(cloneDir, ".adlc"), { recursive: true });
  writeFileSync(join(cloneDir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));

  const helperDir = join(cloneDir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
  writeFileSync(join(helperDir, "open-mr.sh"), `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "--kind" ] && [ "\${2:-}" = "code" ] || exit 8
b="$(git rev-parse --abbrev-ref HEAD)"
[ "$b" = "factory/mission/p-12" ] || { echo "open-mr: expected factory/mission/p-12, got $b" >&2; exit 2; }
git push -q origin "HEAD:refs/heads/$b"
printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/96"}' > "$ADLC_STEP_OUTPUT"
`);

  // Fake plan agent verifies run-branch checked out R1 on factory/mission/p-12 BEFORE plan runs,
  // then commits a new proposal PDR-002.md (R2).
  const bin = installFakeAgent(`
if (process.env.ADLC_STEP_ID === "plan") {
  const curBranch = cp.execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
  const curSha = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  if (curBranch !== "factory/mission/p-12" || curSha !== ${JSON.stringify(r1)}) {
    console.error("expected plan on factory/mission/p-12 @ R1, got " + curBranch + " @ " + curSha);
    process.exit(14);
  }
  fs.mkdirSync(".adlc/drafts/pdr", { recursive: true });
  fs.writeFileSync(
    ".adlc/drafts/pdr/PDR-002.md",
    "---\\nstatus: proposed\\ndate: 2026-11-19\\napprovers: [Lior Kanfi]\\nproposed-by: rsup-r2\\nsource: \\"spec.md\\"\\n---\\n\\n# PDR-002: Second bounce proposal\\n\\n## Summary\\n\\nBounce R2.\\n"
  );
  cp.execFileSync("git", ["add", ".adlc/drafts/pdr/PDR-002.md"]);
  cp.execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs(adlc): R2 proposal"]);
}
`);

  const wf = join(tempDir("sup-wf-"), "workflow.yml");
  writeFileSync(wf, SUPERVISED_YAML);

  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FAKE_EXIT: "0", FAKE_OUTPUT: undefined }, async () => {
    const engine = new WorkflowEngine(cloneDir);
    const events = [];
    engine.onEvent = (e) => events.push(e);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-bounce", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);

    const r2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneDir, encoding: "utf-8" }).trim();
    assert.notEqual(r2, r1);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: cloneDir, encoding: "utf-8" }).trim(), r1);
    // Local main stays untouched at M0.
    assert.equal(execFileSync("git", ["rev-parse", "refs/heads/main"], { cwd: cloneDir, encoding: "utf-8" }).trim(), m0);
    // publish-spec pushed R2 to origin/factory/mission/p-12.
    assert.equal(
      execFileSync("git", ["rev-parse", "refs/heads/factory/mission/p-12"], { cwd: remote, encoding: "utf-8" }).trim(),
      r2,
    );

    const paused = events.find((e) => e.type === "gate_paused");
    assert.equal(paused.mr_link, "https://gl.test/g/p/-/merge_requests/96");
    assert.match(paused.message, /ADR-001/);
    assert.match(paused.message, /PDR-002/);
  });
});

test("post-gate-spec resume into a fresh single-branch main clone switches to factory/mission/p-12 via run-branch-execute before execute", { skip: !POSIX }, async () => {
  const remote = tempDir("sup-resume-remote-");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);

  const firstClone = tempDir("sup-first-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: firstClone });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: firstClone });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base M0"], { cwd: firstClone });
  const m0 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: firstClone, encoding: "utf-8" }).trim();
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: firstClone });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", m0], { cwd: firstClone });
  mkdirSync(join(firstClone, ".adlc"), { recursive: true });
  writeFileSync(join(firstClone, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));

  const helperDir1 = join(firstClone, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir1, { recursive: true });
  writeFileSync(join(helperDir1, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
  writeFileSync(join(helperDir1, "open-mr.sh"), `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = "--kind" ] && [ "\${2:-}" = "code" ] || exit 8
git push -q origin "HEAD:refs/heads/factory/mission/p-12"
printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/97"}' > "$ADLC_STEP_OUTPUT"
`);

  const seenExecuteFile = join(tempDir("sup-exec-seen-"), "seen.json");
  // Clean-PASS plan: zero committed proposals (head_sha === m0), open-mr pushes factory/mission/p-12 at m0.
  // When restored into a fresh single-branch clone on main (HEAD === m0), gate-spec's SHA check passes on main,
  // and run-branch-execute must switch from main to factory/mission/p-12 before execute runs.
  const bin = installFakeAgent(`
if (process.env.ADLC_STEP_ID === "execute" && process.env.FAKE_EXEC_SEEN) {
  const branch = cp.execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
  const sha = cp.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  fs.writeFileSync(process.env.FAKE_EXEC_SEEN, JSON.stringify({ branch, sha }));
}
`);

  await withEnv({
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_EXIT: "0",
    FAKE_OUTPUT: undefined,
    FAKE_EXEC_SEEN: seenExecuteFile,
  }, async () => {
    const e1 = new WorkflowEngine(firstClone);
    const pausedState = await e1.execute(
      await e1.loadWorkflow("factory-supervised"),
      { issue_ref: "g/p#12", verdict: "" },
      "rsup-restore",
      STEP_REGISTRY,
    );
    assert.equal(pausedState.status, RunStatus.PAUSED);

    // Simulate pod restore into a brand-new single-branch clone on main using real restoreRun().
    const freshClone = join(tempDir("sup-restored-wrap-"), "repo");
    execFileSync("git", ["clone", "-q", "--branch", "main", "--single-branch", remote, freshClone]);
    assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: freshClone, encoding: "utf-8" }).trim(), "main");
    mkdirSync(join(freshClone, ".adlc"), { recursive: true });
    writeFileSync(join(freshClone, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));
    restoreRun(freshClone, "rsup-restore", { issueRef: "g/p#12" });

    // Install run-branch.sh in the fallback directory (.agents/skills/factory-mission/scripts/bash) to exercise fallback resolution too.
    const fallbackHelperDir = join(freshClone, ".agents", "skills", "factory-mission", "scripts", "bash");
    mkdirSync(fallbackHelperDir, { recursive: true });
    writeFileSync(join(fallbackHelperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);

    const resumed = await new WorkflowEngine(freshClone).resume("rsup-restore", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.equal(resumed.stepResults["run-branch-execute"].status, "completed");
    const ids = Object.keys(resumed.stepResults);
    assert.ok(ids.indexOf("run-branch-execute") < ids.indexOf("execute"));

    const seen = JSON.parse(readFileSync(seenExecuteFile, "utf-8"));
    assert.equal(seen.branch, "factory/mission/p-12");
    assert.equal(seen.sha, m0);
    assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: freshClone, encoding: "utf-8" }).trim(), "factory/mission/p-12");
  });
});

test("publish-spec fails closed when open-mr exits non-zero", { skip: !POSIX }, async () => {
  const bin = installFakeAgent();
  const dir = project();
  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
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

test("helper steps fail closed on spawnSync runtime error (r.error) instead of skipping as helpers not installed", { skip: !POSIX }, async () => {
  // Create a minimal PATH containing node + opencode, but NO bash — so node runs
  // while cp.spawnSync('bash', ...) fails with r.error (ENOENT).
  const noBashBin = installFakeAgent(`
if (process.env.ADLC_STEP_ID === "plan" && process.env.CREATE_OPEN_MR_IN_PLAN === "1") {
  fs.mkdirSync(".agents/skills/factory-runbook/scripts/bash", { recursive: true });
  fs.writeFileSync(".agents/skills/factory-runbook/scripts/bash/open-mr.sh", "#!/usr/bin/env bash\\nexit 0\\n");
}
`);
  symlinkSync(process.execPath, join(noBashBin, "node"));

  // Case 1: run-branch.sh exists -> run-branch fails closed on spawnSync bash ENOENT.
  const dir1 = project();
  const helperDir1 = join(dir1, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir1, { recursive: true });
  writeFileSync(join(helperDir1, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
  const wf = join(tempDir("sup-wf-"), "workflow.yml");
  writeFileSync(wf, SUPERVISED_YAML);

  await withEnv({ PATH: noBashBin, FAKE_EXIT: "0", FAKE_OUTPUT: undefined }, async () => {
    const engine = new WorkflowEngine(dir1);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-err1", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(state.stepResults["run-branch"].status, "failed");
    assert.match(state.stepResults["run-branch"].error, /run-branch: failed to spawn run-branch\.sh:.*ENOENT/);
    assert.equal(state.stepResults["run-branch"].output?.skipped, undefined);
  });

  // Case 2: run-branch.sh absent (skipped cleanly), open-mr.sh created during plan -> publish-spec fails closed on spawnSync bash ENOENT.
  const dir2 = project();
  await withEnv({
    PATH: noBashBin,
    FAKE_EXIT: "0",
    FAKE_OUTPUT: undefined,
    CREATE_OPEN_MR_IN_PLAN: "1",
  }, async () => {
    const engine = new WorkflowEngine(dir2);
    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-err2", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.FAILED);
    assert.equal(state.stepResults["run-branch"].status, "completed");
    assert.equal(state.stepResults["publish-spec"].status, "failed");
    assert.match(state.stepResults["publish-spec"].error, /publish-spec: failed to spawn open-mr\.sh:.*ENOENT/);
    assert.equal(state.stepResults["publish-spec"].output?.skipped, undefined);
  });
});

test("factory-supervised: 0-proposal PASS triggers open-mr.sh rev-list empty-branch guard, omits mr_link, and approves cleanly to execute", { skip: !POSIX }, async () => {
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  const remote = tempDir("sup-empty-remote-");
  git(remote, ["init", "-q", "--bare", "-b", "main"]);

  const dir = tempDir("sup-empty-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@e"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# p\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "init"]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-qu", "origin", "main"]);

  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));

  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
  chmodSync(join(helperDir, "run-branch.sh"), 0o755);

  const openMrWithRevListGuard = `#!/usr/bin/env bash
set -euo pipefail
[ "$(git rev-list --count "refs/remotes/origin/main..HEAD")" = 0 ] && exit 0
git push -q origin HEAD:refs/heads/factory/mission/p-12
if [ -n "\${ADLC_STEP_OUTPUT:-}" ]; then
  printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/88"}' > "$ADLC_STEP_OUTPUT"
fi
`;
  writeFileSync(join(helperDir, "open-mr.sh"), openMrWithRevListGuard);
  chmodSync(join(helperDir, "open-mr.sh"), 0o755);

  const bin = installFakeAgent(`
const cur = cp.execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
if (cur !== "factory/mission/p-12") {
  console.error("expected factory/mission/p-12, got " + cur);
  process.exit(1);
}
if (process.env.ADLC_STEP_OUTPUT) {
  fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
  if (process.argv.join(" ").includes("--plan")) {
    fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, JSON.stringify({ conclusion: "plan-ready" }));
  } else {
    fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, JSON.stringify({ conclusion: "done" }));
  }
}
`);
  const wf = join(ROOT, "workflows", "factory", "supervised", "workflow.yml");

  await withEnv({
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_EXIT: "0",
    FAKE_OUTPUT: undefined,
  }, async () => {
    const engine = new WorkflowEngine(dir);
    const events = [];
    engine.onEvent = (e) => events.push(e);

    const state = await engine.execute(await engine.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-empty", STEP_REGISTRY);
    assert.equal(state.status, RunStatus.PAUSED);
    assert.equal(state.currentStepId, "gate-spec");
    assert.equal(state.stepResults["run-branch"].status, "completed");
    assert.equal(state.stepResults.plan.status, "completed");
    assert.equal(state.stepResults.plan.output.conclusion, "plan-ready");
    assert.equal(state.stepResults["publish-spec"].status, "completed");
    assert.equal(state.stepResults["publish-spec"].output.mr_url, undefined);

    const paused = events.find((e) => e.type === "gate_paused");
    assert.ok(paused, "gate_paused must emit");
    assert.equal("mr_link" in paused, false);
    assert.equal(paused.mr_link, undefined);
    assert.equal(paused.no_changes, true);
    assert.deepEqual(paused.decisions, []);
    assert.ok(!paused.message.includes("Merge request:"));
    assert.ok(!paused.message.includes("· status: proposed"));
    assert.match(paused.message, /No new or changed decisions since run start @/);

    const resumed = await engine.resume("rsup-empty", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(resumed.status, RunStatus.COMPLETED);
    assert.equal(resumed.stepResults["run-branch-execute"].status, "completed");
    assert.equal(resumed.stepResults["execute"].status, "completed");
    assert.equal(resumed.stepResults["execute"].output.conclusion, "done");
  });
});

test("factory-supervised: DECISION_RECORDS_CAPTURE_NEEDED reject -> promote to docs/adlc/memory/ -> re-run -> approve -> execute", { skip: !POSIX }, async () => {
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  const remote = tempDir("sup-prop-remote-");
  git(remote, ["init", "-q", "--bare", "-b", "main"]);

  const dir = tempDir("sup-prop-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@e"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# p\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-qm", "init"]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-qu", "origin", "main"]);

  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({ agent: "opencode" }));

  const helperDir = join(dir, ".agents", "skills", "factory-runbook", "scripts", "bash");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "run-branch.sh"), REAL_EQUIVALENT_RUN_BRANCH_SH);
  chmodSync(join(helperDir, "run-branch.sh"), 0o755);

  const openMrWithRevListGuard = `#!/usr/bin/env bash
set -euo pipefail
[ "$(git rev-list --count "refs/remotes/origin/main..HEAD")" = 0 ] && exit 0
git push -q origin HEAD:refs/heads/factory/mission/p-12
if [ -n "\${ADLC_STEP_OUTPUT:-}" ]; then
  printf '{"mr_url":"https://gl.test/g/p/-/merge_requests/99"}' > "$ADLC_STEP_OUTPUT"
fi
`;
  writeFileSync(join(helperDir, "open-mr.sh"), openMrWithRevListGuard);
  chmodSync(join(helperDir, "open-mr.sh"), 0o755);

  const bin = installFakeAgent(`
const cur = cp.execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
if (cur !== "factory/mission/p-12") {
  console.error("expected factory/mission/p-12, got " + cur);
  process.exit(1);
}
const adrIndexPath = "docs/adlc/memory/adr/adr.md";
const hasAcceptedAdr = fs.existsSync(adrIndexPath) && fs.readFileSync(adrIndexPath, "utf-8").includes("ADR-001");
if (process.argv.join(" ").includes("--plan")) {
  if (!hasAcceptedAdr) {
    fs.mkdirSync(".adlc/drafts/adr", { recursive: true });
    fs.writeFileSync(".adlc/drafts/adr/ADR-001.md", "---\\nid: ADR-001\\ntitle: Spec Gate Proposal\\nstatus: proposed\\n---\\n\\n## Decision Outcome\\n\\nCapture spec gate proposal.\\n");
    cp.execFileSync("git", ["add", ".adlc/drafts/adr/ADR-001.md"]);
    cp.execFileSync("git", ["commit", "-qm", "docs(adr): propose ADR-001"]);
    if (process.env.ADLC_STEP_OUTPUT) {
      fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
      fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, JSON.stringify({ conclusion: "plan-ready: decision-records-proposed" }));
    }
  } else if (process.env.ADLC_STEP_OUTPUT) {
    fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
    fs.writeFileSync(process.env.ADLC_STEP_OUTPUT, JSON.stringify({ conclusion: "plan-ready" }));
  }
} else {
  if (!hasAcceptedAdr) {
    console.error("blocked: decision-records (ADR-001 missing from docs/adlc/memory/adr/adr.md)");
    process.exit(1);
  }
  if (process.env.ADLC_STEP_OUTPUT) {
    fs.mkdirSync(path.dirname(process.env.ADLC_STEP_OUTPUT), { recursive: true });
    fs.writeFileSync(
      process.env.ADLC_STEP_OUTPUT,
      JSON.stringify({ conclusion: "done", mr_url: "https://gl.test/g/p/-/merge_requests/99" }),
    );
  }
}
`);
  const wf = join(ROOT, "workflows", "factory", "supervised", "workflow.yml");

  await withEnv({
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_EXIT: "0",
    FAKE_OUTPUT: undefined,
  }, async () => {
    // Run 1 (rsup-prop-1): plan commits status: proposed ADR-001 -> gate-spec pauses -> operator rejects -> ABORTED.
    const engine1 = new WorkflowEngine(dir);
    const events1 = [];
    engine1.onEvent = (e) => events1.push(e);

    const state1 = await engine1.execute(await engine1.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-prop-1", STEP_REGISTRY);
    assert.equal(state1.status, RunStatus.PAUSED);
    assert.equal(state1.currentStepId, "gate-spec");
    assert.equal(state1.stepResults.plan.output.conclusion, "plan-ready: decision-records-proposed");
    assert.equal(state1.stepResults["publish-spec"].output.mr_url, "https://gl.test/g/p/-/merge_requests/99");

    const paused1 = events1.find((e) => e.type === "gate_paused");
    assert.ok(paused1, "gate_paused must emit on Run 1");
    assert.equal(paused1.mr_link, "https://gl.test/g/p/-/merge_requests/99");
    assert.equal(paused1.decisions.length, 1);
    assert.equal(paused1.decisions[0].id, "ADR-001");
    assert.equal(paused1.decisions[0].status, "proposed");
    assert.match(paused1.message, /ADR-001/);
    assert.match(paused1.message, /· status: proposed/);
    assert.match(paused1.message, /Merge request: https:\/\/gl\.test\/g\/p\/-\/merge_requests\/99/);

    const resumed1 = await engine1.resume("rsup-prop-1", { verdict: "reject" }, STEP_REGISTRY);
    assert.equal(resumed1.status, RunStatus.ABORTED);
    assert.equal(resumed1.stepResults["gate-spec"].output.aborted, true);
    assert.equal(resumed1.stepResults["execute"], undefined);

    // Promotion (/architect-clarify + /architect-implement) on factory/mission/p-12 pushed to origin.
    git(dir, ["rm", "-q", ".adlc/drafts/adr/ADR-001.md"]);
    mkdirSync(join(dir, "docs", "adlc", "memory", "adr"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "adlc", "memory", "adr", "ADR-001.md"),
      "---\nid: ADR-001\ntitle: Spec Gate Proposal\nstatus: accepted\n---\n\n## Decision Outcome\n\nCapture spec gate proposal.\n",
    );
    writeFileSync(
      join(dir, "docs", "adlc", "memory", "adr", "adr.md"),
      "# Architecture Decision Records\n\n| ID | Sub-System | Decision | Status |\n|---|---|---|---|\n| ADR-001 | factory | Spec Gate Proposal | accepted |\n",
    );
    git(dir, ["add", "docs/adlc/memory/adr/ADR-001.md", "docs/adlc/memory/adr/adr.md"]);
    git(dir, ["commit", "-qm", "docs(adr): promote ADR-001 to accepted memory"]);
    const promotedSha = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["push", "-q", "origin", "HEAD:refs/heads/factory/mission/p-12"]);
    // Switch back to main so Run 2's run-branch step proves it checks out factory/mission/p-12 at promotedSha.
    git(dir, ["switch", "-q", "main"]);

    // Run 2 (rsup-prop-2): re-run factory-supervised -> plan sees ADR-001 in memory -> gate-spec binds to promotedSha -> approve -> execute COMPLETED.
    const engine2 = new WorkflowEngine(dir);
    const events2 = [];
    engine2.onEvent = (e) => events2.push(e);

    const state2 = await engine2.execute(await engine2.loadWorkflow(wf), { issue_ref: "g/p#12", verdict: "" }, "rsup-prop-2", STEP_REGISTRY);
    assert.equal(state2.status, RunStatus.PAUSED);
    assert.equal(state2.currentStepId, "gate-spec");
    assert.equal(git(dir, ["rev-parse", "HEAD"]), promotedSha);
    assert.equal(state2.stepResults.plan.output.conclusion, "plan-ready");
    assert.equal(state2.stepResults["publish-spec"].output.mr_url, "https://gl.test/g/p/-/merge_requests/99");

    const paused2 = events2.find((e) => e.type === "gate_paused");
    assert.ok(paused2, "gate_paused must emit on Run 2");
    assert.equal(paused2.head_sha, promotedSha);
    assert.equal(paused2.mr_link, "https://gl.test/g/p/-/merge_requests/99");
    assert.equal(paused2.no_changes, true);
    assert.deepEqual(paused2.decisions, []);
    assert.ok(!paused2.message.includes("· status: proposed"));
    assert.match(paused2.message, /No new or changed decisions since merge-base @/);

    const resumed2 = await engine2.resume("rsup-prop-2", { verdict: "approve" }, STEP_REGISTRY);
    assert.equal(resumed2.status, RunStatus.COMPLETED);
    assert.equal(resumed2.lastApprovedSha, promotedSha);
    assert.equal(resumed2.stepResults["run-branch-execute"].status, "completed");
    assert.equal(resumed2.stepResults["execute"].status, "completed");
    assert.equal(resumed2.stepResults["execute"].output.conclusion, "done");
    assert.equal(resumed2.stepResults["execute"].output.mr_url, "https://gl.test/g/p/-/merge_requests/99");
  });
});
