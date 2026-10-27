import { it } from "node:test";
import assert from "node:assert/strict";
import { translateEntry, describeRefusal, offSwitchEntry, expressibleVars } from "../src/mcp/translate.mjs";
import { MCP_AGENTS } from "../src/registry.mjs";

// ── The brief's contract tests (values verbatim) ───────────────────────

it("opencode: command+args become one array, env becomes environment, vars become {env:NAME}", () => {
  const out = translateEntry(
    { command: "npx", args: ["-y", "@upstash/context7-mcp"],
      env: { TOKEN: "${GITLAB_TOKEN}" } }, MCP_AGENTS.opencode);
  assert.deepEqual(out, {
    type: "local", enabled: true,
    command: ["npx", "-y", "@upstash/context7-mcp"],
    environment: { TOKEN: "{env:GITLAB_TOKEN}" },
  });
});

it("cursor: stdio entries require type, vars become ${env:NAME}", () => {
  const out = translateEntry({ command: "npx", args: ["-y", "x"], env: { T: "${TOK}" } },
    MCP_AGENTS.cursor);
  assert.equal(out.type, "stdio");
  assert.equal(out.env.T, "${env:TOK}");
});

it("codex: no substitution -- a var in env becomes env_vars, never a literal", () => {
  const out = translateEntry({ command: "npx", args: ["-y", "x"], env: { T: "${TOK}", U: "plain" } },
    MCP_AGENTS.codex);
  assert.deepEqual(out.env_vars, ["TOK"]);
  assert.equal(out.env.U, "plain");
});

it("claude is a no-op", () => {
  const spec = { command: "npx", args: ["-y", "x"], env: { T: "${TOK:-d}" } };
  assert.deepEqual(translateEntry(spec, MCP_AGENTS["claude-code"]), spec);
});

it("refuses an entry that cannot be fully expressed in the target", () => {
  // codex has no substitution in url/args: a ${VAR} there is inexpressible.
  assert.equal(translateEntry({ type: "http", url: "https://mcp.example/${TENANT}" },
    MCP_AGENTS.codex), null);
  // the same entry is fine for opencode.
  assert.notEqual(translateEntry({ type: "http", url: "https://mcp.example/${TENANT}" },
    MCP_AGENTS.opencode), null);
});

it("refuses an entry with neither command nor url rather than writing command:[null]", () => {
  assert.equal(translateEntry({}, MCP_AGENTS.opencode), null);
  assert.equal(translateEntry({ type: "http" }, MCP_AGENTS.opencode), null);
});

it("offSwitchEntry honours has_off_switch and reports absence honestly", () => {
  assert.deepEqual(offSwitchEntry(MCP_AGENTS.opencode), { enabled: false });
  assert.deepEqual(offSwitchEntry(MCP_AGENTS.codex), { enabled: false });
  assert.equal(offSwitchEntry(MCP_AGENTS.cursor), null);
});

it("expressibleVars separates required names from dropped defaults", () => {
  assert.deepEqual(
    expressibleVars({ command: "npx", env: { A: "${ONE}", B: "${TWO:-fallback}" } }),
    { needed: ["ONE", "TWO"], droppedDefaults: ["TWO"] });
});

// ── describeRefusal: one source of truth for refusals ─────────────────

it("describeRefusal agrees with translateEntry on every refusal and acceptance", () => {
  const specs = [
    null,
    {},
    { type: "http" },
    { command: "x", url: "https://y" },
    { command: "x", args: "${P}" },
    { command: "x", env: { T: 5 } },
    { type: "http", url: "https://y" },
    { type: "sse", url: "https://y" },
    { type: "http", url: "https://y/${V}" },
    { type: "http", url: "https://y", headers: { A: "b" } },
    { type: "http", url: "https://y", args: ["a"] },
    { command: "${BIN}/x" },
    { command: "x", args: ["${P}"] },
    { command: "x", env: { T: "prefix-${V}" } },
    { command: "x", env: { T: "${V}" } },
    { command: "x", disabled: true },
    { command: "x" },
  ];
  for (const spec of specs) {
    for (const row of Object.values(MCP_AGENTS)) {
      const refused = describeRefusal(spec, row);
      assert.equal(translateEntry(spec, row) === null, refused !== null,
        `disagreement for ${JSON.stringify(spec)} / ${row.format}`);
    }
  }
});

