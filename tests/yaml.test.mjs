// YAML parser contract for workspace files (workspace.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml } from "../src/utils/yaml.mjs";

const PROFILE = `
schema_version: "1.0"
name: "Tikal Default Workspace"
version: "1.0.0"
agent: opencode

workspace:
  git:
    - repo: https://github.com/org/backend
      path: backend
      branch: main
    - repo: git@github.com:tikalk/adlc-team-skills.git
      path: adlc-team-skills
      ref: v2.3.0
  link: true
  init: true

skills:
  sources:
    - tikalk/adlc-team-skills

goal: "Run /team-setup to configure team-ai-directives for this project"

commands:
  - skills add tikalk/adlc-team-skills
  - team setup tikalk/adlc-team-skills
  - agent run "Fetch and follow instructions from https://example.com/INSTALL.md"
`;

test("parses a full workspace file", () => {
  const p = parseYaml(PROFILE);
  assert.equal(p.schema_version, "1.0");
  assert.equal(p.name, "Tikal Default Workspace");
  assert.equal(p.agent, "opencode");
  assert.equal(p.workspace.link, true);
  assert.equal(p.workspace.init, true);
  assert.equal(p.workspace.git.length, 2);
  assert.equal(p.workspace.git[0].repo, "https://github.com/org/backend");
  assert.equal(p.workspace.git[0].path, "backend");
  assert.equal(p.workspace.git[0].branch, "main");
  assert.equal(p.workspace.git[1].repo, "git@github.com:tikalk/adlc-team-skills.git");
  assert.equal(p.workspace.git[1].ref, "v2.3.0");
  assert.deepEqual(p.skills.sources, ["tikalk/adlc-team-skills"]);
  assert.equal(p.goal, "Run /team-setup to configure team-ai-directives for this project");
  assert.equal(p.commands.length, 3);
  assert.equal(p.commands[0], "skills add tikalk/adlc-team-skills");
  assert.equal(
    p.commands[2],
    'agent run "Fetch and follow instructions from https://example.com/INSTALL.md"',
  );
});

test("parses scalars: booleans, numbers, null, quotes", () => {
  const p = parseYaml("a: true\nb: false\nc: 42\nd: 3.14\ne: null\nf: 'quoted'\ng: \"dq\"");
  assert.equal(p.a, true);
  assert.equal(p.b, false);
  assert.equal(p.c, 42);
  assert.equal(p.d, 3.14);
  assert.equal(p.e, null);
  assert.equal(p.f, "quoted");
  assert.equal(p.g, "dq");
});

test("parses values containing colons (URLs, SSH remotes)", () => {
  const p = parseYaml("repo: https://github.com/org/repo.git\nremote: git@github.com:org/repo.git");
  assert.equal(p.repo, "https://github.com/org/repo.git");
  assert.equal(p.remote, "git@github.com:org/repo.git");
});

test("parses list items without continuation keys as scalars", () => {
  const p = parseYaml("commands:\n  - skills add tikalk/adlc-team-skills\n  - team setup tikalk/adlc-team-skills");
  assert.deepEqual(p.commands, ["skills add tikalk/adlc-team-skills", "team setup tikalk/adlc-team-skills"]);
});

test("parses nested empty key as null", () => {
  const p = parseYaml("top:\n  missing:\npresent: 1");
  assert.equal(p.top.missing, null);
  assert.equal(p.present, 1);
});

test("handles comments and blank lines", () => {
  const p = parseYaml("# comment\n\nkey: value # trailing\n");
  assert.equal(p.key, "value");
});

test("returns null for empty document", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# only comments\n"), null);
});

test("parses folded block scalars", () => {
  const p = parseYaml("goal: >\n  Run the setup\n  for this project\nnext: 1");
  assert.equal(p.goal, "Run the setup for this project");
  assert.equal(p.next, 1);
});
