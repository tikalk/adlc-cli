// The classifier and the engine tag behind "a run that throws exits with the
// failed code" (SF-FIX-21). The command-level behaviour is pinned in
// workflow-thrown-exit.test.mjs.
//
//   X4  classifyWorkflowError: only an error tagged by the engine as a failed
//       run maps to 10; a transient operating-system fault keeps 1.
//   X5  The engine tags what it rethrows (also a thrown non-Error).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine, RunStatus, markRunFailed } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { classifyWorkflowError } from "../src/exit-codes.mjs";

const temps = [];
process.on("exit", () => {
  for (const d of temps) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// Valid for `workflow validate`, throws at run time: `upper` is not a filter.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "thrown-classify-"));
  temps.push(dir);
  const wf = join(dir, "wf.yml");
  writeFileSync(wf, `schema_version: "1.0"
workflow:
  id: throws
  name: Throws
  version: "1.0.0"
inputs:
  who: {type: string, default: "x"}
steps:
  - id: bad
    type: shell
    run: "echo {{ inputs.who | upper }}"
`, "utf-8");
  return { dir, wf };
}

test("X4: only an error the engine tagged as a failed run maps to the failed code", () => {
  const tagged = (extra = {}) => Object.assign(new Error("boom"), { adlcRun: { runId: "r1", status: "failed" } }, extra);
  assert.equal(classifyWorkflowError(tagged()).exitCode, 10);
  assert.equal(classifyWorkflowError(new Error("lease held")).exitCode, 1, "an untagged error never started or never failed a run");
  assert.equal(classifyWorkflowError(null).exitCode, 1);
  assert.equal(classifyWorkflowError(undefined).exitCode, 1);
  assert.equal(classifyWorkflowError("text").exitCode, 1);
  assert.equal(classifyWorkflowError(Object.assign(new Error("x"), { adlcRun: { status: "paused" } })).exitCode, 1);
  // A disk-full or I/O fault may not repeat on a new pod: still retried.
  for (const code of ["ENOSPC", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ENOMEM", "EAGAIN", "EBUSY", "ETIMEDOUT"]) {
    assert.equal(classifyWorkflowError(tagged({ code })).exitCode, 1, `${code} stays retryable`);
  }
  // A missing file or a bad argument is the same on every attempt.
  for (const code of ["ENOENT", "EACCES", "ERR_INVALID_ARG_TYPE"]) {
    assert.equal(classifyWorkflowError(tagged({ code })).exitCode, 10, `${code} is not retried`);
  }
});

test("X5: the engine tags the error it rethrows with the run id and status", async () => {
  const { dir, wf } = project();
  const engine = new WorkflowEngine(dir);
  await assert.rejects(
    () => engine.execute(engine.loadWorkflow(wf), {}, "x5run", STEP_REGISTRY),
    (err) => {
      assert.match(err.message, /unknown filter 'upper'/);
      assert.deepEqual(err.adlcRun, { runId: "x5run", status: RunStatus.FAILED });
      assert.equal(classifyWorkflowError(err).exitCode, 10);
      return true;
    },
  );
  await assert.rejects(
    () => new WorkflowEngine(dir).resume("x5run", null, STEP_REGISTRY),
    (err) => err.adlcRun?.status === RunStatus.FAILED && err.adlcRun?.runId === "x5run",
  );
});

test("X5: markRunFailed turns any thrown value into a tagged Error", () => {
  const state = { runId: "r9", status: RunStatus.FAILED };
  const fromString = markRunFailed("plain text", state);
  assert.ok(fromString instanceof Error);
  assert.equal(fromString.message, "plain text");
  assert.deepEqual(fromString.adlcRun, { runId: "r9", status: "failed" });
  const original = new TypeError("bad");
  assert.equal(markRunFailed(original, state), original, "an Error is tagged in place, stack kept");
  const frozen = Object.freeze(new Error("frozen"));
  assert.equal(markRunFailed(frozen, state), frozen, "a frozen error does not throw");
  assert.equal(classifyWorkflowError(frozen).exitCode, 1);
});
