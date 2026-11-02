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
  const factory = catalog.workflows.factory;
  assert.equal(factory.id, "factory");
  assert.equal(factory.name, "Factory Outer Loop");
  assert.ok(factory.path, "factory must specify path");
  assert.ok(existsSync(join(ROOT, factory.path)), `file at ${factory.path} must exist`);
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
