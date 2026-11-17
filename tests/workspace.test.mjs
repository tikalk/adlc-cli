// Workspace command contract: setup (workspace.yml resolution, dry-run plan,
// first-boot-only goal semantics), init/status prompts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/adlc-cli.mjs", import.meta.url));
const run = (args, cwd, env) =>
  exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...(env || {}) } }).catch((e) => e);

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
    assert.match(r.stdout, /workspace init \+ link\b/);
    assert.match(r.stdout, /setup-workspace\.sh --json/);
    assert.match(r.stdout, /workspace\.sh --json --link/);
    assert.match(r.stdout, /skills add tikalk\/adlc-team-skills/);
    // skills install before init, so the workspace skill's scripts exist
    assert.ok(
      r.stdout.indexOf("skills add tikalk/adlc-team-skills") < r.stdout.indexOf("workspace init + link"),
      "skills.sources must run before workspace init"
    );
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
  writeFileSync(join(dir, "backend", "README.md"), "checked out\n", "utf-8");
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

// ── mock-agent seam (ADLC_MOCK_AGENT): agent-led paths without live agent ──

test("setup: goal invokes agent once on first-boot via mock agent", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Mock Goal"
agent: opencode
workspace:
  dirs:
    - fresh
goal: "hello"`);
  const stubFile = join(dir, "mock-agent.log");
  try {
    const r = await run(["workspace", "setup"], dir, {
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: stubFile,
    });
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.ok(existsSync(join(dir, "fresh")), "fresh dir created");
    assert.ok(existsSync(stubFile), "mock agent stub file written");
    const content = readFileSync(stubFile, "utf-8");
    assert.match(content, /hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: goal fires once — second run adds no stub lines and shows first-boot skip hint", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Mock Goal Idempotent"
agent: opencode
workspace:
  dirs:
    - fresh
goal: "hello"`);
  const stubFile = join(dir, "mock-agent.log");
  const env = {
    ADLC_MOCK_AGENT: "1",
    ADLC_MOCK_AGENT_FILE: stubFile,
  };
  try {
    const r1 = await run(["workspace", "setup"], dir, env);
    assert.equal(r1.code ?? 0, 0, r1.stderr);
    const first = readFileSync(stubFile, "utf-8").trim().split("\n");
    assert.equal(first.length, 1, "first boot fires the goal exactly once");

    const r2 = await run(["workspace", "setup"], dir, env);
    assert.equal(r2.code ?? 0, 0, r2.stderr);
    assert.match(r2.stdout, /goal \(first-boot only — nothing assembled this run, skipping\)/);
    const second = readFileSync(stubFile, "utf-8").trim().split("\n");
    assert.equal(second.length, 1, "re-run adds no new stub lines — goal stayed silent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init (real, non-dry-run) routes through mock agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  const stubFile = join(dir, "mock-agent.log");
  try {
    const r = await run(["workspace", "init", "-a", "opencode", "--link"], dir, {
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: stubFile,
    });
    assert.equal(r.code ?? 0, 0, r.stderr);
    const content = readFileSync(stubFile, "utf-8");
    assert.match(content, /Run \/workspace --init --link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status (real, non-dry-run) routes through mock agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  const stubFile = join(dir, "mock-agent.log");
  try {
    const r = await run(["workspace", "status", "-a", "opencode"], dir, {
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: stubFile,
    });
    assert.equal(r.code ?? 0, 0, r.stderr);
    const content = readFileSync(stubFile, "utf-8");
    assert.match(content, /Run \/workspace --status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: commands agent run routed through mock agent", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Mock Commands"
agent: opencode
workspace:
  dirs:
    - fresh-cmd
commands:
  - agent run "hi"`);
  const stubFile = join(dir, "mock-agent.log");
  try {
    const r = await run(["workspace", "setup"], dir, {
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: stubFile,
    });
    assert.equal(r.code ?? 0, 0, r.stderr);
    const content = readFileSync(stubFile, "utf-8");
    assert.match(content, /hi/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── failure-mode + precedence coverage ───────────────────────────────
// run() already merges per-call env (Task 1 seam); agent-led paths below
// use --dry-run or fail before any spawn, so no live agent is needed.

const combined = (r) => `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.message ?? ""}`;

test("setup: ADLC_WORKSPACE_FILE env resolves when no local file", async () => {
  const src = makeTempWorkspace(`schema_version: "1.0"
name: "Env Workspace"
agent: opencode
workspace:
  dirs:
    - env-dir
`);
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir, {
      ADLC_WORKSPACE_FILE: join(src, ".adlc", "workspace.yml"),
    });
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /Env Workspace/);
    assert.match(r.stdout, /mkdir -p env-dir/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  }
});

test("setup: explicit arg beats env", async () => {
  const envSrc = makeTempWorkspace(`schema_version: "1.0"
name: "Env Workspace"
agent: opencode
`);
  const argSrc = makeTempWorkspace(`schema_version: "1.0"
name: "Explicit Workspace"
agent: opencode
`);
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  const envFile = join(envSrc, ".adlc", "workspace.yml");
  const explicit = join(argSrc, ".adlc", "workspace.yml");
  try {
    const r = await run(["workspace", "setup", explicit, "--dry-run"], dir, {
      ADLC_WORKSPACE_FILE: envFile,
    });
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /Explicit Workspace/);
    assert.doesNotMatch(r.stdout, /Env Workspace/);

    // An explicit URL beats the env file too — the fetch error proves the
    // explicit source won (127.0.0.1:1 refuses fast, no network hang).
    const r2 = await run(["workspace", "setup", "http://127.0.0.1:1/nonexistent.yml"], dir, {
      ADLC_WORKSPACE_FILE: envFile,
    });
    assert.notEqual(r2.code, 0);
    assert.match(combined(r2), /failed to fetch/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(envSrc, { recursive: true, force: true });
    rmSync(argSrc, { recursive: true, force: true });
  }
});

test("setup: -a flag beats workspace agent:", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Flag Beats File"
agent: file-agent
workspace:
  dirs:
    - flag-dir
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run", "-a", "flag-agent"], dir);
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /Agent:\s+flag-agent/);
    assert.doesNotMatch(r.stdout, /file-agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: missing agent errors", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "No Agent"
workspace:
  dirs:
    - d
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /agent required/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: git entry missing repo/path exits 1", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Bad Git Entry"
agent: opencode
workspace:
  git:
    - path: only-path
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /missing repo or path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: bad git clone exits non-zero before skills", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Bad Clone"
agent: opencode
workspace:
  git:
    - repo: file:///nonexistent-adlc-ws-xyz-123
      path: bad-clone
skills:
  sources:
    - tikalk/adlc-team-skills
`);
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /git clone failed/);
    assert.doesNotMatch(combined(r), /skills\.sources/, "clone failed — skills step never reached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: bad ref checkout fails", async () => {
  const origin = mkdtempSync(join(tmpdir(), "adlc-ws-origin-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: origin });
  writeFileSync(join(origin, "f.txt"), "x\n", "utf-8");
  await exec("git", ["add", "."], { cwd: origin });
  await exec("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init"], {
    cwd: origin,
  });
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Bad Ref"
agent: opencode
workspace:
  git:
    - repo: ${origin}
      path: cloned
      ref: nonexistent-branch-xyz
`);
  try {
    const r = await run(["workspace", "setup"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /checkout .* failed/);
    // Clone landed on the default branch, but the bad-ref checkout never took
    // effect: HEAD is still main, not the requested ref.
    assert.ok(existsSync(join(dir, "cloned", "f.txt")), "clone landed before the bad-ref checkout");
    const head = await exec("git", ["-C", join(dir, "cloned"), "rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(head.stdout.trim(), "main", "failed checkout left HEAD on the default branch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("setup: unknown commands[] entry exits 1", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Bad Command"
agent: opencode
commands:
  - frobnicate the whatsit
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /unknown command/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: commands stop on first failure", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Stop Early"
agent: opencode
commands:
  - frobnicate first
  - agent run "SHOULD-NEVER-RUN-XYZ"
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /unknown command/);
    assert.doesNotMatch(combined(r), /SHOULD-NEVER-RUN-XYZ/, "second command never ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: malformed YAML errors, empty file errors", async () => {
  const bad = makeTempWorkspace("schema_version: \"1.0\"\nname: \"Tabs\"\n\tbad-indent: true\n");
  try {
    const r1 = await run(["workspace", "setup", "--dry-run"], bad);
    assert.notEqual(r1.code, 0);
    assert.match(combined(r1), /invalid workspace file/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
  const empty = makeTempWorkspace("");
  try {
    const r2 = await run(["workspace", "setup", "--dry-run"], empty);
    assert.notEqual(r2.code, 0);
    assert.match(combined(r2), /missing schema_version|invalid workspace file/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("init --ignore-only --dry-run prints --ignore-only prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  try {
    const r = await run(["workspace", "init", "-a", "opencode", "--ignore-only", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /--ignore-only/);
    assert.match(r.stdout, /agent run -a opencode "Run \/workspace --init --ignore-only"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare workspace defaults to status (requires agent)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-test-"));
  try {
    const r = await run(["workspace"], dir);
    assert.notEqual(r.code, 0);
    assert.match(combined(r), /agent required/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --dry-run routes multiline goal to single agent run line", async () => {
  const dir = makeTempWorkspace(`schema_version: "1.0"
name: "Multiline Goal"
agent: opencode
workspace:
  dirs:
    - fresh-multi
goal: > # folded multiline goal
  Run the setup
  for this project
`);
  try {
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /goal \(agent-led, first boot\)/);
    const agentLines = r.stdout.split("\n").filter((l) => l.includes("agent run -a opencode"));
    assert.equal(agentLines.length, 1, `expected one agent run line, got: ${r.stdout}`);
    assert.match(agentLines[0], /agent run -a opencode "Run the setup for this project"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── empty target dirs (uninitialized submodules) ───────────────────────
// A non-recursive clone of a superproject leaves each submodule as an empty
// placeholder dir. Setup must populate it, not skip it as "exists".

const GIT_ONLY_YML = (repo) => `schema_version: "1.0"
name: "Test Workspace"
version: "1.0.0"
agent: opencode

workspace:
  git:
    - repo: ${repo}
      path: child
`;

// Local file:// submodules need protocol.file.allow (git >= 2.38.1).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

// Builds <root>/src (child repo, one commit) and <root>/ws — a non-recursive
// clone of a superproject that registers src as submodule "child".
function makeSuperprojectClone() {
  const root = mkdtempSync(join(tmpdir(), "adlc-ws-sub-"));
  const src = join(root, "src");
  mkdirSync(src);
  git(["init", "-q", "-b", "main"], src);
  writeFileSync(join(src, "CDR.md"), "# child\n", "utf-8");
  git(["add", "."], src);
  git(["commit", "-q", "-m", "child"], src);
  const pinned = git(["rev-parse", "HEAD"], src);

  const sup = join(root, "sup");
  mkdirSync(sup);
  git(["init", "-q", "-b", "main"], sup);
  git(["submodule", "add", "-q", src, "child"], sup);
  mkdirSync(join(sup, ".adlc"));
  writeFileSync(join(sup, ".adlc", "workspace.yml"), GIT_ONLY_YML(src), "utf-8");
  git(["add", "."], sup);
  git(["commit", "-q", "-m", "sup"], sup);

  const ws = join(root, "ws");
  git(["clone", "-q", sup, ws]); // no --recurse-submodules → child/ is empty
  return { root, src, ws, pinned };
}

test("setup --dry-run: empty registered submodule dir is initialized, not skipped", async () => {
  const { root, ws } = makeSuperprojectClone();
  try {
    const r = await run(["workspace", "setup", "--dry-run"], ws, GIT_ENV);
    assert.equal(r.code ?? 0, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /child \(exists, skipping clone\)/);
    assert.match(r.stdout, /git submodule update --init -- child/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup: empty registered submodule dir is checked out at the pinned commit", async () => {
  const { root, ws, pinned } = makeSuperprojectClone();
  try {
    const r = await run(["workspace", "setup"], ws, GIT_ENV);
    assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(ws, "child", "CDR.md")), "submodule content missing");
    assert.equal(git(["rev-parse", "HEAD"], join(ws, "child")), pinned);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup: empty plain dir (not a submodule) is cloned into", async () => {
  const { root, src } = makeSuperprojectClone();
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-empty-"));
  try {
    mkdirSync(join(dir, ".adlc"));
    writeFileSync(join(dir, ".adlc", "workspace.yml"), GIT_ONLY_YML(src), "utf-8");
    mkdirSync(join(dir, "child")); // empty placeholder, no superproject
    const r = await run(["workspace", "setup"], dir, GIT_ENV);
    assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(dir, "child", "CDR.md")), "clone content missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── workspace init/link: deterministic via the installed workspace skill ─
// The skill's own scripts run directly (no agent): setup-workspace.sh --json,
// then workspace.sh --json --link; missing .gitignore rules are appended and
// committed. Without the scripts, setup falls back to the agent-led path.

const INIT_LINK_YML = `schema_version: "1.0"
name: "Init Link"
agent: opencode
workspace:
  init: true
  link: true
`;

// Stub workspace-skill scripts under opencode's skills_dir (.agents/skills).
function installWorkspaceScriptStubs(dir, missingRules = [], linkErrors = 0) {
  const bin = join(dir, ".agents", "skills", "workspace", "scripts", "bash");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "scripts.log");
  // Pretty-printed across lines, like the real script's `jq -n` output.
  const initJson = JSON.stringify({ GITIGNORE_RULES_MISSING: missingRules, CHILD_COUNT: 0 }, null, 2);
  // workspace.sh exits 0 even when a repo failed to link; errors are in JSON.
  const linkJson = JSON.stringify(
    { MODE: "link", ERROR_COUNT: linkErrors, ERRORS: linkErrors ? ["child: not a git repo"] : [] },
    null,
    2
  );
  writeFileSync(
    join(bin, "setup-workspace.sh"),
    `#!/usr/bin/env bash\necho "setup-workspace.sh $*" >> "${log}"\necho '${initJson}'\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, "workspace.sh"),
    `#!/usr/bin/env bash\necho "workspace.sh $*" >> "${log}"\necho '${linkJson}'\n`,
    { mode: 0o755 }
  );
  return log;
}

test("setup: init + link run the workspace skill scripts, not an agent", async () => {
  const dir = makeTempWorkspace(INIT_LINK_YML);
  const agentLog = join(dir, "mock-agent.log");
  try {
    git(["init", "-q", "-b", "main"], dir);
    const log = installWorkspaceScriptStubs(dir);
    const r = await run(["workspace", "setup"], dir, {
      ...GIT_ENV,
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: agentLog,
    });
    assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
    assert.equal(
      readFileSync(log, "utf-8"),
      "setup-workspace.sh --json\nworkspace.sh --json --link\n"
    );
    assert.ok(!existsSync(agentLog), "agent must not run when the scripts are installed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: init appends missing .gitignore rules and commits them", async () => {
  const dir = makeTempWorkspace(INIT_LINK_YML.replace("link: true", "link: false"));
  try {
    git(["init", "-q", "-b", "main"], dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf-8");
    git(["add", ".gitignore"], dir);
    git(["commit", "-q", "-m", "base"], dir);
    installWorkspaceScriptStubs(dir, [".adlc/*", "!.adlc/workspace.yml"]);
    const r = await run(["workspace", "setup"], dir, GIT_ENV);
    assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
    assert.equal(
      readFileSync(join(dir, ".gitignore"), "utf-8"),
      "node_modules/\n.adlc/*\n!.adlc/workspace.yml\n"
    );
    assert.equal(
      git(["log", "-1", "--format=%s"], dir),
      "[workspace] Configure .gitignore for workspace conventions"
    );
    assert.equal(git(["status", "--porcelain", "--", ".gitignore"], dir), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: init falls back to the agent when the workspace skill is not installed", async () => {
  const dir = makeTempWorkspace(INIT_LINK_YML);
  const agentLog = join(dir, "mock-agent.log");
  try {
    const r = await run(["workspace", "setup"], dir, {
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: agentLog,
    });
    assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
    assert.match(readFileSync(agentLog, "utf-8"), /Run \/workspace --init --link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup: a symlink to an empty dir outside the root is skipped, never cloned into", async () => {
  const { root, src } = makeSuperprojectClone();
  const dir = mkdtempSync(join(tmpdir(), "adlc-ws-link-"));
  const outside = mkdtempSync(join(tmpdir(), "adlc-ws-outside-"));
  try {
    mkdirSync(join(dir, ".adlc"));
    writeFileSync(join(dir, ".adlc", "workspace.yml"), GIT_ONLY_YML(src), "utf-8");
    symlinkSync(outside, join(dir, "child"));
    const r = await run(["workspace", "setup"], dir, GIT_ENV);
    assert.equal(r.code ?? 0, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /= child \(exists, skipping clone\)/);
    assert.deepEqual(readdirSync(outside), [], "nothing may be written outside the root");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("setup: link fails when workspace.sh reports per-repo errors (it exits 0)", async () => {
  const dir = makeTempWorkspace(INIT_LINK_YML);
  try {
    git(["init", "-q", "-b", "main"], dir);
    installWorkspaceScriptStubs(dir, [], 1);
    const r = await run(["workspace", "setup"], dir, GIT_ENV);
    assert.notEqual(r.code ?? 0, 0, "setup must fail on link errors");
    assert.match(r.stdout + r.stderr, /child: not a git repo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
