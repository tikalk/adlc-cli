// tests/reference-only.test.mjs — ADR-507: reference-only skills never get a
// command file.
//
// The `reference-only: true` frontmatter marker (adlc-workspace ADR-507,
// "factory-runbook is reference-only — never invoked, no slash command") has
// two CLI obligations, both pinned here:
//   1. `skills add` skips command generation for marked skills and reports the
//      skip count; unmarked siblings in the same install still generate.
//   2. `skills update` deletes a stale *generated* command for a marked skill
//      (the pre-marker install artifact) while leaving a user-authored file
//      with the same name untouched.
//
// The units under test (cmdAdd, cmdUpdate) run for real against temp-dir
// fixtures through the CLI binary, the way team-mcp-chain.test.mjs runs its
// units: one external boundary is stubbed — the `npx skills` installer (a PATH
// stub; cmdAdd's install loop must not hit the network), and `--no-events`
// keeps the events-manifest fetch offline. Frontmatter parsing yields strings
// (`reference-only: true` and `reference-only: "true"` both arrive as `"true"`),
// so both spellings are pinned.

import { it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { findInstalledSkills } from "../src/source.mjs";
import { generateCommand, commandFilename, isGenerated } from "../src/convert.mjs";
import { getAgent } from "../src/registry.mjs";

const exec = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(REPO_ROOT, "bin", "adlc-cli.mjs");
// execFile resolves without a status and rejects with e.code on non-zero —
// normalise both shapes to { status, stdout, stderr }.
const run = async (args, { cwd, env } = {}) => {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr };
  } catch (e) {
    return { status: typeof e.code === "number" ? e.code : 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
};

const SKILLS = {
  "plain-skill": `---
name: plain-skill
description: An ordinary invocable skill with no marker.
---

# plain-skill

Ordinary body.`,
  "ref-bool": `---
name: ref-bool
description: Reference-only skill, bare boolean spelling.
reference-only: true
---

# ref-bool

Read this; never invoke it.`,
  "ref-str": `---
name: ref-str
description: Reference-only skill, quoted spelling.
reference-only: "true"
---

# ref-str

Read this; never invoke it.`,
};

// Temp project: the three fixture skills installed under .agents/skills, plus
// a PATH stub for `npx` so cmdAdd's install loop exits 0 without network.
// Two twins of the stub — `npx` (POSIX shebang script) and `npx.cmd` (CRLF
// batch): on Windows spawnNpxSync goes through cmd.exe, which resolves the
// command via PATHEXT and cannot execute an extensionless script.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-reference-only-"));

  for (const [name, content] of Object.entries(SKILLS)) {
    mkdirSync(join(dir, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", name, "SKILL.md"), content, "utf-8");
  }

  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const npx = join(bin, "npx");
  writeFileSync(npx, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(npx, 0o755);
  writeFileSync(join(bin, "npx.cmd"), "@echo off\r\nexit /b 0\r\n", "utf-8");

  const pathValue = [bin, process.env.PATH].filter(Boolean).join(delimiter);
  const env = process.platform === "win32"
    ? { PATH: pathValue, Path: pathValue }
    : { PATH: pathValue };

  return {
    dir,
    path: (rel) => join(dir, rel),
    exists: (rel) => existsSync(join(dir, rel)),
    read: (rel) => readFileSync(join(dir, rel), "utf-8"),
    env,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

it("skills add: generates commands for plain skills, skips reference-only ones", async () => {
  const p = project();
  try {
    const r = await run(["skills", "add", "fixture-src", "-a", "opencode", "--no-events"], {
      cwd: p.dir,
      env: p.env,
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr || r.stdout}`);

    // The unmarked sibling still generates — the skip is selective, not a stall.
    const plain = p.read(".opencode/commands/plain-skill.md");
    assert.ok(isGenerated(plain), "plain-skill command must be generated");

    // Both marker spellings are skipped: no command file at all.
    assert.ok(!p.exists(".opencode/commands/ref-bool.md"), "ref-bool must not get a command");
    assert.ok(!p.exists(".opencode/commands/ref-str.md"), "ref-str must not get a command");

    // The skip is visible, not silent.
    assert.match(r.stdout, /Skipped 2 reference-only skill\(s\)/);
  } finally {
    p.cleanup();
  }
});

it("skills update: deletes a stale generated command, preserves a user-authored one", async () => {
  const p = project();
  try {
    const agent = getAgent("opencode");
    const skills = await findInstalledSkills(".agents/skills", p.dir);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

    // Pre-marker artifact: ref-bool had a command generated before the marker
    // existed. Regenerating here is the faithful shape — same code path cmdAdd
    // used — so isGenerated() must recognise it as ours to delete.
    mkdirSync(p.path(".opencode/commands"), { recursive: true });
    writeFileSync(
      p.path(".opencode/commands/ref-bool.md"),
      generateCommand(byName["ref-bool"], agent, { source: "pre-marker" }),
      "utf-8",
    );

    // A user-authored file sharing the skipped skill's name — not ours, must
    // survive the update untouched.
    const userContent = "# My own ref-str command\n\nHand-written body.\n";
    writeFileSync(p.path(".opencode/commands/ref-str.md"), userContent, "utf-8");

    // No --pull: cmdUpdate regenerates from installed skills without npx.
    const r = await run(["skills", "update", "-a", "opencode"], { cwd: p.dir, env: p.env });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr || r.stdout}`);

    // Stale generated command for the marked skill is gone.
    assert.ok(!p.exists(".opencode/commands/ref-bool.md"), "stale generated command must be deleted");
    // User-authored file survives byte-for-byte.
    assert.equal(p.read(".opencode/commands/ref-str.md"), userContent, "user file must be untouched");
    // The plain skill regenerates as usual in the same pass.
    assert.ok(isGenerated(p.read(".opencode/commands/plain-skill.md")), "plain-skill regenerates");
    // 2 updates (ref-bool deletion + plain-skill generation), 1 skipped (ref-str).
    assert.match(r.stdout, /2 updated, 1 user-modified \(skipped\)/);
  } finally {
    p.cleanup();
  }
});
