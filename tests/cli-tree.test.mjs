// New-tree (adlc-cli) dispatch contract: skills subcommands, team subcommands, dual-mode help.
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

test("new bin: bare skills shows status (default)", async () => {
  const r = await run("adlc-cli", ["skills"]);
  assert.match(r.stdout, /Project:|ADLC:|Dispatcher:/);
});

test("new bin: skills help prints subcommand help", async () => {
  const r = await run("adlc-cli", ["skills", "help"]);
  assert.match(r.stdout, /add <source>/);
  assert.match(r.stdout, /update/);
});

test("new bin: unknown skills subcommand exits 1 with usage", async () => {
  const r = await run("adlc-cli", ["skills", "bogus"]);
  assert.match(String(r.message ?? r.stdout), /Unknown skills command|usage/i);
  assert.equal(r.code ?? r.exitCode, 1);
});

test("new bin: default help includes team + skills + agent", async () => {
  const r = await run("adlc-cli", []);
  assert.match(r.stdout, /team setup/);
  assert.match(r.stdout, /skills add/);
  assert.match(r.stdout, /agent run/);
});

test("new bin: team help shows setup, update, repair", async () => {
  const r = await run("adlc-cli", ["team", "help"]);
  assert.match(r.stdout, /setup/);
  assert.match(r.stdout, /update/);
  assert.match(r.stdout, /repair/);
});

test("legacy bin: old top-level help preserved", async () => {
  const r = await run("adlc-skills-cli", []);
  assert.match(r.stdout, /adlc-skills-cli add/);
  assert.doesNotMatch(r.stdout, /adlc-cli skills/);
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
