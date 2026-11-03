import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "adlc-cli.mjs");

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-cli-cmd-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("adlc-cli workflow search lists catalog entries", () => {
  const res = spawnSync("node", [CLI, "workflow", "search"], { encoding: "utf-8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /factory/);
  assert.match(res.stdout, /Factory Outer Loop/);
});

test("adlc-cli workflow search with query filters results", () => {
  const match = spawnSync("node", [CLI, "workflow", "search", "outer"], { encoding: "utf-8" });
  assert.equal(match.status, 0);
  assert.match(match.stdout, /factory/);

  const nomatch = spawnSync("node", [CLI, "workflow", "search", "xyznonexistent"], { encoding: "utf-8" });
  assert.equal(nomatch.status, 0);
  assert.match(nomatch.stdout, /No workflows found/i);
});

test("adlc-cli workflow add installs workflow into .adlc/workflows/", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const res = spawnSync("node", [CLI, "workflow", "add", "factory"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Installed workflow 'factory'/i);
    assert.ok(existsSync(join(dir, ".adlc", "workflows", "factory", "workflow.yml")));

    const listRes = spawnSync("node", [CLI, "workflow", "list"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(listRes.status, 0);
    assert.match(listRes.stdout, /Installed workflows/i);
    assert.match(listRes.stdout, /factory/);
  } finally {
    cleanup();
  }
});

test("adlc-cli workflow list shows installed and bundled workflows", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const res = spawnSync("node", [CLI, "workflow", "list"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Bundled workflows/i);
    assert.match(res.stdout, /factory/);
  } finally {
    cleanup();
  }
});
