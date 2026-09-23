// Workspace command contract: setup (profile resolution, dry-run plan), init/status prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const BIN = new URL("../bin/adlc-cli.mjs", import.meta.url).pathname;
const run = (args, cwd) =>
  exec(process.execPath, [BIN, ...args], { cwd }).catch((e) => e);

const PROFILE = `schema_version: "1.0"
name: "Test Workspace"
version: "1.0.0"
agent: opencode

workspace:
  git:
    - repo: https://github.com/org/backend
      path: backend
      branch: main
  link: true
  init: true

skills:
  sources:
    - tikalk/adlc-team-skills

goal: "Run /team-setup to configure team-ai-directives for this project"

commands:
  - skills add tikalk/adlc-team-skills
  - team setup tikalk/adlc-team-skills
  - agent run "Fetch and follow instructions from https://example.com/INSTALL.md"
`;

function makeTempWorkspace(profile = PROFILE) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "workspace-profile.yml"), profile, "utf-8");
  return dir;
}

test("setup --dry-run prints the full plan without executing", async () => {
  const dir = makeTempWorkspace();
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.match(r.stdout, /Test Workspace/);
    assert.match(r.stdout, /git clone https:\/\/github\.com\/org\/backend backend --branch main/);
    assert.match(r.stdout, /workspace init \+ link \(agent-led\)/);
    assert.match(r.stdout, /Run \/workspace --init --link/);
    assert.match(r.stdout, /skills add tikalk\/adlc-team-skills/);
    assert.match(r.stdout, /agent run "Fetch and follow instructions from https:\/\/example\.com\/INSTALL\.md"/);
    assert.match(r.stdout, /goal \(agent-led\)/);
    assert.match(r.stdout, /Run \/team-setup to configure team-ai-directives/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup errors when no profile exists anywhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.notEqual(r.code, 0);
    assert.match(String(r.message ?? r.stderr), /no workspace profile found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup errors on profile missing schema_version", async () => {
  const dir = makeTempWorkspace("name: broken\nagent: opencode\n");
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.notEqual(r.code, 0);
    assert.match(String(r.message ?? r.stderr), /schema_version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup skips clone when target path already exists (idempotent)", async () => {
  const dir = makeTempWorkspace();
  mkdirSync(join(dir, "backend")); // pre-existing repo dir
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.match(r.stdout, /= backend \(exists, skipping clone\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --dry-run prints the agent-run invocation", async () => {
  const r = await run(["workspace", "init", "-a", "opencode", "--link", "--dry-run"]);
  assert.equal(r.code ?? 0, 0);
  assert.match(r.stdout, /agent run -a opencode "Run \/workspace --init --link"/);
});

test("status --dry-run prints the agent-run invocation", async () => {
  const r = await run(["workspace", "status", "-a", "opencode", "--dry-run"]);
  assert.equal(r.code ?? 0, 0);
  assert.match(r.stdout, /agent run -a opencode "Run \/workspace --status"/);
});

test("unknown workspace subcommand exits 1 with usage", async () => {
  const r = await run(["workspace", "bogus"]);
  assert.notEqual(r.code, 0);
  assert.match(String(r.message ?? r.stdout), /Unknown workspace command/);
});

test("top-level `run` is a compat alias for agent run (runtime contract)", async () => {
  const r = await run(["run"]); // no task → agent-run arg error, not help
  assert.notEqual(r.code, 0);
  assert.match(String(r.message ?? r.stderr), /task is required/);
});

test("workspace help lists setup, init, status", async () => {
  const r = await run(["workspace", "help"]);
  assert.match(r.stdout, /setup \[profile\]/);
  assert.match(r.stdout, /init/);
  assert.match(r.stdout, /status/);
});
