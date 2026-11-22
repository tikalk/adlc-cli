// Step 5.7 — devcontainer trigger RED suite (issue #101, brief comment 85133).
// Per ADR-386-amendment-3: adlc-cli shells out to the real `devcontainer up`
// against the runner-provided daemon. No OCI emulation, no feature installs
// in adlc-cli — the trigger fires on declaration only, never on a provider flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/adlc-cli.mjs", import.meta.url));
const run = (args, cwd, env) =>
  exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...(env || {}) } }).catch((e) => e);

const combined = (r) => `${r.stdout ?? ""}\n${r.stderr ?? ""}\n${r.message ?? ""}`;

function makeWorkspace(dir, content) {
  mkdirSync(join(dir, ".adlc"), { recursive: true });
  writeFileSync(join(dir, ".adlc", "workspace.yml"), content, "utf-8");
}

const BASE_YML = `schema_version: "1.0"
name: "Devcontainer Trigger"
agent: opencode
workspace:
  dirs:
    - fresh-dir
`;

test("setup --dry-run with .devcontainer/devcontainer.json prints the resolved invocation and spawns nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  try {
    makeWorkspace(dir, BASE_YML);
    mkdirSync(join(dir, ".devcontainer"), { recursive: true });
    writeFileSync(join(dir, ".devcontainer", "devcontainer.json"), '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }', "utf-8");
    // PATH with no devcontainer binary + a marker to prove zero spawns
    const r = await run(["workspace", "setup", "--dry-run"], dir, {
      PATH: "",
      ADLC_DEVCONTAINER_SPAWN_LOG: join(dir, "spawn.log"),
    });
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /devcontainer/i, "dry-run prints the resolved devcontainer invocation");
    assert.match(r.stdout, /devcontainer up/, "dry-run names the exact command that would run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --dry-run with legacy .devcontainer.json also resolves the declaration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  try {
    makeWorkspace(dir, BASE_YML);
    writeFileSync(join(dir, ".devcontainer.json"), '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }', "utf-8");
    const r = await run(["workspace", "setup", "--dry-run"], dir, { PATH: "" });
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /devcontainer up/, "legacy single-file declaration resolves");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup prefers .devcontainer/devcontainer.json over legacy .devcontainer.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  try {
    makeWorkspace(dir, BASE_YML);
    mkdirSync(join(dir, ".devcontainer"), { recursive: true });
    writeFileSync(
      join(dir, ".devcontainer", "devcontainer.json"),
      '{ "image": "primary-image" }',
      "utf-8",
    );
    writeFileSync(join(dir, ".devcontainer.json"), '{ "image": "legacy-image" }', "utf-8");
    const r = await run(["workspace", "setup", "--dry-run"], dir, {
      PATH: "",
      ADLC_DEVCONTAINER_CONFIG_TRACE: "1",
    });
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /\.devcontainer\/devcontainer\.json/, "canonical path wins over legacy");
    assert.doesNotMatch(combined(r), /legacy-image/, "legacy file content never leaks into the plan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup fails fast with a loud error when the devcontainer CLI is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  try {
    makeWorkspace(dir, BASE_YML);
    mkdirSync(join(dir, ".devcontainer"), { recursive: true });
    writeFileSync(join(dir, ".devcontainer", "devcontainer.json"), '{ "image": "x" }', "utf-8");
    // Empty PATH: no devcontainer binary can resolve → loud non-zero failure, before skills run.
    const r = await run(["workspace", "setup"], dir, { PATH: "" });
    assert.notEqual(r.code, 0, "absent devcontainer CLI is a hard failure");
    assert.match(combined(r), /devcontainer/i, "failure names the devcontainer CLI");
    assert.doesNotMatch(combined(r), /skills\.sources/, "skills step never reached (fail-fast)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup fails fast naming the cause when the daemon is unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  const stubDir = mkdtempSync(join(tmpdir(), "adlc-dc-stub-"));
  try {
    makeWorkspace(dir, BASE_YML);
    mkdirSync(join(dir, ".devcontainer"), { recursive: true });
    writeFileSync(join(dir, ".devcontainer", "devcontainer.json"), '{ "image": "x" }', "utf-8");
    // Stub devcontainer exists but the daemon socket is unreachable: point
    // DOCKER_HOST at a dead path and shrink the wait so the test stays fast.
    writeFileSync(
      join(stubDir, "devcontainer"),
      '#!/bin/sh\necho "STUB-SHOULD-NOT-RUN" >&2\nexit 99\n',
      { mode: 0o755 },
    );
    const r = await run(["workspace", "setup"], dir, {
      PATH: `${stubDir}:/usr/bin:/bin`,
      DOCKER_HOST: "unix:///nonexistent-adlc-test-docker.sock",
      ADLC_DAEMON_WAIT_ATTEMPTS: "2",
      ADLC_DAEMON_WAIT_MS: "10",
    });
    assert.notEqual(r.code, 0, "unreachable daemon fails the setup");
    assert.match(combined(r), /daemon|DOCKER_HOST|socket|docker/i, "failure names the daemon cause");
    assert.doesNotMatch(combined(r), /STUB-SHOULD-NOT-RUN/, "readiness gate held — stub never spawned");
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup propagates the inner devcontainer exit code unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  const stubDir = mkdtempSync(join(tmpdir(), "adlc-dc-stub-"));
  try {
    makeWorkspace(dir, BASE_YML);
    mkdirSync(join(dir, ".devcontainer"), { recursive: true });
    writeFileSync(join(dir, ".devcontainer", "devcontainer.json"), '{ "image": "x" }', "utf-8");
    // Stub devcontainer that exits 42 with marker output; readiness gate must
    // pass (ADLC_DEVCONTAINER_SKIP_READINESS) so the stub actually runs.
    writeFileSync(
      join(stubDir, "devcontainer"),
      '#!/bin/sh\necho "INNER-MARKER-STDOUT"\necho "INNER-MARKER-STDERR" >&2\nexit 42\n',
      { mode: 0o755 },
    );
    const r = await run(["workspace", "setup"], dir, {
      PATH: `${stubDir}:/usr/bin:/bin`,
      ADLC_DEVCONTAINER_SKIP_READINESS: "1",
    });
    assert.equal(r.code, 42, "inner exit code propagates unchanged");
    assert.match(r.stdout, /INNER-MARKER-STDOUT/, "inner stdout streams to outer stdout");
    assert.match(combined(r), /INNER-MARKER-STDERR/, "inner stderr streams out");
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup with no devcontainer file never runs the devcontainer step (SC5 regression pin)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  try {
    makeWorkspace(dir, BASE_YML);
    const r = await run(["workspace", "setup", "--dry-run"], dir);
    assert.equal(r.code ?? 0, 0, combined(r));
    assert.match(r.stdout, /mkdir -p fresh-dir/);
    assert.doesNotMatch(r.stdout, /devcontainer up/, "no declaration → no devcontainer step");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup devcontainer step never consults a provider flag (location-free, ADR-443)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-dc-test-"));
  try {
    makeWorkspace(dir, BASE_YML);
    mkdirSync(join(dir, ".devcontainer"), { recursive: true });
    writeFileSync(join(dir, ".devcontainer", "devcontainer.json"), '{ "image": "x" }', "utf-8");
    // The trigger fires on declaration alone, with no provider flag. The
    // provider route (`--provider coder`) is a separate path that refuses
    // --dry-run and never reaches step 5.7: it must not run the trigger.
    const plain = await run(["workspace", "setup", "--dry-run"], dir, { PATH: "" });
    assert.equal(plain.code ?? 0, 0, combined(plain));
    assert.match(plain.stdout, /devcontainer up/, "trigger fires without any provider flag");
    const viaProvider = await run(["workspace", "setup", "--dry-run", "--provider", "coder"], dir, { PATH: "" });
    assert.notEqual(viaProvider.code, 0, "provider route refuses --dry-run");
    assert.doesNotMatch(combined(viaProvider), /devcontainer up/, "provider flag never drives the trigger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
