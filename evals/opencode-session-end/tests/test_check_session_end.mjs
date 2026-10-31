/**
 * test_check_session_end.mjs — grader unit tests for EVAL-001.
 *
 * Runs the goldset training cases (pass 1–2, fail 1–2, adversarial 1–3)
 * against gradeSessionEnd() and requires 100% training accuracy.
 * The holdout set (ADV-4, ADV-5) is NEVER loaded here — holdout lock.
 *
 * Run: node --test evals/opencode-session-end/tests/test_check_session_end.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { installEvents, resolveEvents } from "../../../src/events.mjs";
import { getEventAgentConfig } from "../../../src/registry.mjs";
import { gradeSessionEnd } from "../graders/check_session_end.mjs";

const MANIFEST = { events: { session_end: [{ skill: "team-levelup", timeout: 120 }] } };
const COMBINED_MANIFEST = {
  events: {
    session_end: [{ skill: "team-levelup", timeout: 120 }],
    file_edited: [{ skill: "team-boot", timeout: 10 }],
  },
};

function buildPlugin(manifest) {
  const projectRoot = mkdtempSync(join(tmpdir(), "adlc-eval-"));
  try {
    const resolved = resolveEvents(manifest, getEventAgentConfig("opencode"));
    installEvents("opencode", projectRoot, resolved, ".agents/skills");
    const content = readFileSync(join(projectRoot, ".opencode/plugins/adlc-skills-events.ts"), "utf-8");
    return { resolved, content };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe("EVAL-001 grader: goldset training cases", () => {
  it("PASS-1: session_end-only manifest resolves with native fallback", () => {
    const resolved = resolveEvents(MANIFEST, getEventAgentConfig("opencode"));
    const { content } = buildPlugin(MANIFEST);
    const result = gradeSessionEnd({ resolved, pluginContent: content });
    assert.equal(result.score, 1.0, `expected pass, failures: ${result.failures.join("; ")}`);
  });

  it("PASS-2: generated plugin carries V1 + V2 session.deleted paths", () => {
    const { resolved, content } = buildPlugin(MANIFEST);
    // Explicit per-string assertions mirror the goldset expected output.
    assert.ok(content.includes('event.type === "session.deleted"'), "V1 branch");
    assert.ok(content.includes('"session_end"'), "canonical dispatch");
    assert.ok(content.includes('"team-levelup"'), "skill routing");
    assert.ok(content.includes("ctx.event.subscribe"), "V2 stream");
    const result = gradeSessionEnd({ resolved, pluginContent: content });
    assert.equal(result.score, 1.0, `expected pass, failures: ${result.failures.join("; ")}`);
  });

  it("FAIL-1: pre-fix null mapping drops the event → grader scores 0.0", () => {
    // Simulate the shipped bug: resolution yields no session_end runs.
    const resolved = {};
    const result = gradeSessionEnd({ resolved, pluginContent: "" });
    assert.equal(result.score, 0.0, "grader must fail a dropped event");
    assert.ok(result.failures.length > 0, "failures explain the drop");
  });

  it("FAIL-2: combined manifest keeps exactly ONE event entry with both branches", () => {
    const { resolved, content } = buildPlugin(COMBINED_MANIFEST);
    const entries = content.match(/"event": async \(\{ event \}\) => \{/g) || [];
    assert.equal(entries.length, 1, "single-entry semantics (b9382cc)");
    const result = gradeSessionEnd({ resolved, pluginContent: content, expectFileEdited: true });
    assert.equal(result.score, 1.0, `expected pass, failures: ${result.failures.join("; ")}`);
  });

  it("FAIL-2 negative: missing file.edited branch → grader scores 0.0", () => {
    const { resolved, content } = buildPlugin(COMBINED_MANIFEST);
    const stripped = content.replace('event.type === "file.edited"', 'event.type === "file.changed"');
    const result = gradeSessionEnd({ resolved, pluginContent: stripped, expectFileEdited: true });
    assert.equal(result.score, 0.0, "grader must fail a broken file.edited branch");
  });

  it("ADV-1: mapping regression to null → grader scores 0.0", () => {
    const resolved = { session_end: [{ skill: "team-levelup", timeout: 120, nativeEvent: null }] };
    const result = gradeSessionEnd({ resolved, pluginContent: "// no session.deleted anywhere" });
    assert.equal(result.score, 0.0, "grader must fail a null nativeEvent regression");
  });

  it("ADV-2: duplicate event keys (two entries) → grader scores 0.0", () => {
    const { resolved, content } = buildPlugin(MANIFEST);
    // Duplicate the entry the way two object keys would render pre-b9382cc.
    const doubled = content.replace(
      /"event": async \(\{ event \}\) => \{/,
      '"event": async ({ event }) => {\n    },\n    "event": async ({ event }) => {',
    );
    const result = gradeSessionEnd({ resolved, pluginContent: doubled });
    assert.equal(result.score, 0.0, "grader must fail duplicate event entries");
  });

  it("ADV-3: V1-only regression (V2 subscribe stripped) → grader scores 0.0", () => {
    const { resolved, content } = buildPlugin(MANIFEST);
    assert.ok(content.includes("ctx.event.subscribe"), "precondition: V2 present before strip");
    const stripped = content.replace(/ctx\.event\.subscribe/g, "ctx.event.removed");
    const result = gradeSessionEnd({ resolved, pluginContent: stripped });
    assert.equal(result.score, 0.0, "grader must fail a V1-only plugin");
  });
});
