// Dual-bin contract: adlc-cli (new tree) and adlc-skills-cli (legacy alias)
// must both execute and, in Task 1, print identical help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("both bins print identical help and exit 0", async () => {
  const [a, b] = await Promise.all([
    exec(process.execPath, ["bin/adlc-cli.mjs"]),
    exec(process.execPath, ["bin/adlc-skills-cli.mjs"]),
  ]);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /USAGE/);
  assert.equal(a.code ?? 0, 0);
});

test("legacy bin still dispatches the add command surface", async () => {
  const { stdout } = await exec(process.execPath, ["bin/adlc-skills-cli.mjs", "agents"]);
  assert.match(stdout, /OpenCode/);
});
