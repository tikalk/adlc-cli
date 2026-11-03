# `adlc-cli mcp install` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `adlc-cli mcp install` reads the project's `.mcp.json` and writes each named agent's MCP config in that agent's own shape, refusing to report success for anything it could not deliver.

**Architecture:** One `MCP_AGENTS` table in `src/registry.mjs` (the shape `EVENT_AGENTS` already proves out) drives pure per-target translation functions and a single merge engine. The merge is **name-keyed**: any entry whose name appears in `.mcp.json` is tool-owned and regenerated; any other name is never read or written. No lock file, no state — ownership is implied by the name.

**Tech Stack:** Node >= 18, zero dependencies (ADR-305), `node --test`. No PowerShell twin — adlc-cli is the single cross-platform implementation, which is the point of PDR-139.

**Spec:** `docs/adlc/memory/pdr/PDR-138…140` + `docs/adlc/memory/adr/ADR-455` (adlc-workspace), and `docs/superpowers/specs/2026-10-26-multi-agent-mcp-design.md`. This plan argues from those; read them alongside.

## Global Constraints

- Zero dependencies. Node stdlib only (`node:fs`, `node:path`, `node:os`).
- `adlc-cli` is invoked as a command. **No skill prose orchestrates it** (PDR-139).
- Exit contract is **`0` on success, `1` on any failure** — the CLI's existing convention. `3` is contractually reserved for `PAUSED` by `src/commands/workflow.mjs`; never return it.
- Never report success for a named agent that will start without its servers.
- Never write an entry that cannot be **fully** expressed in the target. Refuse that entry for that target and say why. Never resolve `${VAR}` eagerly from the machine's environment.
- `.mcp.json` is never rewritten by tooling. Only the agent configs are written.
- Target files are foreign — they also hold providers, plugins, and the user's own servers. Preserve every unrelated key byte-for-byte where the format allows.

## Review Focus

- **A `.mcp.json` entry with neither `command` nor `url`** — currently translatable to `{"type":"local","command":[null]}` and reported "merged". A reasonable person expects a refusal naming the server, not an unstartable config and a success message.
- **`${VAR}` inside a codex `url` or `args`** — codex has no substitution; a literal must not be written silently. Expect refusal for that target only, other targets still written.
- **A hand-edited entry in a tool-owned slot** — expect it to be overwritten, and the run to say `updated`. If it is silently preserved, ownership is not name-keyed after all.
- **`.mcp.json` present but `.adlc/init-options.json` absent and no `--agent`** — expect a loud failure naming the missing precondition, never a silent default to `claude`.
- **Re-running on a converged project** — expect byte-identical files and a report of `kept` for every server.

---

### Task 1: `MCP_AGENTS` and `getMcpAgent`

**Files:**
- Modify: `src/registry.mjs` (add beside `EVENT_AGENTS`)
- Test: `tests/mcp-registry.test.mjs`

**Interfaces:**
- Produces: `MCP_AGENTS` — `Record<string, McpAgentRow>`, keys `"claude-code" | "opencode" | "codex" | "cursor"`.
  `McpAgentRow = { target_files: string[], section: string, format: "claude" | "opencode" | "codex" | "cursor", var_syntax: "passthrough" | "env-braces" | "env-vars" | "env-prefix", has_off_switch: boolean }`.
  `getMcpAgent(key: string): McpAgentRow | null` — normalises `"claude"` → `"claude-code"`.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcp-registry.test.mjs
import { MCP_AGENTS, getMcpAgent } from "../src/registry.mjs";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mcp-registry.test.mjs`
Expected: FAIL with `MCP_AGENTS is not exported` / `Cannot find module`

- [ ] **Step 3: Add `MCP_AGENTS` and `getMcpAgent` to `src/registry.mjs`**

Place directly after `EVENT_AGENTS` so the two adapter tables sit together. `opencode.target_files` is `["opencode.json", ".opencode/opencode.json"]` (first existing wins); `codex.target_files` is `[".codex/config.toml"]`; `cursor.target_files` is `[".cursor/mcp.json"]`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/mcp-registry.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/registry.mjs tests/mcp-registry.test.mjs
git commit -m "feat(mcp): MCP_AGENTS adapter table beside EVENT_AGENTS"
```

---

### Task 2: Translation — variable syntax and `disabled`

**Files:**
- Create: `src/mcp/translate.mjs`
- Test: `tests/mcp-translate.test.mjs`

**Interfaces:**
- Consumes: `McpAgentRow.var_syntax`, `McpAgentRow.has_off_switch` (Task 1).
- Produces:
  - `translateValue(value: string, varSyntax: VarSyntax): string` — rewrites `${VAR}` and `${VAR:-default}` in one string.
  - `translateEntry(spec: object, row: McpAgentRow): object | null` — the target-shaped entry, or `null` when it cannot be fully expressed.
  - `offSwitchEntry(row: McpAgentRow): object | null` — the entry that disables a server, or `null` when the target has none.
  - `expressibleVars(spec: object): { needed: string[], droppedDefaults: string[] }` — for the "set these env vars" report.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcp-translate.test.mjs
