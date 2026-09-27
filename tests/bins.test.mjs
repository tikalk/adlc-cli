// Dual-bin contract: adlc-cli (new tree) and adlc-skills-cli (legacy alias)
// must both execute and, in Task 1, print identical help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const exec = promisify(execFile);

test("both bins execute; helps diverge by design (new = dual-mode, legacy = frozen)", async () => {
  const [a, b] = await Promise.all([
    exec(process.execPath, ["bin/adlc-cli.mjs"]),
    exec(process.execPath, ["bin/adlc-skills-cli.mjs"]),
  ]);
  assert.match(a.stdout, /skills add/); // new dual-mode help
  assert.match(b.stdout, /adlc-skills-cli add/); // legacy help frozen
});

test("legacy bin still dispatches the add command surface", async () => {
  const { stdout } = await exec(process.execPath, ["bin/adlc-skills-cli.mjs", "agents"]);
  assert.match(stdout, /OpenCode/);
});

test("version output matches package.json (no drift)", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  const { stdout } = await exec(process.execPath, ["bin/adlc-cli.mjs", "version"]);
  assert.equal(stdout.trim(), `adlc-cli ${pkg.version}`);
});
