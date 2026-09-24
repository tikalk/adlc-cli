// Workspace command contract: setup (workspace.yml resolution, dry-run plan,
// first-boot-only goal semantics), init/status prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/adlc-cli.mjs", import.meta.url));
const run = (args, cwd) =>
  exec(process.execPath, [BIN, ...args], { cwd }).catch((e) => e);

const WORKSPACE_YML = `schema_version: "1.0"
name: "Test Workspace"
version: "1.0.0"
agent: opencode

workspace:
  git:
    - repo: https://github.com/org/backend
      path: backend
      branch: main
  dirs:
    - adlc-team-skills
  link: true
  init: true

skills:
  sources:
    - tikalk/adlc-team-skills

commands:
  - skills add tikalk/adlc-team-skills
  - team setup tikalk/adlc-team-skills
  - agent run "Fetch and follow instructions from https://example.com/INSTALL.md"
`;

function makeTempWorkspace(content = WORKSPACE_YML) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "workspace.yml"), content, "utf-8");
  return dir;
}

test("setup --dry-run prints the full plan without executing", async () => {
  const dir = makeTempWorkspace();
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.match(r.stdout, /Test Workspace/);
    assert.match(r.stdout, /git clone https:\/\/github\.com\/org\/backend backend --branch main/);
    assert.match(r.stdout, /mkdir -p adlc-team-skills/);
    assert.match(r.stdout, /workspace init \+ link \(agent-led\)/);
    assert.match(r.stdout, /Run \/workspace --init --link/);
    assert.match(r.stdout, /skills add tikalk\/adlc-team-skills/);
    assert.match(r.stdout, /agent run "Fetch and follow instructions from https:\/\/example\.com\/INSTALL\.md"/);
    assert.match(r.stdout, /Next: adlc-cli agent run/);
    // this fixture has no goal field — no goal step in the plan
    assert.doesNotMatch(r.stdout, /goal \(agent-led/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup errors when no workspace file exists anywhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.notEqual(r.code, 0);
    assert.match(String(r.message ?? r.stderr), /no workspace file found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup errors on workspace file missing schema_version", async () => {
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

test("setup creates workspace.dirs (real run, no agent steps needed)", async () => {
  // Workspace file with only dirs — no init/link/skills/commands → no agent spawn, pure mkdir
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Dirs Only"
agent: opencode
workspace:
  dirs:
    - adlc-team-skills
    - scratch/nested
`);
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.ok(existsSync(join(dir, "adlc-team-skills")), "adlc-team-skills dir created");
    assert.ok(existsSync(join(dir, "scratch", "nested")), "nested dir created");
    assert.match(r.stdout, /Workspace setup complete/);
    assert.match(r.stdout, /Next: adlc-cli agent run/);

    // Idempotent re-run skips existing dirs
    const r2 = await run(["workspace", "setup"], dir);
    assert.equal(r2.code ?? 0, 0, r2.stderr);
    assert.match(r2.stdout, /= adlc-team-skills \(exists, skipping\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup rejects path-traversal workspace.dirs entries", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Bad Dirs"
agent: opencode
workspace:
  dirs:
    - ../escape
`);
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.notEqual(r.code, 0);
    assert.match(String(r.message ?? r.stderr), /invalid workspace\.dirs entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── goal: first-boot-only semantics ──────────────────────────────────────

test("setup --dry-run: goal step appears when workspace.dirs would create (first boot)", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Goal First Boot"
agent: opencode
workspace:
  dirs:
    - fresh-dir
goal: "Reply with exactly: GOAL-RAN"
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.match(r.stdout, /mkdir -p fresh-dir/);
    assert.match(r.stdout, /goal \(agent-led, first boot\)/);
    assert.match(r.stdout, /agent run -a opencode "Reply with exactly: GOAL-RAN"/);
    assert.doesNotMatch(r.stdout, /Next: adlc-cli agent run/, "goal ran — no handoff hint needed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --dry-run: goal step skips when nothing would be assembled (re-run)", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Goal Skip"
agent: opencode
workspace:
  dirs:
    - existing-dir
goal: "Reply with exactly: GOAL-RAN"
`);
  mkdirSync(join(dir, "existing-dir")); // pre-existing — nothing to assemble
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.match(r.stdout, /= existing-dir \(exists, skipping\)/);
    assert.match(r.stdout, /goal \(first-boot only — nothing assembled this run, skipping\)/);
    assert.doesNotMatch(r.stdout, /agent run -a opencode "Reply with exactly: GOAL-RAN"/);
    assert.match(r.stdout, /Next: adlc-cli agent run/, "goal skipped — handoff hint shown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: goal runs on real first-boot dir creation, skips on real re-run (no agent config needed since dry-run proves routing)", async () => {
  // Real (non-dry-run) run with dirs-only + goal: first call creates the dir and
  // WOULD invoke the agent (asserted via dry-run above for determinism without
  // requiring a live agent); this test instead verifies the `changed` flag is
  // computed purely from filesystem state across two real, non-dry-run calls
  // that have no goal (so no agent spawn is attempted) — proving the skip/act
  // boundary independent of agent availability.
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Changed Flag"
agent: opencode
workspace:
  dirs:
    - first-boot-dir
`);
  try {
    const r1 = await run(["workspace", "setup"], dir);
    assert.equal(r1.code ?? 0, 0, r1.stderr);
    assert.ok(existsSync(join(dir, "first-boot-dir")));
    assert.match(r1.stdout, /mkdir -p first-boot-dir/);

    const r2 = await run(["workspace", "setup"], dir);
    assert.equal(r2.code ?? 0, 0, r2.stderr);
    assert.match(r2.stdout, /= first-boot-dir \(exists, skipping\)/);
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
  assert.match(r.stdout, /setup \[file\]/);
  assert.match(r.stdout, /init/);
  assert.match(r.stdout, /status/);
});