import { translateEntry, translateValue, offSwitchEntry, expressibleVars } from "../src/mcp/translate.mjs";
import { MCP_AGENTS } from "../src/registry.mjs";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mcp-translate.test.mjs`
Expected: FAIL with `Cannot find module '../src/mcp/translate.mjs'`

- [ ] **Step 3: Implement `src/mcp/translate.mjs`**

Pure functions, no I/O. `translateEntry` returns `null` on the first inexpressible construct; the *reason* is carried by `translateEntry.reason` is **not** used — instead export `describeRefusal(spec, row): string | null` returning the human explanation for the same inputs, so the caller prints one message without the engine re-deriving it. Keep the two functions agreeing by having `translateEntry` call `describeRefusal` first.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/mcp-translate.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/translate.mjs tests/mcp-translate.test.mjs
git commit -m "feat(mcp): per-target translation with honest refusals"
```

---

### Task 3: The merge engine — name-keyed ownership

**Files:**
- Create: `src/mcp/install.mjs`
- Test: `tests/mcp-install.test.mjs`

**Interfaces:**
- Consumes: Task 1 `McpAgentRow`; Task 2 `translateEntry`, `describeRefusal`, `offSwitchEntry`, `expressibleVars`.
- Produces: `installForAgent({ projectRoot, agent, servers }): Report`
  where `Report = { target: string, written: Array<{name, action: "added"|"updated"|"kept"|"repaired"|"refused"|"disabled-skipped", detail?: string}>, errors: string[] }`.
  `servers` is the parsed `.mcp.json` `mcpServers` map.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcp-install.test.mjs
it("adds entries in the target's shape and leaves foreign keys alone", async () => {
  // fixture: opencode.json with $schema, plugin[], and an unrelated server
  const r = installForAgent({ projectRoot, agent: "opencode", servers });
  const cfg = JSON.parse(read(`${projectRoot}/opencode.json`));
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(cfg.plugin, ["p@git+https://x/p.git"]);
  assert.equal(cfg.mcp.unrelated.type, "local");           // untouched
  assert.equal(cfg.mcp.context7.type, "local");            // translated
});

it("a name in .mcp.json is tool-owned: a hand-edited body is overwritten and reported", async () => {
  // fixture: opencode.json where context7 has a hand-written body
  const r = installForAgent({ projectRoot, agent: "opencode", servers });
  assert.equal(r.written.find(w => w.name === "context7").action, "updated");
});

it("a bare {\"enabled\": false} override is kept, not replaced", async () => {
  // that entry switches off a globally defined server; rewriting re-enables it
  assert.equal(r.written.find(w => w.name === "gitlab").action, "kept");
});

it("a refused entry is not written, and names the server and the reason", async () => {
  const r = installForAgent({ projectRoot, agent: "codex", servers });
  const w = r.written.find(x => x.name === "docs");
  assert.equal(w.action, "refused");
  assert.match(w.detail, /url/);
  assert.equal(JSON.parse(read(`${projectRoot}/.codex/config.toml`)), null); // not created
});

it("disabled:true writes the off switch where one exists and skips where none does", async () => {
  // opencode -> {"enabled": false}; cursor -> omitted + reported
});

it("is idempotent: a second run writes byte-identical files and reports kept", async () => {
  const first = readBytes(`${projectRoot}/opencode.json`);
  const r2 = installForAgent({ projectRoot, agent: "opencode", servers });
  assert.deepEqual(readBytes(`${projectRoot}/opencode.json`), first);
  assert.ok(r2.written.every(w => w.action === "kept"));
});

