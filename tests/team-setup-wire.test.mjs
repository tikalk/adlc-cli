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
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { join, resolve, dirname, delimiter } from "node:path";
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
  // realpathSync: macOS tmpdir() is a /var → /private/var symlink; the CLI
  // resolves clone dests, so every temp dir in this file must be canonical.
  return realpathSync(mkdtempSync(join(tmpdir(), "adlc-team-wire-")));
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
    assert.equal(existsSync(join(dir, "mock.log")), false, "the agent session must not start");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch parseArgs captures --format in flags (both forms), never positional", async () => {
  // F1 regression anchor: `team setup --format json` on a TTY used to fall
  // through to interactive because flags.format was never set. Guard the
  // contract at the parse layer so no TTY is needed to catch a regression.
  const { parseArgs } = await import("../src/dispatch.mjs");
  for (const argv of [
    ["team", "setup", "src", "--format", "json"],
    ["team", "setup", "src", "--format=json"],
  ]) {
    const { args, flags } = parseArgs(argv);
    assert.equal(flags.format, "json", `flags.format must be parsed from ${argv.join(" ")}`);
    assert.ok(!args.includes("json"), `flag value must not leak into positional args (${argv.join(" ")})`);
  }
  const { args: bare, flags: bareFlags } = parseArgs(["team", "setup", "src"]);
  assert.equal(bareFlags.format, undefined);
  assert.deepEqual(bare.slice(0, 2), ["setup", "src"]);
});

