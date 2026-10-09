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

test("factory setup without agent errors", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    const r = await exec(process.execPath, [BIN, "factory", "setup"], { cwd: tmp }).catch((e) => e);
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /agent required/i);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("factory setup with invalid provider errors", async () => {
  const r = await exec(process.execPath, [BIN, "factory", "setup", "--provider", "bogus"]).catch((e) => e);
  assert.equal(r.code ?? r.exitCode, 1);
  assert.match(String(r.stderr ?? r.stdout), /must be one of/i);
});

test("factory setup without installed skill errors", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    const r = await exec(process.execPath, [BIN, "factory", "setup", "-a", "opencode"], { cwd: tmp }).catch((e) => e);
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /not installed/i);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("factory help shows setup", async () => {
  const r = await exec(process.execPath, [BIN, "factory", "help"]).catch((e) => e);
  assert.match(String(r.stdout ?? ""), /setup/);
});

test("factory unknown subcommand exits 1 with usage", async () => {
  const r = await exec(process.execPath, [BIN, "factory", "bogus"]).catch((e) => e);
  assert.equal(r.code ?? r.exitCode, 1);
  assert.match(String(r.message ?? r.stderr ?? r.stdout), /unknown factory command|usage/i);
});

test("default help includes factory setup", async () => {
  const r = await exec(process.execPath, [BIN]).catch((e) => e);
  assert.match(String(r.stdout ?? ""), /factory setup/);
});
