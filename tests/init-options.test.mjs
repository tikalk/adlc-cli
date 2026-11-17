import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readInitOptions, writeInitOptions, readAgent, writeAgent, readSkillsSource, writeSkillsSource, readTeamAiDirectives } from "../src/utils/init-options.mjs";

test("writeInitOptions merges with existing fields", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    const dir = join(tmp, ".adlc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "init-options.json"), JSON.stringify({ team_ai_directives: "/existing" }));
    writeInitOptions({ agent: "opencode" }, tmp);
    const result = readInitOptions(tmp);
    assert.equal(result.team_ai_directives, "/existing");
    assert.equal(result.agent, "opencode");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("writeAgent preserves a previously configured primary agent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    const dir = join(tmp, ".adlc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "init-options.json"), JSON.stringify({ agent: "claude-code" }));
    writeAgent("opencode", tmp);
    assert.equal(readAgent(tmp), "claude-code");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("writeAgent sets the agent when none is configured", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    writeAgent("opencode", tmp);
    assert.equal(readAgent(tmp), "opencode");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
test("readAgent returns null when not configured", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try { assert.equal(readAgent(tmp), null); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("readSkillsSource returns null when not configured", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try { assert.equal(readSkillsSource(tmp), null); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("readTeamAiDirectives returns configured path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try {
    mkdirSync(join(tmp, ".adlc"), { recursive: true });
    writeFileSync(join(tmp, ".adlc", "init-options.json"), JSON.stringify({ team_ai_directives: "/path/to/td" }));
    assert.equal(readTeamAiDirectives(tmp), "/path/to/td");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), "adlc-test-"));
  try { fn(tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

test("readSkillsSource wraps a string source in an array", () => {
  withTmp((tmp) => {
    writeInitOptions({ skills_source: "a/b" }, tmp);
    assert.deepEqual(readSkillsSource(tmp), ["a/b"]);
  });
});

test("readSkillsSource reads an array source and drops blanks and duplicates", () => {
  withTmp((tmp) => {
    writeInitOptions({ skills_source: ["a/b", "", "a/b", "https://x/y.git"] }, tmp);
    assert.deepEqual(readSkillsSource(tmp), ["a/b", "https://x/y.git"]);
  });
});

test("writeSkillsSource keeps a single source as a string", () => {
  withTmp((tmp) => {
    writeSkillsSource("a/b", tmp);
    assert.equal(readInitOptions(tmp).skills_source, "a/b");
  });
});

test("writeSkillsSource adds a second source instead of overwriting", () => {
  withTmp((tmp) => {
    writeSkillsSource("a/b", tmp);
    writeSkillsSource("https://x/y.git", tmp);
    writeSkillsSource("a/b", tmp);
    assert.deepEqual(readInitOptions(tmp).skills_source, ["a/b", "https://x/y.git"]);
  });
});
