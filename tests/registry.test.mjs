import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, getAgent, getEventAgents, getCommandAgents, resolveNpxAgent } from "../src/registry.mjs";

describe("Registry integrity", () => {
  it("every agent has required fields", () => {
    const required = ["name", "npx_agent", "skills_dir", "commands_dir", "commands_ext", "args_placeholder", "format", "default_mode", "events"];

    for (const [key, agent] of Object.entries(AGENTS)) {
      for (const field of required) {
        assert.ok(field in agent, `Agent "${key}" missing field "${field}"`);
      }
    }
  });

  it("every agent has a valid format", () => {
    const validFormats = ["markdown", "toml", "yaml"];
    for (const [key, agent] of Object.entries(AGENTS)) {
      assert.ok(validFormats.includes(agent.format), `Agent "${key}" has invalid format "${agent.format}"`);
    }
  });

  it("every agent has a valid default_mode", () => {
    for (const [key, agent] of Object.entries(AGENTS)) {
      assert.ok(["inline", "wrapper"].includes(agent.default_mode), `Agent "${key}" has invalid mode "${agent.default_mode}"`);
    }
  });

  it("9 agents support events", () => {
    const eventAgents = getEventAgents();
    assert.equal(eventAgents.length, 9);
    const keys = eventAgents.map((a) => a.key).sort();
    assert.deepEqual(keys, [
      "claude-code",
      "codex",
      "cursor",
      "devin",
      "gemini-cli",
      "github-copilot",
      "opencode",
      "qwen-code",
      "tabnine-cli",
    ]);
  });

  it("getAgent returns null for unknown key", () => {
    assert.equal(getAgent("nonexistent"), null);
  });

  it("resolveNpxAgent returns universal for null npx_agent", () => {
    assert.equal(resolveNpxAgent("forge"), "universal");
    assert.equal(resolveNpxAgent("omp"), "universal");
    assert.equal(resolveNpxAgent("shai"), "universal");
  });

  it("resolveNpxAgent returns the npx_agent value for known agents", () => {
    assert.equal(resolveNpxAgent("opencode"), "opencode");
    assert.equal(resolveNpxAgent("claude-code"), "claude-code");
    assert.equal(resolveNpxAgent("gemini-cli"), "gemini-cli");
  });

  it("all command agents are listed (excluding generic)", () => {
    const cmdAgents = getCommandAgents();
    assert.ok(cmdAgents.length >= 20, `Expected at least 20 command agents, got ${cmdAgents.length}`);
  });

  it("opencode uses wrapper mode for user-invoked skills (ignores disable-model-invocation)", () => {
    assert.equal(getAgent("opencode").user_invoked_mode, "wrapper", "opencode skills stay in available_skills → wrapper invokes via skill tool");
  });

  it("claude-code has no user_invoked_mode (defaults to execution)", () => {
    assert.ok(!getAgent("claude-code").user_invoked_mode, "claude-code respects the flag → execution fallback");
  });
});

describe("session_compact event support", () => {
  it("session_compact is a recognized canonical event", async () => {
    const { CANONICAL_EVENTS } = await import("../src/registry.mjs");
    assert.ok(CANONICAL_EVENTS.includes("session_compact"));
  });

  it("every event agent declares an explicit session_compact mapping (even null)", async () => {
    const { EVENT_AGENTS } = await import("../src/registry.mjs");
    for (const [key, entry] of Object.entries(EVENT_AGENTS)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(entry.canonical_to_native, "session_compact"),
        `${key}: canonical_to_native lacks an explicit session_compact mapping`,
      );
    }
  });

  it("no canonical event is silently unknown to any event agent", async () => {
    const { EVENT_AGENTS, CANONICAL_EVENTS } = await import("../src/registry.mjs");
    for (const [key, entry] of Object.entries(EVENT_AGENTS)) {
      for (const ev of CANONICAL_EVENTS) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(entry.canonical_to_native, ev),
          `${key}: canonical event ${ev} has no per-agent decision`,
        );
      }
    }
  });

  it("session_compact participates in the body-injection path", async () => {
    const { BODY_INJECTION_EVENTS } = await import("../src/registry.mjs");
    assert.ok(BODY_INJECTION_EVENTS.has("session_compact"));
  });
});
