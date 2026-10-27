// tests/mcp-gap.test.mjs — the copy-once gap report (PDR-140).
//
// The team's .mcp.json is the upstream declaration; the project's is the
// copy made once. Drift between them is REPORTED — never written, never
// blocking, never a merge. A missing team source is itself reported: a
// report that quietly reports nothing is worse than no report.
//
// The no-write property of the whole command is pinned by Task 3's tests;
// here the assertions are on the report's return value and on what the
// command prints (ruling 1: no invented projectFileUnchanged helper — the
// two byte-compare assertions below read the files directly).

import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { reportGap, droppedDefaults } from "../src/mcp/gap.mjs";
import { cmdMcpInstall } from "../src/commands/mcp.mjs";

// Minimal project sandbox (same shape as tests/mcp-command.test.mjs).
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-mcp-gap-"));
  return {
    dir,
    path: (rel) => join(dir, rel),
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    },
    read(rel) { return readFileSync(join(dir, rel), "utf-8"); },
    exists(rel) { return existsSync(join(dir, rel)); },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

// A sandbox wired like a real project: team-ai-directives cloned at
// ./team (its .mcp.json is the upstream declaration — including the
// top-level "tools" block the real file ships) and a project .mcp.json
// (the copy). Overrides let each test shape the drift.
const TEAM_SERVERS = {
  context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  "new-team-server": { command: "npx", args: ["-y", "@example/new-server"] },
};
const TOOLS_BLOCK = { github: { type: "github", tokenEnv: "GITHUB_TOKEN" } };

function wired({ teamDoc, projectServers } = {}) {
  const p = sandbox();
  p.write(".adlc/init-options.json", JSON.stringify({
    agent: "opencode",
    team_ai_directives: "./team",
  }));
  p.write("team/.mcp.json", JSON.stringify(teamDoc ?? { mcpServers: TEAM_SERVERS, tools: TOOLS_BLOCK }));
  p.write(".mcp.json", JSON.stringify({ mcpServers: projectServers ?? { context7: TEAM_SERVERS.context7 } }));
  return p;
}

