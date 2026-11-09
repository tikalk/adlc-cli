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

// process.exit() terminates immediately and drops writes still queued in
// libuv: stdout to a pipe is asynchronous on POSIX. Both bins print, then
// exit, so without a flush the tail of a large output can be lost on a
// platform whose pipe buffer is small (Publish run 42608148983: macOS lost
// the last two panels of `workflow help`). This pins the contract the bins
// rely on: flush before process.exit.
test("flushStdio drains queued stdout before process.exit", async () => {
  const cliUrl = new URL("../src/cli.mjs", import.meta.url).href;
  const lines = 20000; // ~1.4 MB — far past any pipe buffer
  const script = `
    const { flushStdio } = await import(process.env.ADLC_CLI_URL);
    for (let i = 0; i < ${lines}; i++) {
      process.stdout.write("line-" + i + " " + "x".repeat(60) + "\\n");
    }
    await flushStdio();
    process.exit(0);
  `;
  const { stdout } = await exec(
    process.execPath,
    ["--input-type=module", "-e", script],
    { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ADLC_CLI_URL: cliUrl } },
  );
  const expected = Array.from({ length: lines }, (_, i) => `line-${i} ${"x".repeat(60)}\n`).join("");
  assert.equal(stdout.length, expected.length, "stdout was truncated before exit");
  assert.ok(stdout.endsWith(`line-${lines - 1} ${"x".repeat(60)}\n`), "tail of stdout missing");
});
