// tests/team-mcp-chain.test.mjs — `team setup` / `team update` chain
// `mcp install` (Task 6): the agent's MCP servers are configured before its
// session starts, and an MCP failure aborts the command with exit 1 (ruling
// 1a) — never 3, which workflow.mjs reserves for PAUSED.
//
// The units under test (team commands, chainMcpInstall, cmdMcpInstall,
// installForAgent) run for real against temp-dir fixtures. Two external
// boundaries are stubbed the way the codebase already stubs them: the
// `npx skills` installer (a PATH stub — cmdUpdate's pull loop must not hit
// the network in tests) and the agent binary (the ADLC_MOCK_AGENT seam from
// workspace.test.mjs, which doubles as the "agent session never reached"
// observable: cmdAgentRun appends to the stub file iff it is entered).

import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { chainMcpInstall } from "../src/commands/team.mjs";

const exec = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "adlc-cli.mjs");
const run = (args, { cwd, env } = {}) =>
  exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env } }).catch((e) => e);

// Minimal project sandbox (same shape as tests/mcp-command.test.mjs).
function project() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-team-mcp-chain-"));
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
// codex does no substitution: ${TENANT} inside a url is the plan's headline
// refusal — codex would start the agent without that server.
const TENANT_URL = { type: "http", url: "https://docs.example/${TENANT}/mcp" };
// codex (env-vars syntax) inherits whole env names unchanged — own-name
// whole vars are expressible, renames are not.
const CODEX_OK = {
  command: "npx",
  args: ["-y", "@upstash/context7-mcp"],
  env: { GITLAB_TOKEN: "${GITLAB_TOKEN}" },
};
// An entry with neither command nor url is unstartable and refused by every
// target — the one refusal shape that does not depend on the agent's
// var syntax (used for the opencode setup test).
const UNSTARTABLE = {};
const withServers = (servers) => JSON.stringify({ mcpServers: servers }, null, 2);

// ── chainMcpInstall (unit: the thin helper, real cmdMcpInstall beneath) ──

it("chain: no .mcp.json → exit 0 and the gap report still prints (ruling 3)", async () => {
  const p = project();
  try {
    const { code, stdout, stderr } = await capture(() =>
      chainMcpInstall(p.dir, "opencode", "team update"));
    assert.equal(code, 0);
    assert.match(stdout, /nothing to install/);
    // the copy-once gap report is not special-cased away in the chained context
    assert.match(stderr, /team MCP source unavailable/);
  } finally {
    p.cleanup();
  }
});

it("chain: valid .mcp.json + opencode → writes opencode.json, exit 0", async () => {
  const p = project();
  try {
    const source = withServers({ context7: CONTEXT7 });
    p.write(".mcp.json", source);
    const { code } = await capture(() => chainMcpInstall(p.dir, "opencode", "team setup"));
    assert.equal(code, 0);
    const oc = JSON.parse(p.read("opencode.json"));
    assert.deepEqual(oc.mcp.context7, {
      type: "local",
      enabled: true,
      command: ["npx", "-y", "@upstash/context7-mcp"],
      environment: { TOKEN: "{env:GITLAB_TOKEN}" },
    });
    assert.equal(p.read(".mcp.json"), source); // the source is never rewritten
  } finally {
    p.cleanup();
  }
});

it("chain: a refused server → exit 1 with 'aborting <label>' (ruling 1a)", async () => {
  const p = project();
  try {
    p.write(".mcp.json", withServers({ docs: TENANT_URL }));
    const { code, stderr } = await capture(() =>
      chainMcpInstall(p.dir, "codex", "team update"));
    assert.equal(code, 1); // never 3
    assert.match(stderr, /aborting team update/);
    assert.match(stderr, /refused/);
  } finally {
    p.cleanup();
  }
});

it("chain: corrupt .mcp.json → exit 1 with 'aborting <label>'", async () => {
  const p = project();
  try {
    p.write(".mcp.json", "{ // not plain JSON\n");
    const { code, stderr } = await capture(() =>
      chainMcpInstall(p.dir, "opencode", "team setup"));
    assert.equal(code, 1);
    assert.match(stderr, /not plain JSON/);
    assert.match(stderr, /aborting team setup/);
  } finally {
    p.cleanup();
  }
});

