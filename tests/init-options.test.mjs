import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readInitOptions, writeInitOptions, readAgent, readSkillsSource, readTeamAiDirectives } from "../src/utils/init-options.mjs";

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
