// tests/team-setup-wire.test.mjs — `team setup --directives <path>`
// deterministic headless wiring (Phase 1 interim validation; Phase 3
// switches to the skill-owned script invocation).
//
// ADR-386-amendment constraint: `team setup` spawns the interactive
// /team-setup skill headlessly, which hangs (~300s timeout) because no one
// can answer the mode selection. `--directives` wires a known path
// deterministically instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "adlc-cli.mjs");

const run = (args, cwd, env) =>
  exec(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...(env || {}) } }).catch((e) => e);

// A minimal team-ai-directives repo passing the 6-path structure check
// the wired skill currently validates against.
function makeDirectives(parent) {
  const dir = mkdtempSync(join(parent, "tad-"));
  mkdirSync(join(dir, "context_modules", "rules"), { recursive: true });
  mkdirSync(join(dir, "context_modules", "personas"), { recursive: true });
  mkdirSync(join(dir, "context_modules", "examples"), { recursive: true });
  writeFileSync(join(dir, "context_modules", "constitution.md"), "# C\n", "utf-8");
  writeFileSync(join(dir, "CDR.md"), "# CDR\n", "utf-8");
  writeFileSync(join(dir, ".skills.json"), JSON.stringify({ version: 1 }), "utf-8");
  return dir;
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-team-wire-"));
  return dir;
}

const VALID = {
  agent: "opencode",
  skills_source: "tikalk/adlc-team-skills",
};

test("setup --directives wires a valid path without touching skills (--skip-skills)", async () => {
  const parent = mkdtempSync(join(tmpdir(), "adlc-team-wire-p-"));
  const tad = makeDirectives(parent);
  const dir = makeProject();
  try {
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", tad, "-a", "opencode"],
      dir,
      { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: join(dir, "mock.log") },
    );
    assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
    const cfg = JSON.parse(readFileSync(join(dir, ".adlc", "init-options.json"), "utf-8"));
    assert.equal(cfg.team_ai_directives, tad);
    assert.equal(cfg.skills_source, VALID.skills_source);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --directives refuses an invalid structure (exit 1, no wire)", async () => {
  const parent = mkdtempSync(join(tmpdir(), "adlc-team-wire-p-"));
  const tad = mkdtempSync(join(parent, "tad-")); // empty: no constitution/CDR/.skills.json
  const dir = makeProject();
  try {
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", tad, "-a", "opencode"],
      dir,
      { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: join(dir, "mock.log") },
    );
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /MISSING|INVALID/i);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --directives with nonexistent path errors (exit 1)", async () => {
  const dir = makeProject();
  try {
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", join(dir, "nope"), "-a", "opencode"],
      dir,
      { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: join(dir, "mock.log") },
    );
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /not found/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup without --directives and without TTY fails loudly instead of hanging", async () => {
  const dir = makeProject();
  try {
    // No TTY on stdio here (execFile pipes) → must refuse, not spawn agent.
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "-a", "opencode"],
      dir,
      { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: join(dir, "mock.log") },
    );
    assert.equal(r.code ?? r.exitCode, 1);
    assert.match(String(r.stderr ?? r.stdout), /--directives/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
