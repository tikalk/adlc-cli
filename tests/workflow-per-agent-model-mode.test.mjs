import test from "node:test";
import assert from "node:assert/strict";
import { buildRunCommand } from "../src/run.mjs";
import { resolveAgentSetting } from "../src/workflow/steps/agent.mjs";
import { WorkflowEngine, WorkflowDefinition } from "../src/workflow/engine.mjs";
import { STEP_REGISTRY } from "../src/workflow/registry.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-model-mode-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("buildRunCommand: opencode with mode flag maps to --agent", () => {
  const { args } = buildRunCommand("opencode", "hello", { mode: "plan" });
  assert.ok(args.includes("--agent"), "must include --agent flag");
  assert.equal(args[args.indexOf("--agent") + 1], "plan");
});

test("buildRunCommand: claude-code with mode maps to --permission-mode", () => {
  const { args } = buildRunCommand("claude-code", "hello", { mode: "plan" });
  assert.ok(args.includes("--permission-mode"), "must include --permission-mode flag");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
});

test("buildRunCommand: gemini with mode maps to --approval-mode", () => {
  const { args } = buildRunCommand("gemini", "hello", { mode: "yolo" });
  assert.ok(args.includes("--approval-mode"), "must include --approval-mode flag");
  assert.equal(args[args.indexOf("--approval-mode") + 1], "yolo");
});

test("buildRunCommand: codex with mode maps to --sandbox", () => {
  const { args } = buildRunCommand("codex", "hello", { mode: "read-only" });
  assert.ok(args.includes("--sandbox"), "must include --sandbox flag");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
});

test("buildRunCommand: agent without modeFlag throws descriptive error", () => {
  assert.throws(
    () => buildRunCommand("goose", "hello", { mode: "plan" }),
    /agent has no execution-mode flag/,
  );
});

test("resolveAgentSetting: scalar string vs per-agent map vs fallback", () => {
  // Scalar string matches all agents
  assert.equal(resolveAgentSetting("fast", null, "opencode"), "fast");

  // Per-agent mapping
  const map = {
    opencode: "open-weight-smart",
    "claude-code": "claude-3-7-sonnet",
    default: "gpt-4o",
  };
  assert.equal(resolveAgentSetting(map, null, "opencode"), "open-weight-smart");
  assert.equal(resolveAgentSetting(map, null, "claude-code"), "claude-3-7-sonnet");
  assert.equal(resolveAgentSetting(map, null, "gemini"), "gpt-4o");

  // Step override beats workflow default
  assert.equal(resolveAgentSetting("step-model", "wf-model", "opencode"), "step-model");

  // Workflow default when step value is null
  assert.equal(resolveAgentSetting(null, "wf-model", "opencode"), "wf-model");
  assert.equal(resolveAgentSetting(null, map, "opencode"), "open-weight-smart");

  // Env override beats both
  assert.equal(resolveAgentSetting("step", "wf", "opencode", "env-model"), "env-model");
});

test("WorkflowEngine validates and runs workflow with per-agent model and mode mappings", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const yaml = `
schema_version: "1.0"
workflow:
  id: test-per-agent
  name: Test Per Agent
  model:
    opencode: "open-model-1"
    claude-code: "claude-model-1"
  mode:
    opencode: "plan"
steps:
  - id: step-one
    type: prompt
    prompt: "review code"
    integration: "opencode"
`;
    const engine = new WorkflowEngine(dir);
    const def = WorkflowDefinition.fromString(yaml);
    assert.deepEqual(engine.validate(def, STEP_REGISTRY), []);
    assert.equal(typeof def.defaultModel, "object");
    assert.equal(def.defaultModel.opencode, "open-model-1");
    assert.equal(def.defaultMode.opencode, "plan");
  } finally {
    cleanup();
  }
});