// Capture the ui writers (process.stdout/stderr) while the command runs —
// the assertions are on what a user sees and on which stream sees it.
async function capture(fn) {
  const outChunks = [];
  const errChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { outChunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { errChunks.push(String(chunk)); return true; };
  try {
    const code = await fn();
    return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ── The brief's contract tests ──────────────────────────────────────────

it("lists team-declared names the project lacks (reported, never written)", () => {
  const p = wired();
  try {
    const g = reportGap({ projectRoot: p.dir, servers: { context7: TEAM_SERVERS.context7 } });
    assert.deepEqual(g.missing, ["new-team-server"]);
    assert.equal(g.teamSourceUnavailable, false);
  } finally {
    p.cleanup();
  }
});

it("reports an unavailable team source instead of degrading to 'no gap'", () => {
  const p = sandbox();
  try {
    p.write(".mcp.json", JSON.stringify({ mcpServers: { context7: TEAM_SERVERS.context7 } }));
    const g = reportGap({ projectRoot: p.dir, servers: { context7: TEAM_SERVERS.context7 } });
    assert.equal(g.teamSourceUnavailable, true);
    assert.deepEqual(g.missing, []);
    assert.deepEqual(g.notCarried, []);
  } finally {
    p.cleanup();
  }
});

// ── The rulings that settle the brief's ambiguities ─────────────────────

it("a recorded team source that cannot be found is unavailable", () => {
  const p = sandbox();
  try {
    p.write(".adlc/init-options.json", JSON.stringify({ team_ai_directives: "./nowhere" }));
    const g = reportGap({ projectRoot: p.dir, servers: {} });
    assert.equal(g.teamSourceUnavailable, true);
  } finally {
    p.cleanup();
  }
});

it("an unreadable team .mcp.json is unavailable, not silently empty", () => {
  const p = wired();
  try {
    p.write("team/.mcp.json", "{ // not plain JSON");
    const g = reportGap({ projectRoot: p.dir, servers: {} });
    assert.equal(g.teamSourceUnavailable, true);
  } finally {
    p.cleanup();
  }
});

it("a team .mcp.json whose mcpServers cannot be read is unavailable", () => {
  // A wrong-shaped mcpServers cannot be compared honestly — report the
  // source as unavailable rather than guess at its meaning.
  const p = wired();
  try {
    p.write("team/.mcp.json", JSON.stringify({ mcpServers: "broken" }));
    const g = reportGap({ projectRoot: p.dir, servers: {} });
    assert.equal(g.teamSourceUnavailable, true);
  } finally {
    p.cleanup();
  }
});

it("unknown top-level keys in the team's .mcp.json are reported as not carried", () => {
  // Ruling 5 / settled decision 4: the team file ships a top-level "tools"
  // block. It is never an error and never silently dropped — it is the
  // same "upstream declares, downstream doesn't get it" surface.
  const p = wired();
  try {
    const g = reportGap({
      projectRoot: p.dir,
      servers: { context7: TEAM_SERVERS.context7, "new-team-server": TEAM_SERVERS["new-team-server"] },
    });
    assert.deepEqual(g.missing, []);
    assert.deepEqual(g.notCarried, ["tools"]);
    assert.equal(g.teamSourceUnavailable, false);
  } finally {
    p.cleanup();
  }
});

it("a clean copy reports no gap at all", () => {
  const p = wired({ teamDoc: { mcpServers: TEAM_SERVERS }, projectServers: TEAM_SERVERS });
  try {
    const g = reportGap({ projectRoot: p.dir, servers: TEAM_SERVERS });
    assert.deepEqual(g, { missing: [], notCarried: [], teamSourceUnavailable: false });
  } finally {
    p.cleanup();
  }
});

it("droppedDefaults lists per-server defaults lost in translation", () => {
  // Ruling 4: ${VAR:-default} has no equivalent in targets without default
  // support — the drop must be printed or it stays silent.
  const servers = {
    withDefault: { command: "npx", env: { TOK: "${TOK:-d}" } },
    plain: { command: "npx" },
  };
  assert.deepEqual(droppedDefaults(servers), [{ server: "withDefault", vars: ["TOK"] }]);
  assert.deepEqual(droppedDefaults({}), []);
});

// ── The command wiring: after the install report, never blocking ────────

it("the gap report prints after the install report and never blocks (exit stays 0)", async () => {
  const p = wired({
    projectServers: {
      context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { TOK: "${TOK:-d}" } },
    },
  });
  try {
    const before = p.read(".mcp.json");
    const teamBefore = p.read("team/.mcp.json");
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 0); // the gap never blocks (PDR-140)
    assert.equal(stderr, ""); // a warning, not a failure
    assert.ok(p.exists("opencode.json")); // the install itself happened

    // additive lines AFTER the install report, not instead of it
    const installAt = stdout.indexOf("opencode.json");
    const gapAt = stdout.indexOf("MCP gap");
    assert.ok(installAt !== -1, "install report printed");
    assert.ok(gapAt > installAt, "gap report comes after the install report");

    assert.match(stdout, /warning only/); // the vocabulary of never-blocking
    assert.match(stdout, /new-team-server/); // the missing name is listed
    assert.match(stdout, /not carried to any target: tools/);
    assert.match(stdout, /defaults dropped in translation to opencode/);
    assert.match(stdout, /set explicitly: TOK/);

    assert.equal(p.read(".mcp.json"), before); // the copy is never written
    assert.equal(p.read("team/.mcp.json"), teamBefore); // the upstream neither
  } finally {
    p.cleanup();
  }
});

it("the command reports a missing team source instead of staying silent", async () => {
  const p = sandbox();
  try {
    p.write(".mcp.json", JSON.stringify({ mcpServers: { context7: TEAM_SERVERS.context7 } }));
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 0);
    assert.match(stdout, /team MCP source unavailable/);
    assert.equal(stderr, "");
  } finally {
    p.cleanup();
  }
});

it("a codex-only run does not duplicate the dropped-defaults note the install report already carries", async () => {
  // Ruling 4, check-first: installForAgent's detail already prints
  // "dropped defaults (set explicitly)" for env-vars targets (codex), so
  // the gap report must not repeat it there.
  const p = sandbox();
  try {
    p.write(".mcp.json", JSON.stringify({
      mcpServers: {
        context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { TOK: "${TOK:-d}" } },
      },
    }));
    const { code, stdout } = await capture(() => cmdMcpInstall([p.dir], { agents: ["codex"] }));
    assert.equal(code, 0);
    assert.match(stdout, /dropped defaults \(set explicitly\): TOK/); // the install detail
    assert.ok(stdout.includes("MCP gap")); // the gap section exists (no team source)…
    const gapPart = stdout.slice(stdout.indexOf("MCP gap"));
    assert.doesNotMatch(gapPart, /dropped/); // …without repeating the note
  } finally {
    p.cleanup();
  }
});

it("a project with no .mcp.json still hears the gap (nothing to install is not nothing to say)", async () => {
  // The copy-once contract is drift detection, not an install postscript:
  // a project that has not copied yet lacks every team-declared server.
  const p = sandbox();
  try {
    p.write(".adlc/init-options.json", JSON.stringify({ agent: "opencode", team_ai_directives: "./team" }));
    p.write("team/.mcp.json", JSON.stringify({ mcpServers: TEAM_SERVERS, tools: TOOLS_BLOCK }));
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], {}));
    assert.equal(code, 0); // never blocking
    assert.match(stdout, /nothing to install/);
    assert.match(stdout, /new-team-server/);
    assert.match(stdout, /not carried to any target: tools/);
    assert.equal(stderr, "");
  } finally {
    p.cleanup();
  }
});
