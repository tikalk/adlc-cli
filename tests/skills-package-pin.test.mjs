// tests/skills-package-pin.test.mjs — SF-LANE-09: ADLC_SKILLS_PACKAGE pins
// the `skills` installer that `skills add` runs through npx.
//
// Without the pin, Node >= 22.20 always gets `npx --yes skills@latest add …`,
// so every factory pod can pick up a `skills` release nobody tested. The unit
// rule lives in spawn-compat.test.mjs; this test runs `skills add` through the
// CLI binary with a PATH stub for `npx` that records its arguments, so the
// wiring from the environment to the spawned command is pinned too.

import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const BIN = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "bin", "adlc-cli.mjs");
const POSIX = process.platform !== "win32";

// Temp project with one installed skill and an `npx` stub that appends its
// argv (one line per call) to npx-args.txt and exits 0 — no network.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-skills-pin-"));
  mkdirSync(join(dir, ".agents", "skills", "plain-skill"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", "skills", "plain-skill", "SKILL.md"),
    "---\nname: plain-skill\ndescription: An ordinary skill.\n---\n\n# plain-skill\n",
    "utf-8",
  );
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "npx-args.txt");
  writeFileSync(join(bin, "npx"), `#!/bin/sh\necho "$*" >> '${log}'\nexit 0\n`, "utf-8");
  chmodSync(join(bin, "npx"), 0o755);
  return {
    dir,
    calls: () => readFileSync(log, "utf-8").trim().split("\n"),
    env: (extra) => {
      const env = { ...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), ...extra };
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
      return env;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function skillsAdd(p, extraEnv) {
  return exec(process.execPath, [BIN, "skills", "add", "fixture-src", "-a", "opencode", "--no-events"], {
    cwd: p.dir,
    env: p.env(extraEnv),
  });
}

it("skills add: ADLC_SKILLS_PACKAGE=skills@x.y.z is the package npx runs", { skip: !POSIX }, async () => {
  const p = project();
  try {
    const { stdout } = await skillsAdd(p, { ADLC_SKILLS_PACKAGE: "skills@1.7.2" });
    assert.match(p.calls()[0], /^--yes skills@1\.7\.2 add fixture-src -a opencode\b/);
    assert.match(stdout, /npx --yes skills@1\.7\.2 add fixture-src/);
  } finally {
    p.cleanup();
  }
});

it("skills add: an inexact ADLC_SKILLS_PACKAGE falls back to the Node-version spec, with a warning", { skip: !POSIX }, async () => {
  const p = project();
  try {
    const { stderr } = await skillsAdd(p, { ADLC_SKILLS_PACKAGE: "skills@^1.7.0" });
    assert.match(p.calls()[0], /^--yes skills@(latest|1\.5\.18) add fixture-src\b/);
    assert.match(stderr, /ignoring ADLC_SKILLS_PACKAGE="skills@\^1\.7\.0"/);
  } finally {
    p.cleanup();
  }
});

it("skills add: without ADLC_SKILLS_PACKAGE the spec still follows the running Node", { skip: !POSIX }, async () => {
  const p = project();
  try {
    await skillsAdd(p, { ADLC_SKILLS_PACKAGE: undefined });
    assert.match(p.calls()[0], /^--yes skills@(latest|1\.5\.18) add fixture-src\b/);
  } finally {
    p.cleanup();
  }
});
