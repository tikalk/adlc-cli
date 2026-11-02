import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.mjs";

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-eng-res-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("engine.loadWorkflow resolves bundled 'factory' workflow", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.name, "Factory Outer Loop");
    assert.ok(def.sourcePath.includes("workflows/factory/workflow.yml") || def.sourcePath.includes("workflows/factory"));
    assert.ok(def.sourceYaml);
  } finally {
    cleanup();
  }
});

test("engine.loadWorkflow prioritizes workspace installed workflow over bundled asset", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const installedDir = join(dir, ".adlc", "workflows", "factory");
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, "workflow.yml"),
      "schema_version: '1.0'\nworkflow:\n  id: factory\n  name: Custom Workspace Factory\nsteps: []\n"
    );

    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.name, "Custom Workspace Factory");
  } finally {
    cleanup();
  }
});

test("engine.loadWorkflow resolves direct HTTP/HTTPS URL", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/yaml" });
    res.end("schema_version: '1.0'\nworkflow:\n  id: url-flow\n  name: From URL\nsteps: []\n");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/workflow.yml`;

  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow(url);
    assert.equal(def.id, "url-flow");
    assert.equal(def.name, "From URL");
    assert.equal(def.sourcePath, url);
  } finally {
    server.close();
    cleanup();
  }
});

test("engine.loadWorkflow throws clear error when workflow cannot be resolved", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    assert.throws(
      () => engine.loadWorkflow("nonexistent-flow-12345"),
      /Workflow not found: nonexistent-flow-12345/
    );
  } finally {
    cleanup();
  }
});
