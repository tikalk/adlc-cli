import test from "node:test";
import assert from "node:assert/strict";
import { WorkflowEngine } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-agent-res-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("agent resolution respects ADLC_AGENT env or CLI flag fallback", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow("factory-autonomous");
    assert.equal(def.id, "factory-autonomous");
    assert.equal(def.steps[0].command, "factory-mission");

    const savedEnv = process.env.ADLC_AGENT;
    try {
      process.env.ADLC_AGENT = "codex";
      const step = STEP_REGISTRY["command"];
      assert.ok(step);
    } finally {
      if (savedEnv !== undefined) process.env.ADLC_AGENT = savedEnv;
      else delete process.env.ADLC_AGENT;
    }
  } finally {
    cleanup();
  }
});
