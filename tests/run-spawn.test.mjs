// buildRunCommand + runTask tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRunCommand, runTask } from "../src/run.mjs";

// ── buildRunCommand (pure function) ──────────────────────────────────────

test("buildRunCommand: opencode basic", () => {
  const { cmd, args } = buildRunCommand("opencode", "do x");
  assert.equal(cmd, "opencode");
  assert.deepEqual(args, ["run", "--format", "json", "--dangerously-skip-permissions", "do x"]);
});

test("buildRunCommand: opencode with model", () => {
  const { args } = buildRunCommand("opencode", "x", { model: "m1" });
  const modelIdx = args.indexOf("-m");
  assert.notEqual(modelIdx, -1);
  assert.equal(args[modelIdx + 1], "m1");
  assert.equal(args[args.length - 1], "x"); // prompt is last
});

test("buildRunCommand: opencode requireApproval drops --dangerously-skip-permissions", () => {
  const { args } = buildRunCommand("opencode", "x", { requireApproval: ["Bash"] });
  assert.equal(args.indexOf("--dangerously-skip-permissions"), -1);
  assert.equal(args[args.length - 1], "x");
});

test("buildRunCommand: claude-code includes allowed-tools flag", () => {
  const { cmd, args } = buildRunCommand("claude-code", "fix bug");
  assert.equal(cmd, "claude");
  assert.ok(args.includes("--allowedTools"));
});

// ── runTask (spawn + exit code) ──────────────────────────────────────────

const fakeProfile = {
  binary: process.execPath,
  args: ["tests/fixtures/fake-agent.mjs"],
  promptPosition: "arg",
  outputFormat: "json",
  permissionMode: "auto",
  modelFlag: null,
};

test("runTask: spawns fake agent, captures exit code 7", async () => {
  const lines = [];
  const { promise } = runTask({
    profile: fakeProfile,
    prompt: "hello",
    onLine: (line) => lines.push(line),
  });
  const { code } = await promise;
  assert.equal(code, 7);
  assert.ok(lines.length >= 2);
  assert.ok(lines.some((l) => l.includes("hello from fake agent")), "has the text line");
});

// ── runTask: signal forwarding (POSIX only) ───────────────────────────────

test("runTask: SIGTERM forwarded to child, no orphan", { skip: process.platform === "win32" }, async () => {
  const pidFile = join(tmpdir(), `fake-sleeper-${Date.now()}.pid`);
  const sleeperProfile = {
    binary: process.execPath,
    args: ["tests/fixtures/fake-sleeper.mjs"],
    promptPosition: "arg",
    outputFormat: "json",
    permissionMode: "auto",
    modelFlag: null,
  };

  const { promise, kill } = runTask({
    profile: sleeperProfile,
    prompt: pidFile,
    onLine: () => {},
  });

  // Wait for pidfile
  const start = Date.now();
  while (!existsSync(pidFile) && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(pidFile), "sleeper wrote pidfile");
  const childPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

  // Kill via the task's kill() — simulates signal forwarding
  kill("SIGTERM");

  // Wait for child to be reaped
  const reapStart = Date.now();
  while (Date.now() - reapStart < 10000) {
    try {
      process.kill(childPid, 0); // throws ESRCH when gone
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      break; // process gone — pass
    }
  }
  // Final assertion: process is gone
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);

  try { rmSync(pidFile); } catch {}
  const { code } = await promise;
  assert.notEqual(code, 0, "killed child should have non-zero exit");
});
