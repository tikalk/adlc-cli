// spawnCompat/spawnNpxSync: Windows .cmd-shim safety + POSIX passthrough.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnCompatSync, spawnNpxSync, describeSpawnError, resolveSkillsPackageSpec, isWindows } from "../src/utils/spawn.mjs";

test("isWindows matches platform", () => {
  assert.equal(isWindows, process.platform === "win32");
});

test("spawnCompatSync: runs a real command and captures output", () => {
  const r = spawnCompatSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf-8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ok");
});

test("spawnCompatSync: propagates non-zero exit code", () => {
  const r = spawnCompatSync(process.execPath, ["-e", "process.exit(7)"], { encoding: "utf-8" });
  assert.equal(r.status, 7);
});

test("spawnCompatSync: missing binary yields error or non-zero, no throw", () => {
  const r = spawnCompatSync("definitely-not-a-real-binary-xyz", [], { encoding: "utf-8" });
  assert.notEqual(r.status, 0);
});

test("spawnNpxSync: args with spaces/metacharacters stay one token", () => {
  // The prompt-like arg must survive as a single argv entry. On Windows this
  // exercises quoteWinArg; on POSIX the arg is passed through verbatim.
  const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  const tricky = "a b&c|d>e<f^g%h!i\"j";
  const r = spawnCompatSync(process.execPath, ["-e", script, tricky], { encoding: "utf-8" });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), [tricky]);
});

test("spawnNpxSync: npx itself is invoked (not a shell-less ENOENT)", () => {
  // On Windows this is the regression test for the original bug: spawnSync
  // without shell fails to resolve npx.cmd. npx --version is a cheap, offline
  // command. If npx is genuinely absent from PATH, the child errors — we only
  // assert it did not die with ENOENT-style "spawn npx ENOENT".
  const r = spawnNpxSync(["--version"], { encoding: "utf-8" });
  if (r.error) {
    assert.fail(`spawnNpxSync should not fail to launch npx: ${r.error.message}`);
  }
  assert.equal(r.status, 0, `npx --version failed: ${r.stderr || ""}`);
  assert.match(r.stdout.trim(), /^\d+\./);
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

test("resolveSkillsPackageSpec: @latest on capable Nodes, pinned 1.5.18 below", () => {
  // skills >= 1.5.19 needs node >= 22.20 (fs/promises glob); 1.5.18 is the
  // newest release that runs on older Nodes. Pure version-string logic —
  // no network, no npx invocation.
  assert.equal(resolveSkillsPackageSpec("v22.20.0"), "skills@latest");
  assert.equal(resolveSkillsPackageSpec("v22.23.3"), "skills@latest");
  assert.equal(resolveSkillsPackageSpec("v23.0.0"), "skills@latest");
  assert.equal(resolveSkillsPackageSpec("v24.1.0"), "skills@latest");
  assert.equal(resolveSkillsPackageSpec("v22.19.9"), "skills@1.5.18");
  assert.equal(resolveSkillsPackageSpec("v21.7.3"), "skills@1.5.18");
  assert.equal(resolveSkillsPackageSpec("v20.19.0"), "skills@1.5.18");
  assert.equal(resolveSkillsPackageSpec("v18.20.8"), "skills@1.5.18");
  assert.equal(resolveSkillsPackageSpec("garbage"), "skills@1.5.18");
  assert.equal(resolveSkillsPackageSpec(""), "skills@1.5.18");
});

test("resolveSkillsPackageSpec: default follows the running Node", () => {
  const spec = resolveSkillsPackageSpec();
  assert.match(spec, /^skills@/);
});
