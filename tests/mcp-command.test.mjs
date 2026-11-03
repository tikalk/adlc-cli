// tests/mcp-command.test.mjs — `adlc-cli mcp install`: the command, the
// precondition, and the exit contract.
//
// The command is the promise surface (PDR-138/139): exit 0 only when every
// NAMED agent's config is delivered; exit 1 on any failure — never 3, which
// src/commands/workflow.mjs reserves for PAUSED. The source `.mcp.json` is
// read-only here: nothing in this file may ever rewrite it.

import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cmdMcpInstall } from "../src/commands/mcp.mjs";

const exec = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "adlc-cli.mjs");

// Minimal project sandbox (same shape as tests/mcp-install.test.mjs).
function project() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-mcp-command-"));
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

const CONTEXT7 = {
  command: "npx",
  args: ["-y", "@upstash/context7-mcp"],
  env: { TOKEN: "${GITLAB_TOKEN}" },
};
const GITLAB = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-gitlab"],
  env: { GITLAB_TOKEN: "${GITLAB_TOKEN}" },
};
const withServers = (servers) => JSON.stringify({ mcpServers: servers }, null, 2);

// ── The brief's contract tests (titles verbatim) ─────────────────────────

it("refuses loudly when team-setup has not run: no init-options and no --agent", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], {}));
    assert.equal(code, 1);
    assert.match(stderr, /team-setup has not run/);
    assert.match(stderr, /init-options\.json/);
    assert.match(stderr, /--agent/);
    assert.equal(stdout, "");
  } finally {
    p.cleanup();
  }
});

it("reports 'nothing to install' and exits 0 when .mcp.json is absent", async () => {
  const p = project();
  try {
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 0);
    assert.match(stdout, /nothing to install/);
    // gap report warnings live on stderr now (no team source configured here)
    assert.match(stderr, /team MCP source unavailable/);
  } finally {
    p.cleanup();
  }
});

it("a named agent with no adapter fails and lists the servers by hand", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7, gitlab: GITLAB }));
    const { code, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["gemini"] }));
    assert.equal(code, 1); // not 3 -- 3 is PAUSED
    assert.match(stderr, /add these servers by hand/);
    assert.match(stderr, /gemini/);
    assert.match(stderr, /target file/);
    assert.match(stderr, /context7/);
    assert.match(stderr, /gitlab/);
  } finally {
    p.cleanup();
  }
});

it("exits 0 when every named agent is configured", async () => {
  const p = project();
  try {
    const source = withServers({ context7: CONTEXT7 });
    p.write(".mcp.json", source);
    const { code, stdout, stderr } = await capture(() =>
      cmdMcpInstall([p.dir], { agents: ["opencode", "cursor"] }));
    assert.equal(code, 0);
    // gap report warnings live on stderr now (no team source configured here)
    assert.match(stderr, /team MCP source unavailable/);
    assert.ok(!stdout.includes("MCP gap"));

    const oc = JSON.parse(p.read("opencode.json"));
    assert.deepEqual(oc.mcp.context7, {
      type: "local",
      enabled: true,
      command: ["npx", "-y", "@upstash/context7-mcp"],
      environment: { TOKEN: "{env:GITLAB_TOKEN}" },
    });
    const cur = JSON.parse(p.read(".cursor/mcp.json"));
    assert.deepEqual(cur.mcpServers.context7, {
      type: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { TOKEN: "${env:GITLAB_TOKEN}" },
    });

    assert.equal(p.read(".mcp.json"), source); // the source is never rewritten
    assert.match(stdout, /opencode\.json/);
    assert.match(stdout, /\.cursor\/mcp\.json/);
    assert.equal(p.exists(".codex"), false); // agents never named are out of scope
  } finally {
    p.cleanup();
  }
});

it("exits 1 when one of several named agents cannot be delivered", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7, gitlab: GITLAB }));
    const { code, stderr } = await capture(() =>
      cmdMcpInstall([p.dir], { agents: ["opencode", "gemini"] }));
    assert.equal(code, 1);
    assert.ok(p.exists("opencode.json")); // what can be delivered still is
    assert.match(stderr, /add these servers by hand/);
    assert.match(stderr, /gemini/);
  } finally {
    p.cleanup();
  }
});

// ── The rulings that settle the brief's ambiguities ─────────────────────

it("a refused server fails the run and is named for hand-install", async () => {
  // Ruling 1: errors OR a per-server refusal fail the run — a named agent
  // would start without that server. A ${VAR} inside a codex url is the
  // plan's headline refusal (codex does no substitution). The delivered
  // server carries no env: codex inherits whole names only, and a renamed
  // one is a refusal of its own (Task 2).
  const p = project();
  try {
    p.write(".mcp.json", withServers({
      docs: { type: "http", url: "https://docs.example/${TENANT}/mcp" },
      plain: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    }));
    const { code, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["codex"] }));
    assert.equal(code, 1);
    assert.match(stderr, /add these servers by hand/);
    assert.match(stderr, /\.codex\/config\.toml/); // the target file is named
    assert.match(stderr, /docs/);
    assert.match(stderr, /refused/);
    assert.doesNotMatch(stderr, /plain/); // delivered servers are not listed by hand
  } finally {
    p.cleanup();
  }
});

it("a target-level error fails the run and leaves the file untouched", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const broken = '{\n  // not plain JSON\n}\n';
    p.write("opencode.json", broken);
    const { code, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 1);
    assert.match(stderr, /not plain JSON/);
    assert.match(stderr, /add these servers by hand/);
    assert.match(stderr, /opencode\.json/); // the target file is named
    assert.equal(p.read("opencode.json"), broken); // left untouched
  } finally {
    p.cleanup();
  }
});

