import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("workflows/catalog.json exists and conforms to spec-kit catalog schema", () => {
  const catalogPath = join(ROOT, "workflows", "catalog.json");
  assert.ok(existsSync(catalogPath), "catalog.json must exist under workflows/");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
  assert.equal(catalog.schema_version, "1.0");
  assert.ok(catalog.workflows && typeof catalog.workflows === "object");
  assert.ok("factory" in catalog.workflows, "catalog must contain 'factory'");
  assert.ok("factory-autonomous" in catalog.workflows, "catalog must contain 'factory-autonomous'");
  assert.ok("factory-supervised" in catalog.workflows, "catalog must contain 'factory-supervised'");

  for (const [id, item] of Object.entries(catalog.workflows)) {
    assert.equal(item.id, id);
    assert.ok(item.name);
    assert.ok(item.path);
    assert.ok(existsSync(join(ROOT, item.path)), `file at ${item.path} must exist`);
  }
});

test("workflows/factory/autonomous/workflow.yml exists and declares direct execution", () => {
  const wfPath = join(ROOT, "workflows", "factory", "autonomous", "workflow.yml");
  assert.ok(existsSync(wfPath), "workflows/factory/autonomous/workflow.yml must exist");
  const content = readFileSync(wfPath, "utf-8");
  assert.match(content, /id:\s*factory-autonomous/);
  assert.match(content, /command:\s*factory-mission/);
  assert.ok(!content.includes("type: gate"), "autonomous workflow must not contain gate steps");
});

test("workflows/factory/supervised/workflow.yml exists and declares run-branch, plan, publish-spec, spec-gate, run-branch-execute, and execute", () => {
  const wfPath = join(ROOT, "workflows", "factory", "supervised", "workflow.yml");
  assert.ok(existsSync(wfPath), "workflows/factory/supervised/workflow.yml must exist");
  const content = readFileSync(wfPath, "utf-8");
  assert.match(content, /id:\s*factory-supervised/);
  assert.match(content, /id:\s*run-branch/);
  assert.match(content, /id:\s*plan/);
  assert.match(content, /--plan/);
  assert.match(content, /id:\s*publish-spec/);
  assert.match(content, /id:\s*gate-spec/);
  assert.match(content, /type:\s*gate/);
  assert.match(content, /records:\s*\[\s*"\.adlc\/drafts\/adr\/\*\.md"\s*,\s*"\.adlc\/drafts\/pdr\/\*\.md"\s*\]/);
  assert.match(content, /link:\s*"\{\{\s*steps\.publish-spec\.output\.mr_url\s*\|\s*default\(steps\.plan\.output\.mr_url\)\s*\}\}"/);
  assert.match(content, /id:\s*run-branch-execute/);
  assert.match(content, /id:\s*execute/);
});

test("workflows/factory/workflow.yml exists and declares all required factory steps", () => {
  const wfPath = join(ROOT, "workflows", "factory", "workflow.yml");
  assert.ok(existsSync(wfPath), "workflows/factory/workflow.yml must exist");
  const content = readFileSync(wfPath, "utf-8");
  assert.match(content, /id:\s*factory/);
  for (const id of ["preflight", "intent", "plan-link", "gate-intent", "gate-intent-decisions", "stop-if-plan-rejected", "run-branch-execute", "execute",
    "proof-of-work", "gate-completion", "stop-if-result-rejected"]) {
    assert.match(content, new RegExp(`id:\\s*${id}\\r?\\n`), `factory declares step ${id}`);
  }
  // Removed from adlc-team-skills on 2026-10-25: the bundled factory must never call them.
  assert.doesNotMatch(content, /command:\s*factory-(product|architect)\b/);
  // Fails closed: no step reports a missing helper as "skipped" and goes on (SF-LANE-05) —
  // except run-branch-execute, which mirrors supervised's deliberate skip-and-report
  // fallback (the execute step itself still fails closed via preflight/proof-of-work).
  for (const m of content.match(/helpers not installed/g) ?? []) {
    assert.ok(content.includes("run-branch-execute: skipped"), "the only 'helpers not installed' text is the run-branch-execute skip-and-report fallback");
  }
  // Step output (agent-written) is never templated into shell text: it reaches
  // a shell step only through `env:` (second review, 2026-11-21).
  const runBlocks = content.split(/^ {4}run: \|[-+]?\r?\n/m).slice(1).map((b) => b.split(/^ {2}- id:/m)[0]);
  assert.ok(runBlocks.length >= 5, "fixture: the shell steps were found");
  for (const block of runBlocks) {
    assert.doesNotMatch(block, /\{\{\s*steps\.(intent|execute)\./, "no agent step output inside a `run` script");
  }
});

test("package.json files field includes 'workflows/'", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("workflows/") || pkg.files.includes("workflows"), "package.json files must include workflows/");
});
