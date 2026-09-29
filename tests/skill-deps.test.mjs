import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { fetchSkillsDeps, expandSkillSelection } from "../src/events.mjs";

const DEPS = {
  version: "1.0.0",
  requires: {
    "architect-implement": ["architect-clarify"],
    "product-implement": ["product-clarify"],
    "a": ["b"],
    "b": ["c"],
    "x": ["y"],
    "y": ["x"],
  },
};

function fixtureSource(withDeps = true) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-deps-"));
  if (withDeps) {
    writeFileSync(join(dir, ".skills-deps.json"), JSON.stringify(DEPS), "utf-8");
  }
  return dir;
}

describe("Skill dependency closure (.skills-deps.json)", () => {
  it("fetchSkillsDeps reads a local source dir", async () => {
    const dir = fixtureSource();
    try {
      const manifest = await fetchSkillsDeps(dir);
      assert.ok(manifest);
      assert.deepEqual(manifest.requires["architect-implement"], ["architect-clarify"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchSkillsDeps returns null when the manifest is absent", async () => {
    const dir = fixtureSource(false);
    try {
      assert.equal(await fetchSkillsDeps(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchSkillsDeps returns null for malformed JSON", async () => {
    const dir = fixtureSource(false);
    try {
      writeFileSync(join(dir, ".skills-deps.json"), "{not json", "utf-8");
      assert.equal(await fetchSkillsDeps(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expands a borrower to its canonical home, selected first", () => {
    assert.deepEqual(expandSkillSelection(DEPS, "architect-implement"),
      ["architect-implement", "architect-clarify"]);
  });

  it("expands transitively (a → b → c)", () => {
    assert.deepEqual(expandSkillSelection(DEPS, "a"), ["a", "b", "c"]);
  });

  it("terminates on cycles (x ↔ y)", () => {
    assert.deepEqual(expandSkillSelection(DEPS, "x"), ["x", "y"]);
  });

  it("unknown skill stays a single-element selection (fail-open)", () => {
    assert.deepEqual(expandSkillSelection(DEPS, "nope"), ["nope"]);
  });

  it("missing manifest keeps the plain selection", () => {
    assert.deepEqual(expandSkillSelection(null, "architect-implement"), ["architect-implement"]);
  });

  it("null and wildcard filters mean 'all' (no expansion)", () => {
    assert.equal(expandSkillSelection(DEPS, null), null);
    assert.equal(expandSkillSelection(DEPS, "*"), null);
  });

  it("array input expands each member once (BFS order)", () => {
    assert.deepEqual(expandSkillSelection(DEPS, ["a", "architect-implement"]),
      ["a", "architect-implement", "b", "architect-clarify", "c"]);
  });
});