it("claude-code is a no-op success and .mcp.json is never rewritten", async () => {
  const p = project();
  try {
    const source = withServers({ context7: CONTEXT7 });
    p.write(".mcp.json", source);
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["claude"] }));
    assert.equal(code, 0);
    // gap report warnings live on stderr now (no team source configured here)
    assert.match(stderr, /team MCP source unavailable/);
    assert.equal(p.read(".mcp.json"), source);
    assert.match(stdout, /kept/);
  } finally {
    p.cleanup();
  }
});

it("falls back to the agent recorded by team-setup when no --agent is given", async () => {
  const p = project();
  try {
    p.write(".adlc/init-options.json", JSON.stringify({ agent: "opencode" }));
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const { code } = await capture(() => cmdMcpInstall([p.dir], {}));
    assert.equal(code, 0);
    assert.ok(p.exists("opencode.json"));
  } finally {
    p.cleanup();
  }
});

it("--agent wins over the agent recorded in init-options", async () => {
  const p = project();
  try {
    p.write(".adlc/init-options.json", JSON.stringify({ agent: "cursor" }));
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const { code } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 0);
    assert.ok(p.exists("opencode.json"));
    assert.equal(p.exists(".cursor/mcp.json"), false);
  } finally {
    p.cleanup();
  }
});

it("fails the precondition when init-options records no agent and no --agent is given", async () => {
  const p = project();
  try {
    p.write(".adlc/init-options.json", JSON.stringify({ skills_source: "tikalk/x" }));
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const { code, stderr } = await capture(() => cmdMcpInstall([p.dir], {}));
    assert.equal(code, 1);
    assert.match(stderr, /init-options\.json/);
    assert.match(stderr, /--agent/);
  } finally {
    p.cleanup();
  }
});

it("the precondition comes first: no .mcp.json and no agent is a loud failure, not a silent no-op", async () => {
  // Rulings 3 and 4 collide when BOTH the source and the agent are absent.
  // Resolved: the precondition (who to configure) gates the source read —
  // "never silently doing nothing" (PDR-139). Ruling 4's no-op applies once
  // an agent is named.
  const p = project();
  try {
    const { code, stderr } = await capture(() => cmdMcpInstall([p.dir], {}));
    assert.equal(code, 1);
    assert.match(stderr, /team-setup has not run/);
  } finally {
    p.cleanup();
  }
});

it("a .mcp.json that declares no servers reports 'nothing to install' and exits 0", async () => {
  // Lenient source validation (design, settled decision 4): unknown
  // top-level keys — the team file ships a "tools" block — are never an
  // error; only `mcpServers` is translated.
  const p = project();
  try {
    p.write(".mcp.json", JSON.stringify({ tools: { github: { type: "github" } } }, null, 2));
    const { code, stdout, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 0);
    assert.match(stdout, /nothing to install/);
    // gap report warnings live on stderr now (no team source configured here)
    assert.match(stderr, /team MCP source unavailable/);
  } finally {
    p.cleanup();
  }
});

it("an unparseable .mcp.json fails the run instead of installing nothing", async () => {
  const p = project();
  try {
    p.write(".mcp.json", "{ // not plain JSON\n");
    const { code, stderr } = await capture(() => cmdMcpInstall([p.dir], { agents: ["opencode"] }));
    assert.equal(code, 1);
    assert.match(stderr, /not plain JSON/);
  } finally {
    p.cleanup();
  }
});

// ── Dispatch wiring (the CLI surface, not just the function) ────────────

it("dispatch: adlc-cli mcp install routes to the command and exits with its code", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const r = await exec(process.execPath, [BIN, "mcp", "install", p.dir, "-a", "opencode"]).catch((e) => e);
    assert.equal(r.code ?? r.exitCode ?? 0, 0);
    assert.ok(p.exists("opencode.json"));
  } finally {
    p.cleanup();
  }
});

it("dispatch: --agents names agents exactly like --agent", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const r = await exec(process.execPath, [BIN, "mcp", "install", p.dir, "--agents", "cursor"]).catch((e) => e);
    assert.equal(r.code ?? r.exitCode ?? 0, 0);
    assert.ok(p.exists(".cursor/mcp.json"));
  } finally {
    p.cleanup();
  }
});

it("dispatch: DIR defaults to the current working directory", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const r = await exec(process.execPath, [BIN, "mcp", "install", "-a", "opencode"], { cwd: p.dir }).catch((e) => e);
    assert.equal(r.code ?? r.exitCode ?? 0, 0);
    assert.ok(p.exists("opencode.json"));
  } finally {
    p.cleanup();
  }
});

it("dispatch: the precondition failure surfaces as exit 1, never 3", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ context7: CONTEXT7 }));
    const r = await exec(process.execPath, [BIN, "mcp", "install", p.dir]).catch((e) => e);
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr), /team-setup has not run/);
  } finally {
    p.cleanup();
  }
});

it("dispatch: mcp help prints usage and an unknown subcommand exits 1", async () => {
  const help = await exec(process.execPath, [BIN, "mcp", "help"]).catch((e) => e);
  assert.equal(help.code ?? help.exitCode ?? 0, 0);
  assert.match(String(help.stdout), /mcp install/);

  const bogus = await exec(process.execPath, [BIN, "mcp", "bogus"]).catch((e) => e);
  assert.equal(bogus.code ?? bogus.exitCode, 1);
  assert.match(String(bogus.stderr ?? bogus.stdout ?? bogus.message), /Unknown mcp command/i);
});