test("setup --directives rejects non-https URLs (file, ssh, http) with https-only guidance", async () => {
  const dir = makeProject();
  try {
    for (const bad of ["file:///tmp/evil", "ssh://git@example.com/org/repo.git", "http://example.com/repo.git"]) {
      const r = await run(
        ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", bad, "-a", "opencode"],
        dir,
        { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: join(dir, "mock.log") },
      );
      assert.equal(r.code ?? r.exitCode, 1, `${bad} must be rejected`);
      assert.match(String(r.stderr ?? r.stdout), /https/, `${bad} rejection must mention https`);
      assert.equal(existsSync(join(dir, "mock.log")), false, "the agent session must not start");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --directives <https-url> clones then wires (positive URL path)", async () => {
  // realpathSync: macOS tmpdir is a /var → /private/var symlink; the CLI
  // resolves the clone dest, so compare against the canonical parent.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "adlc-team-wire-p-")));
  const dir = makeProject();
  try {
    // A real local repo with the valid directives structure. The fake git
    // below intercepts the clone, so no network is touched; the URL is a
    // plain https:// string, exercising the same regex + clone-then-wire
    // code path as production input. (file:// and ssh:// are rejected —
    // one test above.)
    const origin = join(parent, "origin");
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
    mkdirSync(join(origin, "context_modules", "rules"), { recursive: true });
    mkdirSync(join(origin, "context_modules", "personas"), { recursive: true });
    mkdirSync(join(origin, "context_modules", "examples"), { recursive: true });
    writeFileSync(join(origin, "context_modules", "constitution.md"), "# C\n", "utf-8");
    writeFileSync(join(origin, "CDR.md"), "# CDR\n", "utf-8");
    writeFileSync(join(origin, ".skills.json"), JSON.stringify({ version: 1 }), "utf-8");
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"], { cwd: origin });

    // git stub: intercept the clone by copying the seeded repo (simulates a
    // successful clone with no network); delegate everything else to the
    // real git. The node payload lives in git-stub.js; the extensionless
    // `git` is a POSIX sh wrapper (Linux/macOS PATH resolution) and
    // git.cmd covers Windows (spawned via cmd.exe PATHEXT).
    // NOTE (windows): node spawnSync("git", ..., {shell:false}) resolves
    // git.exe before git.cmd, so the stub is POSIX-only. Windows CI runs
    // the local-path wire test; URL regex + reject paths covered above.
    if (process.platform === "win32") {
      const r = await run(
        ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", origin, "-a", "opencode"],
        dir,
        { ADLC_MOCK_AGENT: "1", ADLC_MOCK_AGENT_FILE: join(dir, "mock.log") },
      );
      assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
      const dest = origin;
      const cfg = JSON.parse(readFileSync(join(dir, ".adlc", "init-options.json"), "utf-8"));
      assert.equal(cfg.team_ai_directives, dest);
      return;
    }
    const gitExeDir = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
    const realGitExe = join(gitExeDir, process.platform === "win32" ? "git.exe" : "git");
    const bin = join(parent, "bin");
    mkdirSync(bin, { recursive: true });
    const stubJs = join(bin, "git-stub.js");
    writeFileSync(stubJs, `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "clone" && /^https:\\/\\//.test(args[1] || "")) {
  fs.cpSync(${JSON.stringify(origin)}, args[2], { recursive: true });
  process.exit(0);
}
const r = spawnSync(${JSON.stringify(realGitExe)}, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`, "utf-8");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`, { mode: 0o755 });
    if (process.platform === "win32") {
      writeFileSync(
        join(bin, "git.cmd"),
        `@echo off\r\n"${process.execPath}" "${stubJs}" %*\r\n`,
        "utf-8",
      );
    }

    const url = `https://example.com/team-ai-directives.git`;
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", url, "-a", "opencode"],
      dir,
      {
        ADLC_MOCK_AGENT: "1",
        ADLC_MOCK_AGENT_FILE: join(dir, "mock.log"),
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
    );
    assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
    const dest = join(dir, "team-ai-directives");
    assert.equal(existsSync(join(dest, ".skills.json")), true, "the URL must have been cloned into ./team-ai-directives");
    const cfg = JSON.parse(readFileSync(join(dir, ".adlc", "init-options.json"), "utf-8"));
    assert.equal(cfg.team_ai_directives, dest);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --directives <https-url> with credentials never leaks them (argv/config/log)", async () => {
  // F4: credentialed URL must be stripped before argv; GIT_ASKPASS supplies
  // the secret. Assert the clone argv carries no secret, the cloned
  // .git/config + failure output contain no secret.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "adlc-team-wire-p-")));
  const dir = makeProject();
  try {
    const origin = join(parent, "origin");
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
    mkdirSync(join(origin, "context_modules", "rules"), { recursive: true });
    mkdirSync(join(origin, "context_modules", "personas"), { recursive: true });
    mkdirSync(join(origin, "context_modules", "examples"), { recursive: true });
    writeFileSync(join(origin, "context_modules", "constitution.md"), "# C\n", "utf-8");
    writeFileSync(join(origin, "CDR.md"), "# CDR\n", "utf-8");
    writeFileSync(join(origin, ".skills.json"), JSON.stringify({ version: 1 }), "utf-8");
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"], { cwd: origin });
    const argvLog = join(parent, "clone-argv.jsonl");
    const bin = join(parent, "bin");
    mkdirSync(bin, { recursive: true });
    const stubJs = join(bin, "git-stub.js");
    writeFileSync(stubJs, `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "clone" && /^https:\\/\\//.test(args[1] || "")) {
  fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ argv: args, askpass: !!process.env.GIT_ASKPASS }) + "\\n");
  if (/SECRET/.test(args[1] || "")) { console.error("refusing credentialed argv"); process.exit(3); }
  fs.cpSync(${JSON.stringify(origin)}, args[2], { recursive: true });
  const cfg = args[2] + "/.git/config";
  try {
    let text = fs.readFileSync(cfg, "utf-8");
    text = text.replace(/^\\turl = .*$/m, "\\turl = https://example.com/team-ai-directives.git");
    fs.writeFileSync(cfg, text);
  } catch {}
  process.exit(0);
}
const gitExeDir = require("node:child_process").execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
const r = spawnSync(require("node:path").join(gitExeDir, "git"), args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`, "utf-8");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`, { mode: 0o755 });

    const url = `https://agentuser:s3cr3t-SECRET-token@example.com/team-ai-directives.git`;
    const r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", url, "-a", "opencode"],
      dir,
      {
        ADLC_MOCK_AGENT: "1",
        ADLC_MOCK_AGENT_FILE: join(dir, "mock.log"),
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
    );
    assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
    assert.ok(existsSync(argvLog), "clone must have been attempted");
    const entry = JSON.parse(readFileSync(argvLog, "utf-8").trim().split("\n").at(-1));
    assert.equal(entry.askpass, true, "credentials must be supplied via GIT_ASKPASS, not argv");
    assert.ok(!JSON.stringify(entry.argv).includes("SECRET"), "clone argv must not contain the secret");
    const gitConfig = readFileSync(join(dir, "team-ai-directives", ".git", "config"), "utf-8");
    assert.ok(!gitConfig.includes("SECRET"), ".git/config must not contain the secret");
    assert.ok(!String(r.stderr ?? "").includes("SECRET"), "failure output must not contain the secret");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup --directives reuses a matching clone but refuses a stale/mismatched dest", async () => {
  // F5: an existing ./team-ai-directives must not silently swallow a new URL.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "adlc-team-wire-p-")));
  const dir = makeProject();
  try {
    const gitExeDir = execFileSync("git", ["--exec-path"], { encoding: "utf-8" }).trim();
    const realGitExe = join(gitExeDir, process.platform === "win32" ? "git.exe" : "git");
    const bin = join(parent, "bin");
    mkdirSync(bin, { recursive: true });
    const stubJs = join(bin, "git-stub.js");
    const origin = join(parent, "origin");
    mkdirSync(origin, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
    mkdirSync(join(origin, "context_modules", "rules"), { recursive: true });
    mkdirSync(join(origin, "context_modules", "personas"), { recursive: true });
    mkdirSync(join(origin, "context_modules", "examples"), { recursive: true });
    writeFileSync(join(origin, "context_modules", "constitution.md"), "# C\n", "utf-8");
    writeFileSync(join(origin, "CDR.md"), "# CDR\n", "utf-8");
    writeFileSync(join(origin, ".skills.json"), JSON.stringify({ version: 1 }), "utf-8");
    execFileSync("git", ["add", "."], { cwd: origin });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"], { cwd: origin });
    const urlA = `https://example.com/team-a.git`;
    execFileSync("git", ["remote", "add", "origin", urlA], { cwd: origin });
    writeFileSync(stubJs, `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "clone" && /^https:\\/\\//.test(args[1] || "")) {
  fs.cpSync(${JSON.stringify(origin)}, args[2], { recursive: true });
  process.exit(0);
}
const r = spawnSync(${JSON.stringify(realGitExe)}, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`, "utf-8");
    writeFileSync(join(bin, "git"), `#!/bin/sh\nexec "${process.execPath}" "${stubJs}" "$@"\n`, { mode: 0o755 });
    const env = {
      ADLC_MOCK_AGENT: "1",
      ADLC_MOCK_AGENT_FILE: join(dir, "mock.log"),
      PATH: `${bin}${delimiter}${process.env.PATH}`,
    };
    const urlB = `https://example.com/team-b.git`;

    // First run with urlA wires the clone.
    let r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", urlA, "-a", "opencode"],
      dir,
      env,
    );
    assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
    // Second run with a DIFFERENT url must fail loudly, not silently reuse.
    r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", urlB, "-a", "opencode"],
      dir,
      env,
    );
    assert.equal(r.code ?? r.exitCode, 1, "mismatched dest must fail loudly");
    assert.match(String(r.stderr ?? r.stdout), /origin|remove/i);
    // Same URL again must succeed (reuse verified by origin match).
    r = await run(
      ["team", "setup", "tikalk/adlc-team-skills", "--skip-skills", "--directives", urlA, "-a", "opencode"],
      dir,
      env,
    );
    assert.equal(r.code ?? r.exitCode ?? 0, 0, r.stderr);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
