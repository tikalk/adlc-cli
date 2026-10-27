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

it("codex: no substitution -- a whole-value var in env inherits under its own name", () => {
  // AMENDED from the plan's pin (env: { T: "${TOK}" }): inheritance cannot
  // rename, so the matching-name case is the expressible one. The renamed
  // case is refused below (fix round 1, finding 2).
  const out = translateEntry({ command: "npx", args: ["-y", "x"], env: { TOK: "${TOK}", U: "plain" } },
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
    { command: "x", env: { TOK: "${TOK}" } },
    { command: "x", env: { TOK: "${TOK:-d}" } },
    { command: "x", env: { T: "${TOK:-d}" } },
    { type: "http", url: "https://y", headers: { Authorization: "Bearer ${V}" } },
    { type: "http", url: "https://y", headers: { X: "${V:-d}" } },
    { command: "x", disabled: true },
    { command: "x" },
  ];
  // The real rows plus cross-axis rows: substitution is keyed on
  // var_syntax, shape on format — they must agree in every pairing.
  const rows = [
    ...Object.values(MCP_AGENTS),
    { ...MCP_AGENTS.codex, var_syntax: "env-braces" },
    { ...MCP_AGENTS.opencode, var_syntax: "env-vars" },
    { ...MCP_AGENTS.cursor, var_syntax: "passthrough" },
  ];
  for (const spec of specs) {
    for (const row of rows) {
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

it("codex maps http onto its StreamableHttp url and refuses sse", () => {
  // codex transports are Stdio | StreamableHttp (fix round 2): an SSE
  // server is a different protocol and would start wrongly against a
  // StreamableHttp client — refused, not half-written.
  assert.deepEqual(translateEntry({ type: "http", url: "https://mcp.example" }, MCP_AGENTS.codex),
    { url: "https://mcp.example", enabled: true });
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

// ── headers mapping (design's per-agent mapping table) ───────────────

it("headers ride along on remote entries with vars rendered per var_syntax", () => {
  const spec = { type: "http", url: "https://mcp.example/${TENANT}",
    headers: { Authorization: "Bearer ${DOCS_TOKEN}" } };
  assert.deepEqual(translateEntry(spec, MCP_AGENTS.opencode), {
    type: "remote", enabled: true,
    url: "https://mcp.example/{env:TENANT}",
    headers: { Authorization: "Bearer {env:DOCS_TOKEN}" },
  });
  assert.deepEqual(translateEntry(spec, MCP_AGENTS.cursor), {
    type: "http",
    url: "https://mcp.example/${env:TENANT}",
    headers: { Authorization: "Bearer ${env:DOCS_TOKEN}" },
  });
  assert.deepEqual(translateEntry(spec, MCP_AGENTS["claude-code"]), spec);
});

it("codex splits headers into http_headers and inherited names", () => {
  const out = translateEntry(
    { type: "http", url: "https://mcp.example",
      headers: { X: "lit", Authorization: "${TOKEN}" } }, MCP_AGENTS.codex);
  assert.deepEqual(out.http_headers, { X: "lit" });
  assert.deepEqual(out.env_http_headers, { Authorization: "TOKEN" });
});

it("codex maps a bearer token header to bearer_token_env_var", () => {
  // The design's flagship example: Authorization "Bearer ${DOCS_TOKEN}"
  // maps to bearer_token_env_var with the variable name from the standard.
  assert.deepEqual(
    translateEntry({ type: "http", url: "https://mcp.example",
      headers: { Authorization: "Bearer ${DOCS_TOKEN}" } }, MCP_AGENTS.codex),
    { url: "https://mcp.example", enabled: true, bearer_token_env_var: "DOCS_TOKEN" });
});

it("codex refuses composed header values but drops defaults on whole vars", () => {
  const composed = { type: "http", url: "https://y", headers: { Authorization: "Basic ${V}" } };
  assert.equal(translateEntry(composed, MCP_AGENTS.codex), null);
  assert.deepEqual(
    translateEntry({ type: "http", url: "https://y", headers: { X: "${V:-d}" } }, MCP_AGENTS.codex),
    { url: "https://y", enabled: true, env_http_headers: { X: "V" } });
  assert.deepEqual(
    expressibleVars({ type: "http", url: "https://y", headers: { X: "${V:-d}" } }),
    { needed: ["V"], droppedDefaults: ["V"] });
});

// ── substitution follows var_syntax, shape follows format ────────────

it("a codex-shaped row that understands env-braces renders them, never raw literals", () => {
  const row = { ...MCP_AGENTS.codex, var_syntax: "env-braces" };
  assert.deepEqual(translateEntry({ command: "npx", args: ["${P}"] }, row),
    { command: "npx", enabled: true, args: ["{env:P}"] });
});

it("an opencode-shaped row with env-vars refuses what it cannot inherit", () => {
  const row = { ...MCP_AGENTS.opencode, var_syntax: "env-vars" };
  assert.equal(translateEntry({ command: "npx", args: ["${P}"] }, row), null);
  assert.match(describeRefusal({ command: "npx", args: ["${P}"] }, row), /does no variable substitution/);
});

it("a cursor-shaped row with passthrough leaves values untouched", () => {
  const row = { ...MCP_AGENTS.cursor, var_syntax: "passthrough" };
  assert.deepEqual(translateEntry({ command: "x", env: { T: "${TOK}" } }, row),
    { type: "stdio", command: "x", env: { T: "${TOK}" } });
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

it("claude refuses disabled -- deleting the entry is the only real off switch", () => {
  // `disabled` has no effect in .mcp.json; a written disabled entry would
  // start anyway. Refused exactly as for cursor (fix round 1, finding 1).
  const spec = { command: "x", disabled: true };
  assert.equal(translateEntry(spec, MCP_AGENTS["claude-code"]), null);
  assert.match(describeRefusal(spec, MCP_AGENTS["claude-code"]), /delet/);
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

it("codex refuses a renamed env var -- inheritance cannot rename", () => {
  // { T: "${TOK}" } would deliver TOK to the server, not T (fix round 1,
  // finding 2). The matching case is pinned in the codex test above.
  const spec = { command: "x", env: { T: "${TOK}" } };
  assert.equal(translateEntry(spec, MCP_AGENTS.codex), null);
  assert.match(describeRefusal(spec, MCP_AGENTS.codex), /inherits names unchanged/);
});

it("codex drops a defaulted env var's fallback and reports it", () => {
  // Design carve-out (fix round 2): `${VAR:-default}` has no codex (or
  // opencode) equivalent — the variable simply becomes required and the
  // dropped default is reported via expressibleVars().droppedDefaults.
  assert.deepEqual(translateEntry({ command: "x", env: { TOK: "${TOK:-d}" } }, MCP_AGENTS.codex),
    { command: "x", enabled: true, env_vars: ["TOK"] });
  assert.deepEqual(
    expressibleVars({ command: "x", env: { TOK: "${TOK:-d}" } }),
    { needed: ["TOK"], droppedDefaults: ["TOK"] });
});

it("codex refuses a renamed env var even when it carries a default -- the rename is the blocker", () => {
  const spec = { command: "x", env: { T: "${TOK:-d}" } };
  assert.equal(translateEntry(spec, MCP_AGENTS.codex), null);
  assert.match(describeRefusal(spec, MCP_AGENTS.codex), /inherits names unchanged/);
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
