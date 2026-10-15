// Portable spawn helper tests (win32 .cmd-shim ENOENT class).
// RED-first: fails while src/utils/spawn.mjs is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { portableSpawnOptions, describeSpawnError } from "../src/utils/spawn.mjs";

test("win32 npx resolves via shell", () => {
  const opts = portableSpawnOptions("npx", "win32");
  assert.equal(opts.shell, true);
});

test("win32 agent binary resolves via shell", () => {
  const opts = portableSpawnOptions("opencode", "win32");
  assert.equal(opts.shell, true);
});

test("posix keeps exact behavior: no shell key", () => {
  for (const platform of ["linux", "darwin"]) {
    const opts = portableSpawnOptions("npx", platform);
    assert.ok(!("shell" in opts), `${platform} must not set shell`);
  }
});

test("default platform follows process.platform", () => {
  const opts = portableSpawnOptions("npx");
  if (process.platform === "win32") assert.equal(opts.shell, true);
  else assert.ok(!("shell" in opts));
});

test("win32: bare names get shell, paths and .exe do not", () => {
  const shellCases = ["npx", "git", "opencode", "claude"];
  for (const cmd of shellCases) {
    assert.equal(portableSpawnOptions(cmd, "win32").shell, true, `${cmd} needs shell`);
  }
  const directCases = ["C:\\x\\node.exe", "/usr/bin/git", "./rel/script", "tests/fixtures/fake-agent.mjs", "C:\\PROG~1\\nodejs\\node.exe"];
  for (const cmd of directCases) {
    const opts = portableSpawnOptions(cmd, "win32");
    assert.ok(!("shell" in opts), `${cmd} must not set shell`);
  }
  // .exe suffix is direct even as a bare name
  assert.ok(!("shell" in portableSpawnOptions("node.exe", "win32")), "node.exe must not set shell");
  assert.ok(!("shell" in portableSpawnOptions("NODE.EXE", "win32")), "NODE.EXE must not set shell");
});

test("posix returns {} for every input shape", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const cmd of ["npx", "git", "C:\\x\\node.exe", "./rel/script", "node.exe"]) {
      const opts = portableSpawnOptions(cmd, platform);
      assert.deepEqual(opts, {}, `${platform}+${cmd} must be {}`);
    }
  }
});

test("describeSpawnError maps ENOENT result to message containing code", () => {
  const err = new Error("spawnSync npx ENOENT");
  err.code = "ENOENT";
  const msg = describeSpawnError({ status: null, error: err });
  assert.ok(msg && msg.includes("ENOENT"), `expected code in ${JSON.stringify(msg)}`);
});

test("describeSpawnError returns null when no error", () => {
  assert.equal(describeSpawnError({ status: 0 }), null);
  assert.equal(describeSpawnError({ status: 1 }), null);
  assert.equal(describeSpawnError({}), null);
});
