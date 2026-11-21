import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readLocalHooksManifest,
  fetchHooksManifest,
  resolveHooks,
  installHooks,
  removeHooks,
} from "../src/hooks.mjs";

const SAMPLE = {
  hooks: {
    session_start: [{ skill: "team-boot", timeout: 60 }],
  },
};

describe("Hooks: manifest discovery (canonical)", () => {
  it("reads local .hooks.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-hooks-"));
    try {
      writeFileSync(join(dir, ".hooks.json"), JSON.stringify(SAMPLE), "utf-8");
      const manifest = readLocalHooksManifest(dir);
      assert.deepEqual(Object.keys(manifest.hooks), ["session_start"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to deprecated .events.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-hooks-fallback-"));
    try {
      writeFileSync(
        join(dir, ".events.json"),
        JSON.stringify({ events: { session_start: [{ skill: "team-boot" }] } }),
        "utf-8",
      );
      const manifest = readLocalHooksManifest(dir);
      assert.ok(manifest, "fallback manifest resolved");
      const resolved = resolveHooks(manifest, { canonical_to_native: { session_start: "SessionStart" } });
      assert.deepEqual(Object.keys(resolved), ["session_start"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers .hooks.json over .events.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "adlc-hooks-prefer-"));
    try {
      writeFileSync(join(dir, ".hooks.json"), JSON.stringify(SAMPLE), "utf-8");
      writeFileSync(
        join(dir, ".events.json"),
        JSON.stringify({ events: { user_prompt_submit: [{ skill: "other" }] } }),
        "utf-8",
      );
      const manifest = readLocalHooksManifest(dir);
      assert.deepEqual(Object.keys(manifest.hooks), ["session_start"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetchHooksManifest resolves bare local dir with .hooks.json", async () => {
    const parent = mkdtempSync(join(tmpdir(), "adlc-hooks-bare-"));
    const origCwd = process.cwd();
    try {
      process.chdir(parent);
      const dirName = "skills-src-hooks";
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(parent, dirName), { recursive: true });
      writeFileSync(join(parent, dirName, ".hooks.json"), JSON.stringify(SAMPLE), "utf-8");
      const manifest = await fetchHooksManifest(dirName);
      assert.ok(manifest, "manifest resolved");
    } finally {
      process.chdir(origCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("deprecated events aliases still work", async () => {
    const { readLocalEventsManifest, fetchEventsManifest, resolveEvents } = await import("../src/events.mjs");
    const dir = mkdtempSync(join(tmpdir(), "adlc-events-alias-"));
    try {
      writeFileSync(join(dir, ".hooks.json"), JSON.stringify(SAMPLE), "utf-8");
      const manifest = readLocalEventsManifest(dir);
      assert.ok(manifest, "alias reads canonical file");
      assert.equal(typeof fetchEventsManifest, "function");
      assert.equal(typeof resolveEvents, "function");
      assert.equal(typeof installHooks, "function");
      assert.equal(typeof removeHooks, "function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