it("describeRefusal names the field and the variable codex cannot substitute", () => {
  const reason = describeRefusal({ type: "http", url: "https://mcp.example/${TENANT}" }, MCP_AGENTS.codex);
  assert.match(reason, /url/);
  assert.match(reason, /\$\{TENANT\}/);
});

it("describeRefusal explains an unstartable entry for every target", () => {
  for (const row of Object.values(MCP_AGENTS)) {
    assert.match(describeRefusal({}, row), /neither command nor url/);
  }
});

it("describeRefusal has nothing to say about an expressible entry", () => {
  assert.equal(describeRefusal(
    { command: "npx", args: ["-y", "x"], env: { TOKEN: "${GITLAB_TOKEN}" } },
    MCP_AGENTS.opencode), null);
});

// ── Entry shapes beyond the brief's pins ──────────────────────────────

it("codex url entry is just url plus the off switch field", () => {
  assert.deepEqual(translateEntry({ type: "http", url: "https://mcp.example" }, MCP_AGENTS.codex),
    { url: "https://mcp.example", enabled: true });
});

it("codex refuses an sse url it cannot express", () => {
  assert.equal(translateEntry({ type: "sse", url: "https://mcp.example" }, MCP_AGENTS.codex), null);
  assert.match(describeRefusal({ type: "sse", url: "https://mcp.example" }, MCP_AGENTS.codex), /sse/);
});

it("opencode url entry becomes a remote entry with env-braces vars", () => {
  assert.deepEqual(translateEntry({ type: "http", url: "https://mcp.example/${TENANT}" }, MCP_AGENTS.opencode),
    { type: "remote", enabled: true, url: "https://mcp.example/{env:TENANT}" });
});

it("cursor keeps the http/sse type and rewrites the url with env-prefix vars", () => {
  assert.deepEqual(translateEntry({ type: "sse", url: "https://mcp.example/${TENANT}" }, MCP_AGENTS.cursor),
    { type: "sse", url: "https://mcp.example/${env:TENANT}" });
});

it("cursor requires type on a url entry", () => {
  assert.equal(translateEntry({ url: "https://mcp.example" }, MCP_AGENTS.cursor), null);
  assert.match(describeRefusal({ url: "https://mcp.example" }, MCP_AGENTS.cursor), /need type/);
});

it("opencode rewrites variables in args", () => {
  assert.deepEqual(translateEntry({ command: "npx", args: ["${P}"] }, MCP_AGENTS.opencode),
    { type: "local", enabled: true, command: ["npx", "{env:P}"] });
});

it("type that contradicts the connection is refused", () => {
  assert.equal(translateEntry({ type: "http", command: "x" }, MCP_AGENTS.opencode), null);
  assert.match(describeRefusal({ type: "http", command: "x" }, MCP_AGENTS.opencode), /conflicts with command/);
});

it("refuses an entry with both command and url rather than dropping one", () => {
  const spec = { command: "x", url: "https://y" };
  assert.equal(translateEntry(spec, MCP_AGENTS.opencode), null);
  assert.equal(translateEntry(spec, MCP_AGENTS.cursor), null);
  assert.equal(translateEntry(spec, MCP_AGENTS.codex), null);
  // claude is a no-op: the standard's own shape passes through untouched.
  assert.deepEqual(translateEntry(spec, MCP_AGENTS["claude-code"]), spec);
});

it("refuses fields the target cannot express instead of dropping them", () => {
  const spec = { command: "x", headers: { Authorization: "Bearer z" } };
  assert.equal(translateEntry(spec, MCP_AGENTS.cursor), null);
  assert.match(describeRefusal(spec, MCP_AGENTS.cursor), /headers/);
  assert.match(describeRefusal(spec, MCP_AGENTS.cursor), /cursor/);
});

