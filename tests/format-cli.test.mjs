import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const run = async (args) => {
  try {
    const r = await exec(process.execPath, ["bin/adlc-cli.mjs", ...args]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return e;
  }
};

const FLAT = "tests/fixtures/format/flat-team-context.txt";
const CLEAN = "tests/fixtures/format/clean-team-context.md";

test("format check exits 1 and reports JSON for a collapsed file", async () => {
  const r = await run(["format", "check", FLAT, "--json"]);
  assert.equal(r.code, 1);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.collapsed, true);
  assert.equal(payload.family, "team-context");
});

test("format check exits 0 for a clean file", async () => {
  const r = await run(["format", "check", CLEAN, "--json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).collapsed, false);
});

test("format fix prints the reflowed text", async () => {
  const r = await run(["format", "fix", FLAT]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^## Team Context & Decisions\n\n\| ID \|/);
});

test("format fix --write rewrites the file in place", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-format-"));
  const target = join(dir, "draft.md");
  copyFileSync(FLAT, target);
  const r = await run(["format", "fix", target, "--write"]);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(target, "utf8"), readFileSync(CLEAN, "utf8").trimEnd());
});

test("format fix refuses an ambiguous table and leaves the file untouched", async () => {
  const r = await run(["format", "fix", "tests/fixtures/format/ambiguous-table.txt", "--write"]);
  assert.equal(r.code, 3);
});

test("format rejects an unknown source", async () => {
  const r = await run(["format", "check", "missing-file.md"]);
  assert.equal(r.code, 2);
});

test("format help exits 0", async () => {
  const r = await run(["format", "help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /format check/);
});