// ── cmdTeamUpdate (integration: the full flow, offline) ──────────────────

// A full `team update` sandbox: real local git repos (so `git pull` succeeds
// offline), a PATH-stubbed `npx` (cmdUpdate's pull loop must not hit the
// network), a stub setup-team.sh at the path cmdTeamRepair resolves (it
// touches a marker file, so reaching repair is observable), and the
// project's .mcp.json under test.
function makeUpdateProject(mcpJson) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-team-mcp-chain-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  // Local origin with one commit, cloned as the team-ai-directives repo:
  // the clone has an upstream that is up to date → `git pull` exits 0.
  const origin = join(dir, "origin.git");
  git(["init", "--bare", origin]);
  const seed = join(dir, "seed");
  git(["init", seed]);
  writeFileSync(join(seed, "README.md"), "team-ai-directives\n", "utf-8");
  git(["-C", seed, "add", "."]);
  git(["-C", seed, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "seed"]);
  git(["-C", seed, "push", origin, "HEAD:refs/heads/main"]);
  const teamDir = join(dir, "team-ai-directives");
  git(["clone", "--branch", "main", origin, teamDir]);

  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "init-options.json"), JSON.stringify({
    agent: "codex",
    skills_source: "tikalk/adlc-team-skills",
    team_ai_directives: teamDir,
  }, null, 2), "utf-8");

  // PATH stub for the external installer boundary — everything the test
  // asserts on (the MCP chain) runs for real underneath.
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const npx = join(bin, "npx");
  writeFileSync(npx, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(npx, 0o755);

  // The repair stub: cmdTeamRepair's second candidate path, resolved from
  // the CLI's cwd (the temp project). Touching .repair-ran is the signal.
  const script = join(dir, ".agents", "skills", "team-repair", "scripts", "bash", "setup-team.sh");
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, "#!/bin/sh\ntouch .repair-ran\nexit 0\n", "utf-8");

  if (mcpJson !== undefined) writeFileSync(join(dir, ".mcp.json"), mcpJson, "utf-8");

  return {
    dir,
    read: (rel) => readFileSync(join(dir, rel), "utf-8"),
    marker: join(dir, ".repair-ran"),
    env: { PATH: `${bin}${delimiter}${process.env.PATH}` },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

it("team update: chains mcp install before repair (success path)", async () => {
  const f = makeUpdateProject(withServers({ context7: CODEX_OK }));
  try {
    const r = await run(["team", "update", "-a", "codex"], { cwd: f.dir, env: f.env });
    assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
    // the agent's MCP config was written by the chained install
    const toml = f.read(".codex/config.toml");
    assert.match(toml, /mcp_servers\.context7/);
    assert.match(toml, /GITLAB_TOKEN/);
    // repair ran (the chained install did not block the happy path)
    assert.ok(existsSync(f.marker), "repair ran");
  } finally {
    f.cleanup();
  }
});

it("team update: MCP failure aborts with exit 1 and repair is never reached", async () => {
  const f = makeUpdateProject(withServers({ docs: TENANT_URL }));
  try {
    const r = await run(["team", "update", "-a", "codex"], { cwd: f.dir, env: f.env });
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? ""), /aborting team update/);
    assert.equal(existsSync(f.marker), false, "repair must not run after an MCP failure");
  } finally {
    f.cleanup();
  }
});

// ── cmdTeamSetup (integration: failure path only — the success path ends
//    in an agent session, which tests must not spawn for real) ────────────

it("team setup: MCP failure aborts with exit 1 before the agent session starts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-team-mcp-chain-"));
  // The ADLC_MOCK_AGENT seam (same as tests/workspace.test.mjs): cmdAgentRun
  // appends a line to the stub file iff it is entered. The file's absence is
  // the real observable that the agent session was never reached — the
  // agent binary is the external boundary, stubbed by the product's own
  // e2e seam; everything under test here runs for real.
  const stubFile = join(dir, "mock-agent.log");
  try {
    writeFileSync(join(dir, ".mcp.json"), withServers({ broken: UNSTARTABLE }), "utf-8");
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "-a", "opencode", "--skip-skills"],
      { cwd: dir, env: { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: stubFile } },
    );
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? ""), /aborting team setup/);
    assert.equal(existsSync(stubFile), false, "the agent session must not start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
