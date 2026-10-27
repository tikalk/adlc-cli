import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MCP_AGENTS, getMcpAgent } from "../src/registry.mjs";

describe("MCP_AGENTS adapter table", () => {
  it("covers exactly the day-one four", () => {
    assert.deepEqual(Object.keys(MCP_AGENTS).sort(),
      ["claude-code", "codex", "cursor", "opencode"]);
  });

  it("declares target_files, section, format, var_syntax and has_off_switch per row", () => {
    for (const row of Object.values(MCP_AGENTS)) {
      assert.ok(Array.isArray(row.target_files) && row.target_files.length > 0);
      assert.equal(typeof row.section, "string");
      assert.ok(["claude", "opencode", "codex", "cursor"].includes(row.format));
      assert.ok(["passthrough", "env-braces", "env-vars", "env-prefix"].includes(row.var_syntax));
      assert.equal(typeof row.has_off_switch, "boolean");
    }
  });

  it("maps the real target files and sections", () => {
    assert.deepEqual(MCP_AGENTS["claude-code"].target_files, [".mcp.json"]);
    assert.equal(MCP_AGENTS["claude-code"].section, "mcpServers");
    assert.equal(MCP_AGENTS["opencode"].section, "mcp");
    assert.equal(MCP_AGENTS["codex"].section, "mcp_servers");
    assert.equal(MCP_AGENTS["cursor"].section, "mcpServers");
  });

  it("codex and opencode have an off switch; cursor does not", () => {
    assert.equal(MCP_AGENTS.codex.has_off_switch, true);
    assert.equal(MCP_AGENTS.opencode.has_off_switch, true);
    assert.equal(MCP_AGENTS.cursor.has_off_switch, false);
  });

  it("getMcpAgent normalises the claude alias and rejects unknown agents", () => {
    assert.equal(getMcpAgent("claude"), getMcpAgent("claude-code"));
    assert.equal(getMcpAgent("gemini"), null);
  });

  it("maps the opencode, codex and cursor target files", () => {
    // opencode: project file wins over the dotdir variant (first existing wins).
    assert.deepEqual(MCP_AGENTS["opencode"].target_files,
      ["opencode.json", ".opencode/opencode.json"]);
    assert.deepEqual(MCP_AGENTS["codex"].target_files, [".codex/config.toml"]);
    assert.deepEqual(MCP_AGENTS["cursor"].target_files, [".cursor/mcp.json"]);
  });

  it("pins the per-target var_syntax and the claude off-switch", () => {
    // ${VAR} rendering per the design spec's per-agent mapping table:
    // claude-code — unchanged; opencode — {env:NAME}; codex — env_vars
    // inheritance (no string substitution); cursor — ${env:NAME}.
    assert.equal(MCP_AGENTS["claude-code"].var_syntax, "passthrough");
    assert.equal(MCP_AGENTS["opencode"].var_syntax, "env-braces");
    assert.equal(MCP_AGENTS["codex"].var_syntax, "env-vars");
    assert.equal(MCP_AGENTS["cursor"].var_syntax, "env-prefix");
    // `disabled` has no effect in .mcp.json — deleting the entry is the only
    // real off switch for claude-code (design spec, settled decision 3).
    assert.equal(MCP_AGENTS["claude-code"].has_off_switch, false);
  });
});
