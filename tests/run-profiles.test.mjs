// Run-profile registry: per-agent headless invocation data (ported from
// agentic-container/packages/runtime/src/engine/agent-registry.ts:11-52).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRunProfile, RUN_PROFILES } from "../src/registry.mjs";

test("opencode run profile matches the container contract", () => {
  const p = getRunProfile("opencode");
  assert.equal(p.binary, "opencode");
  assert.deepEqual(p.args, ["run", "--format", "json", "--dangerously-skip-permissions"]);
  assert.equal(p.promptPosition, "arg");
  assert.equal(p.outputFormat, "json");
  assert.equal(p.permissionMode, "auto");
  assert.equal(p.modelFlag, "-m");
});

test("claude-code run profile", () => {
  const p = getRunProfile("claude-code");
  assert.equal(p.binary, "claude");
  assert.deepEqual(p.args, ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(p.outputFormat, "stream-json");
  assert.equal(p.permissionMode, "allowed-tools");
  assert.deepEqual(p.allowedTools, ["Read", "Edit", "Write", "Bash", "WebFetch"]);
  assert.equal(p.modelFlag, "--model");
});

test("goose run profile", () => {
  const p = getRunProfile("goose");
  assert.equal(p.binary, "goose");
  assert.deepEqual(p.args, ["run", "--output-format", "stream-json", "-t"]);
  assert.equal(p.outputFormat, "stream-json");
  assert.equal(p.permissionMode, "auto");
  assert.deepEqual(p.envVars, { GOOSE_MODE: "auto" });
  assert.equal(p.modelFlag, null);
});

test("gemini run profile", () => {
  const p = getRunProfile("gemini");
  assert.equal(p.binary, "gemini");
  assert.deepEqual(p.args, ["-p"]);
  assert.equal(p.outputFormat, "text"); // gemini CLI has no --output-format flag
  assert.equal(p.permissionMode, "sandbox");
  assert.equal(p.modelFlag, "-m");
});

test("unknown agent throws with supported list", () => {
  assert.throws(
    () => getRunProfile("unknown-agent"),
    /Unsupported agent.*opencode.*claude-code.*goose.*gemini/s,
  );
});

test("RUN_PROFILES exports all four agents", () => {
  assert.deepEqual(Object.keys(RUN_PROFILES).sort(), ["claude-code", "gemini", "goose", "opencode"]);
});