it("refuses a config that is not plain JSON instead of editing it", async () => {
  // fixture: opencode.json with a // comment
  assert.ok(r.errors.some(e => /not plain JSON/.test(e)));
  assert.equal(read(`${projectRoot}/opencode.json`), original);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mcp-install.test.mjs`
Expected: FAIL with `Cannot find module '../src/mcp/install.mjs'`

- [ ] **Step 3: Implement `installForAgent` in `src/mcp/install.mjs`**

Target selection: first existing of `row.target_files` under `projectRoot`, else the first candidate. `.jsonc` or a non-JSON target is left untouched and reported. The write is a **merge into the named section**, never a rewrite of the file. For codex (TOML) write a `[mcp_servers.<name>]` fragment with a marker pair, mirroring `buildTomlFragment`/`stripTomlMarkerBlocks` in `src/events.mjs`; do not re-serialise the whole file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/mcp-install.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/install.mjs tests/mcp-install.test.mjs
git commit -m "feat(mcp): name-keyed merge into foreign agent configs"
```

---

### Task 4: `adlc-cli mcp install` — command, precondition, exit contract

**Files:**
- Create: `src/commands/mcp.mjs`
- Modify: `src/dispatch.mjs` (register `mcp` → `cmdMcpInstall`)
- Test: `tests/mcp-command.test.mjs`

**Interfaces:**
- Consumes: `installForAgent` (Task 3); `readInitOptions`, `readAgent`, `readTeamAiDirectives` from `src/utils/init-options.mjs`.
- Produces: `cmdMcpInstall(args: string[], flags: object): Promise<number>` — returns `0` or `1` only.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcp-command.test.mjs
it("refuses loudly when team-setup has not run: no init-options and no --agent", async () => {
  // fixture project with a .mcp.json but no .adlc/init-options.json
  const rc = await cmdMcpInstall([projectRoot], {});
  assert.equal(rc, 1);
});

it("reports 'nothing to install' and exits 0 when .mcp.json is absent", async () => {
  assert.equal(await cmdMcpInstall([projectRoot], { agents: ["opencode"] }), 0);
});

it("a named agent with no adapter fails and lists the servers by hand", async () => {
  const rc = await cmdMcpInstall([projectRoot], { agents: ["gemini"] });
  assert.equal(rc, 1);                    // not 3 -- 3 is PAUSED
  assert.match(capturedStderr, /add these servers by hand/);
});

it("exits 0 when every named agent is configured", async () => {
  assert.equal(await cmdMcpInstall([projectRoot], { agents: ["opencode", "cursor"] }), 0);
});

it("exits 1 when one of several named agents cannot be delivered", async () => {
  assert.equal(await cmdMcpInstall([projectRoot], { agents: ["opencode", "gemini"] }), 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mcp-command.test.mjs`
Expected: FAIL with `cmdMcpInstall is not a function`

- [ ] **Step 3: Implement `cmdMcpInstall` and register it**

Argument shape: `adlc-cli mcp install [DIR] --agent NAME` (`-a`/`--agents` accepted, matching `cmdAdd`). Agent precedence: `--agent`, else `readAgent(DIR)`, else fail. Only `MCP_AGENTS` keys get a file written; a named agent outside that set prints the by-hand list to **stderr** and returns 1. Read `.mcp.json` from `DIR` (default `process.cwd()`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/mcp-command.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/mcp.mjs src/dispatch.mjs tests/mcp-command.test.mjs
git commit -m "feat(mcp): adlc-cli mcp install command"
```

---

### Task 5: Gap report and the copy-once contract

**Files:**
- Create: `src/mcp/gap.mjs`
- Modify: `src/commands/mcp.mjs` (report after install)
- Test: `tests/mcp-gap.test.mjs`

**Interfaces:**
- Consumes: `readTeamAiDirectives` (to locate the team's `.mcp.json`).
- Produces: `reportGap({ projectRoot, servers }): { missing: string[], teamSourceUnavailable: boolean }` — pure comparison, writes nothing.

- [ ] **Step 1: Write the failing test**

```js
// tests/mcp-gap.test.mjs
it("lists team-declared names the project lacks and never writes them", async () => {
  const g = reportGap({ projectRoot, servers: projectServers });
  assert.deepEqual(g.missing, ["new-team-server"]);
  assert.equal(projectFileUnchanged(), true);
});

it("reports an unavailable team source instead of degrading to 'no gap'", async () => {
  const g = reportGap({ projectRoot: rootWithoutTeam, servers });
  assert.equal(g.teamSourceUnavailable, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mcp-gap.test.mjs`
Expected: FAIL with `Cannot find module '../src/mcp/gap.mjs'`

- [ ] **Step 3: Implement `reportGap` and call it from `cmdMcpInstall`**

The gap is **never** a merge and **never** blocks (PDR-140): it is a warning listing the names. A missing team source is itself reported — a report that quietly reports nothing is worse than no report.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/mcp-gap.test.mjs`
Expected: PASS

- [ ] **Step 5: Full suite and commit**

Run: `npm test`
Expected: PASS — the whole suite, not just this file.

```bash
git add src/mcp/gap.mjs src/commands/mcp.mjs tests/mcp-gap.test.mjs
git commit -m "feat(mcp): copy-once gap report, warning only"
```

---

## Self-review

**Spec coverage:** PDR-138 (standard file, never rewritten) → Task 3's "leaves foreign keys alone" + the no-rewrite constraint. PDR-139 (command, precondition, exit contract) → Task 4. PDR-140 (copy-once, gap reported, never blocking) → Task 5. ADR-455's four-agent table, name-keyed ownership, `disabled` mapping, and the entry refusal → Tasks 1–3. The `GITIGNORE_RULES_ALLOWLIST` flip and the `adlc-argo-wf` call site are **recorded obligations outside this repo** and are deliberately not tasks here.

**Type consistency:** `McpAgentRow` and `Report` are defined once, in Task 1 and Task 3's Interfaces blocks, and referenced unchanged afterwards. `describeRefusal` is introduced in Task 2 and consumed in Task 3.

**Review Focus:** each of the five lines has a named test in the task that owns the code — Task 3 covers the no-command entry, the inexpressible codex `url`, hand-edit overwrite and idempotence; Task 4 covers the missing precondition.

**Proportion:** five tasks, each one test cycle. The bodies stay out of the plan — only the signatures and the assertions pin the decisions.
