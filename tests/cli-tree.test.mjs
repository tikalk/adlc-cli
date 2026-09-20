// New-tree (adlc-cli) dispatch contract: `skill <sub>` commands, dual-mode help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = (bin, args) => exec(process.execPath, [`bin/${bin}.mjs`, ...args]).catch((e) => e);

test("new bin: agent list lists agents", async () => {
  const r = await run("adlc-cli", ["agent", "list"]);
  assert.match(r.stdout, /OpenCode/);
});

test("new bin: bare skill prints skill subcommand help", async () => {
  const r = await run("adlc-cli", ["skill"]);
  assert.match(r.stdout, /add <source>/);
  assert.match(r.stdout, /upgrade/);
});

test("new bin: unknown skill subcommand exits 1 with usage", async () => {
  const r = await run("adlc-cli", ["skill", "bogus"]);
  assert.match(String(r.message ?? r.stdout), /Unknown skill command|usage/i);
  assert.equal(r.code ?? r.exitCode, 1);
});

test("new bin: default help is dual-mode (skill + run)", async () => {
  const r = await run("adlc-cli", []);
  assert.match(r.stdout, /skill add/);
  assert.match(r.stdout, /agent run/);
});

test("legacy bin: old top-level help preserved", async () => {
  const r = await run("adlc-skills-cli", []);
  assert.match(r.stdout, /adlc-skills-cli add/);
  assert.doesNotMatch(r.stdout, /adlc-cli skill/);
});

test("legacy bin: add command surface still dispatches", async () => {
  const r = await run("adlc-skills-cli", ["agents"]);
  assert.match(r.stdout, /OpenCode/);
});

test("new bin: version prints version", async () => {
  const r = await run("adlc-cli", ["version"]);
  assert.match(r.stdout, /adlc-cli \d+\.\d+\.\d+/);
});

test("new bin: agent run with unsupported agent exits 1 (no spawn)", async () => {
  const r = await run("adlc-cli", ["agent", "run", "do something", "-a", "nonexistent-agent"]);
  assert.equal(r.code ?? r.exitCode, 1);
  assert.match(String(r.message ?? r.stderr ?? r.stdout), /Unsupported agent/i);
});
