// cli-failsafe contract (mission tikalk/adlc-cli#22): unknown verbs fail safe,
// agent/workflow exit codes are machine-readable.
//
// ASSUMED M2 IMPORT SURFACE (for the implementer — static form):
//   import { classifyAgentExit } from "../src/exit-codes.mjs";
//     classifyAgentExit({ code, signal }) -> { exitCode }
//       { code: 0 }                    -> { exitCode: 0 }
//       { code: 1..125, no signal }    -> { exitCode: 10 }
//       { signal: "SIGTERM" }          -> { exitCode: 130 }
//       { code: null, signal: "SIGKILL" } -> { exitCode: 130 }
//   import { classifyWorkflowStatus } from "../src/exit-codes.mjs";
//     classifyWorkflowStatus(status) -> { exitCode }
//       "COMPLETED" -> { exitCode: 0 }
//       "PAUSED"    -> { exitCode: 3 }
//       "FAILED"    -> { exitCode: 10 }
//       "ABORTED"   -> { exitCode: 1 }
// Loaded dynamically below (same path + signatures) so the M1 CLI-behavior
// tests still execute pre-fix while the seam is missing — each M2 test then
// fails with "seam missing" until src/exit-codes.mjs exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const exec = promisify(execFile);
const WORKTREE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (...args) =>
  exec(process.execPath, ["bin/adlc-cli.mjs", ...args], { cwd: WORKTREE }).catch((e) => e);
const exitCodeOf = (r) => r.code ?? r.exitCode ?? 0;
const outputOf = (r) => `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.message ?? ""}`;

// Lazily load the (not-yet-implemented) exit-code seam. Pre-fix this throws
// MODULE_NOT_FOUND and the calling test fails as M2-seam-missing RED.
async function loadExitCodes() {
  try {
    return await import("../src/exit-codes.mjs");
  } catch (err) {
    assert.fail(
      `seam missing: src/exit-codes.mjs not implemented ` +
        `(expected exports classifyAgentExit({code, signal}) and classifyWorkflowStatus(status)). ` +
        `Original error: ${err && err.message ? err.message : err}`,
    );
  }
}

// ── M1: unknown top-level verb must fail safe ─────────────────────────────

test("M1: unknown top-level verb exits 1 with a usage hint", async () => {
  const r = await run("factory-mission", "--issue", "x");
  assert.equal(exitCodeOf(r), 1, `expected exit 1 for unknown verb, got ${exitCodeOf(r)}`);
  assert.match(outputOf(r), /unknown|usage|help/i);
});

// ── M1 guards: existing behavior the fix must not break ───────────────────

test("M1 guard: bare invocation exits 0", async () => {
  const r = await run();
  assert.equal(exitCodeOf(r), 0);
});

test("M1 guard: help exits 0", async () => {
  const r = await run("help");
  assert.equal(exitCodeOf(r), 0);
});

test("M1 guard: run with no prompt exits 1 (existing behavior)", async () => {
  const r = await run("run");
  assert.equal(exitCodeOf(r), 1);
  assert.match(outputOf(r), /task is required/i);
});

// ── M2: agent child exit classification ───────────────────────────────────

test("M2: classifyAgentExit maps clean exit {code:0} to 0", async () => {
  const { classifyAgentExit } = await loadExitCodes();
  assert.equal(classifyAgentExit({ code: 0 }).exitCode, 0);
});

test("M2: classifyAgentExit maps non-zero child code to 10", async () => {
  const { classifyAgentExit } = await loadExitCodes();
  assert.equal(classifyAgentExit({ code: 1 }).exitCode, 10);
  assert.equal(classifyAgentExit({ code: 125 }).exitCode, 10);
});

test("M2: classifyAgentExit maps SIGTERM kill to 130", async () => {
  const { classifyAgentExit } = await loadExitCodes();
  assert.equal(classifyAgentExit({ code: null, signal: "SIGTERM" }).exitCode, 130);
});

test("M2: classifyAgentExit maps SIGKILL kill to 130", async () => {
  const { classifyAgentExit } = await loadExitCodes();
  assert.equal(classifyAgentExit({ code: null, signal: "SIGKILL" }).exitCode, 130);
});

// ── M2: workflow terminal-status classification ───────────────────────────

test("M2: classifyWorkflowStatus maps COMPLETED to 0", async () => {
  const { classifyWorkflowStatus } = await loadExitCodes();
  assert.equal(classifyWorkflowStatus("COMPLETED").exitCode, 0);
});

test("M2: classifyWorkflowStatus maps PAUSED to 3", async () => {
  const { classifyWorkflowStatus } = await loadExitCodes();
  assert.equal(classifyWorkflowStatus("PAUSED").exitCode, 3);
});

test("M2: classifyWorkflowStatus maps FAILED to 10", async () => {
  const { classifyWorkflowStatus } = await loadExitCodes();
  assert.equal(classifyWorkflowStatus("FAILED").exitCode, 10);
});

test("M2: classifyWorkflowStatus maps ABORTED to 1", async () => {
  const { classifyWorkflowStatus } = await loadExitCodes();
  assert.equal(classifyWorkflowStatus("ABORTED").exitCode, 1);
});
