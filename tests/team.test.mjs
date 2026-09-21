import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "adlc-cli.mjs");
const LEGACY_BIN = join(REPO_ROOT, "bin", "adlc-skills-cli.mjs");
const run = (args, opts) => exec(process.execPath, [BIN, ...args], opts).catch((e) => e);

test("team setup without source errors", async () => {
  const r = await run(["team", "setup"]);
  assert.equal(r.code ?? r.exitCode, 1);
  assert.match(String(r.stderr ?? r.stdout), /source is required/i);
});

test("team setup without agent errors", async () => {
  const r = await run(["team", "setup", "tikalk/adlc-team-skills"]);
  assert.equal(r.code ?? r.exitCode, 1);
  assert.match(String(r.stderr ?? r.stdout), /agent required/i);
});

test("team update without config errors", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    const r = await exec(process.execPath, [BIN, "team", "update"], { cwd: tmp }).catch((e) => e);
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /not configured/i);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("team repair without agent errors", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    const r = await exec(process.execPath, [BIN, "team", "repair"], { cwd: tmp }).catch((e) => e);
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /agent required/i);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("legacy bin: old commands still work", async () => {
  const r = await exec(process.execPath, [LEGACY_BIN]);
  assert.match(r.stdout, /adlc-skills-cli add/);
  assert.match(r.stdout, /upgrade/);
  assert.doesNotMatch(r.stdout, /adlc-cli skills/);
});
