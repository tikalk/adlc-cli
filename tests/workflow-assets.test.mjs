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

test("workflows/factory/supervised/workflow.yml exists and declares plan, spec-gate, and execute", () => {
  const wfPath = join(ROOT, "workflows", "factory", "supervised", "workflow.yml");
  assert.ok(existsSync(wfPath), "workflows/factory/supervised/workflow.yml must exist");
  const content = readFileSync(wfPath, "utf-8");
  assert.match(content, /id:\s*factory-supervised/);
  assert.match(content, /id:\s*plan/);
  assert.match(content, /--plan/);
  assert.match(content, /id:\s*gate-spec/);
  assert.match(content, /type:\s*gate/);
  assert.match(content, /id:\s*execute/);
});

test("workflows/factory/workflow.yml exists and declares all required factory steps", () => {
  const wfPath = join(ROOT, "workflows", "factory", "workflow.yml");
  assert.ok(existsSync(wfPath), "workflows/factory/workflow.yml must exist");
  const content = readFileSync(wfPath, "utf-8");
  assert.match(content, /id:\s*factory/);
  assert.match(content, /id:\s*run-branch/);
  assert.match(content, /id:\s*intent-product/);
  assert.match(content, /id:\s*publish-product/);
  assert.match(content, /id:\s*gate-product/);
  assert.match(content, /id:\s*run-branch-architecture/);
  assert.match(content, /id:\s*intent-architecture/);
  assert.match(content, /id:\s*publish-architecture/);
  assert.match(content, /id:\s*gate-architecture/);
  assert.match(content, /id:\s*execute/);
  assert.match(content, /id:\s*gate-completion/);
  assert.match(content, /id:\s*sweep/);
});

test("package.json files field includes 'workflows/'", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("workflows/") || pkg.files.includes("workflows"), "package.json files must include workflows/");
});
