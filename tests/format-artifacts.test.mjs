import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const run = async (args) => {
  try {
    const r = await exec(process.execPath, ["bin/adlc-cli.mjs", ...args]);
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return e;
  }
};

test("artifact directory with a collapsed file exits 1", async () => {
  const r = await run(["format", "check", "tests/fixtures/format/artifacts/flat.md", "--json"]);
  assert.equal(r.code, 1);
});

test("artifact clean file exits 0", async () => {
  const r = await run(["format", "check", "tests/fixtures/format/artifacts/clean.md", "--json"]);
  assert.equal(r.code, 0);
});