it("refuses env and args on url entries", () => {
  const withArgs = { type: "http", url: "https://y", args: ["a"] };
  const withEnv = { type: "http", url: "https://y", env: { A: "b" } };
  assert.equal(translateEntry(withArgs, MCP_AGENTS.cursor), null);
  assert.equal(translateEntry(withEnv, MCP_AGENTS.cursor), null);
  assert.match(describeRefusal(withArgs, MCP_AGENTS.cursor), /args/);
  assert.match(describeRefusal(withEnv, MCP_AGENTS.cursor), /env/);
});

// ── disabled mapping ─────────────────────────────────────────────────

it("disabled maps to enabled:false where the target has an off switch", () => {
  assert.deepEqual(translateEntry({ command: "x", disabled: true }, MCP_AGENTS.opencode),
    { type: "local", enabled: false, command: ["x"] });
  assert.deepEqual(translateEntry({ command: "x", disabled: true }, MCP_AGENTS.codex),
    { command: "x", enabled: false });
});

it("cursor refuses a disabled entry it cannot switch off", () => {
  assert.equal(translateEntry({ command: "x", disabled: true }, MCP_AGENTS.cursor), null);
  assert.match(describeRefusal({ command: "x", disabled: true }, MCP_AGENTS.cursor), /disable/);
});

it("claude passes disabled through untouched", () => {
  const spec = { command: "x", disabled: true };
  assert.deepEqual(translateEntry(spec, MCP_AGENTS["claude-code"]), spec);
});

it("claude-code has no off switch either", () => {
  assert.equal(offSwitchEntry(MCP_AGENTS["claude-code"]), null);
});

// ── codex env inheritance limits ─────────────────────────────────────

it("codex refuses a value that mixes text and variables in env", () => {
  const spec = { command: "x", env: { T: "prefix-${V}" } };
  assert.equal(translateEntry(spec, MCP_AGENTS.codex), null);
  assert.match(describeRefusal(spec, MCP_AGENTS.codex), /in env is not one whole/);
});

it("codex env value that is only a default-carrying var still inherits the name", () => {
  assert.deepEqual(translateEntry({ command: "x", env: { T: "${V:-d}" } }, MCP_AGENTS.codex),
    { command: "x", enabled: true, env_vars: ["V"] });
});

it("codex refuses variables in command and args", () => {
  assert.equal(translateEntry({ command: "${BIN}/x" }, MCP_AGENTS.codex), null);
  assert.equal(translateEntry({ command: "x", args: ["${P}"] }, MCP_AGENTS.codex), null);
  assert.match(describeRefusal({ command: "${BIN}/x" }, MCP_AGENTS.codex), /command/);
  assert.match(describeRefusal({ command: "x", args: ["${P}"] }, MCP_AGENTS.codex), /args/);
});

// ── The no-eager-resolution constraint ───────────────────────────────

it("variables are never resolved from the machine's environment", () => {
  process.env.MCP_TRANSLATE_TEST_TOKEN = "secret-value";
  try {
    const out = translateEntry({ command: "npx", env: { T: "${MCP_TRANSLATE_TEST_TOKEN}" } }, MCP_AGENTS.opencode);
    assert.equal(out.environment.T, "{env:MCP_TRANSLATE_TEST_TOKEN}");
    assert.ok(!JSON.stringify(out).includes("secret-value"));
  } finally {
    delete process.env.MCP_TRANSLATE_TEST_TOKEN;
  }
});

// ── expressibleVars beyond the brief's pin ───────────────────────────

it("expressibleVars finds variables in args and url and dedupes names", () => {
  assert.deepEqual(
    expressibleVars({ command: "npx", args: ["${A}"], url: "https://x/${B}", env: { C: "${A:-z}" } }),
    { needed: ["A", "B"], droppedDefaults: ["A"] });
});

it("expressibleVars reports nothing for a spec without variables", () => {
  assert.deepEqual(expressibleVars({ command: "npx" }), { needed: [], droppedDefaults: [] });
});
