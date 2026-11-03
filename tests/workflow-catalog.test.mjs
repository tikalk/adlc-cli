import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  loadBundledCatalog,
  fetchWorkflowFromUrl,
  WorkflowRegistry,
  installWorkflow,
  searchCatalog,
  listWorkflows,
  MAX_WORKFLOW_BYTES,
  MAX_WORKFLOW_REDIRECTS,
} from "../src/workflow/catalog.mjs";

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-cat-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadBundledCatalog loads bundled catalog entries", () => {
  const catalog = loadBundledCatalog();
  assert.equal(catalog.schema_version, "1.0");
  assert.ok(catalog.workflows.factory);
  assert.equal(catalog.workflows.factory.id, "factory");
});

test("searchCatalog matches id, name, description, tags and empty query returns all", () => {
  const all = searchCatalog("");
  assert.ok(all.some((w) => w.id === "factory"));

  const byName = searchCatalog("outer loop");
  assert.ok(byName.some((w) => w.id === "factory"));

  const byTag = searchCatalog("outer-loop");
  assert.ok(byTag.some((w) => w.id === "factory"));

  const none = searchCatalog("nonexistent-xyz-999");
  assert.equal(none.length, 0);
});

test("WorkflowRegistry manages installed workflows atomically and safely", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const registry = new WorkflowRegistry(dir);
    assert.deepEqual(registry.list(), {});
    assert.equal(registry.isInstalled("factory"), false);

    registry.add("factory", { version: "1.0.0", source: "bundled" });
    assert.equal(registry.isInstalled("factory"), true);
    assert.equal(registry.get("factory").version, "1.0.0");
    assert.ok(registry.get("factory").installed_at);

    // Reopen registry from disk to verify persistence
    const reopened = new WorkflowRegistry(dir);
    assert.equal(reopened.isInstalled("factory"), true);
    assert.equal(reopened.get("factory").version, "1.0.0");

    assert.equal(registry.remove("factory"), true);
    assert.equal(registry.isInstalled("factory"), false);
  } finally {
    cleanup();
  }
});

test("WorkflowRegistry refuses symlinked registry path", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const realFile = join(dir, "real-registry.json");
    writeFileSync(realFile, JSON.stringify({ schema_version: "1.0", workflows: {} }));
    const symlinkPath = join(dir, "symlink-registry.json");
    symlinkSync(realFile, symlinkPath);

    assert.throws(
      () => new WorkflowRegistry(dir, symlinkPath),
      /symlink/i
    );
  } finally {
    cleanup();
  }
});

test("fetchWorkflowFromUrl fetches valid remote workflow", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/yaml" });
    res.end("workflow:\n  id: remote-test\n  name: Remote Test\nsteps: []\n");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/workflow.yml`;

  try {
    const res = await fetchWorkflowFromUrl(url);
    assert.match(res.yaml, /id:\s*remote-test/);
    assert.equal(res.url, url);
  } finally {
    server.close();
  }
});

test("fetchWorkflowFromUrl rejects HTTP errors with status and URL", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/missing.yml`;

  try {
    await assert.rejects(
      () => fetchWorkflowFromUrl(url),
      /Failed to fetch workflow from .* \(HTTP 404/
    );
  } finally {
    server.close();
  }
});

test("fetchWorkflowFromUrl rejects responses exceeding 5MB limit", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("a".repeat(MAX_WORKFLOW_BYTES + 10));
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/huge.yml`;

  try {
    await assert.rejects(
      () => fetchWorkflowFromUrl(url),
      /exceeds size limit/i
    );
  } finally {
    server.close();
  }
});

test("installWorkflow installs bundled workflow into project", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const result = await installWorkflow(dir, "factory");
    assert.equal(result.id, "factory");
    assert.ok(existsSync(join(dir, ".adlc", "workflows", "factory", "workflow.yml")));

    const list = listWorkflows(dir);
    assert.ok(list.installed.some((w) => w.id === "factory"));
    assert.ok(list.bundled.some((w) => w.id === "factory"));
  } finally {
    cleanup();
  }
});

test("installWorkflow rejects path traversal in workflow id or alias", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    await assert.rejects(
      () => installWorkflow(dir, "factory", { as: "../escape" }),
      /path traversal|invalid workflow id/i
    );
    await assert.rejects(
      () => installWorkflow(dir, "../escape"),
      /path traversal|invalid workflow id/i
    );
  } finally {
    cleanup();
  }
});

test("fetchWorkflowFromUrl rejects plain http:// on non-loopback hosts", async () => {
  await assert.rejects(
    () => fetchWorkflowFromUrl("http://example.com/workflow.yml"),
    /only https:\/\/ URLs are allowed/
  );
  await assert.rejects(
    () => fetchWorkflowFromUrl("ftp://example.com/workflow.yml"),
    /only https:\/\/ URLs are allowed/
  );
});

test("fetchWorkflowFromUrl follows loopback redirects and returns the final body", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/start.yml") {
      res.writeHead(302, { Location: "/final.yml" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/yaml" });
    res.end("workflow:\n  id: redirected\n  name: Redirected\nsteps: []\n");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/start.yml`;

  try {
    const res = await fetchWorkflowFromUrl(url);
    assert.match(res.yaml, /id:\s*redirected/);
  } finally {
    server.close();
  }
});

test("fetchWorkflowFromUrl rejects a redirect that downgrades to non-loopback http://", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { Location: "http://example.com/evil.yml" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/workflow.yml`;

  try {
    await assert.rejects(
      () => fetchWorkflowFromUrl(url),
      /Refusing to fetch workflow from http:\/\/example\.com\/evil\.yml/
    );
  } finally {
    server.close();
  }
});

test("fetchWorkflowFromUrl rejects redirect chains longer than the hop limit", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(302, { Location: `/hop-${hits}.yml` });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/workflow.yml`;

  try {
    await assert.rejects(
      () => fetchWorkflowFromUrl(url),
      /exceeded \d+ redirects/
    );
    assert.equal(hits, MAX_WORKFLOW_REDIRECTS + 1);
  } finally {
    server.close();
  }
});
