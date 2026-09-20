// Normalizer + output contract tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLine } from "../src/run-events.mjs";

const readLines = (file) =>
  readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

const parseJsonl = (lines) => lines.map((l) => JSON.parse(l));

const expected = readLines("tests/fixtures/contract/expected-normalized.jsonl");

test("normalizeLine: opencode native → normalized (all 6 event types)", () => {
  const native = readFileSync("tests/fixtures/contract/opencode-native.jsonl", "utf-8")
    .trim().split("\n").filter(Boolean);
  const out = native.flatMap((line) => normalizeLine(line, "json"));
  assert.equal(out.length, expected.length, "same event count");
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(out[i], expected[i], `event ${i}: ${JSON.stringify(out[i])} vs ${JSON.stringify(expected[i])}`);
  }
});

test("normalizeLine: stream-json native → normalized (all 6 event types)", () => {
  const native = readFileSync("tests/fixtures/contract/stream-json-native.jsonl", "utf-8")
    .trim().split("\n").filter(Boolean);
  const out = native.flatMap((line) => normalizeLine(line, "stream-json"));
  assert.equal(out.length, expected.length, "same event count");
  for (let i = 0; i < expected.length; i++) {
    assert.deepEqual(out[i], expected[i], `event ${i}: ${JSON.stringify(out[i])} vs ${JSON.stringify(expected[i])}`);
  }
});

test("normalizeLine: non-JSON line → log event", () => {
  const out = normalizeLine("some plain text log line", "json");
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "log");
  assert.equal(out[0].message, "some plain text log line");
});

test("normalizeLine: empty line → empty array", () => {
  assert.deepEqual(normalizeLine("", "json"), []);
  assert.deepEqual(normalizeLine("   ", "json"), []);
});

test("normalized events have exactly the spec vocabulary types", () => {
  const validTypes = new Set(["message", "tool", "permission_request", "error", "complete", "log"]);
  const native = readFileSync("tests/fixtures/contract/opencode-native.jsonl", "utf-8")
    .trim().split("\n").filter(Boolean);
  const out = native.flatMap((line) => normalizeLine(line, "json"));
  for (const e of out) {
    assert.ok(validTypes.has(e.type), `unexpected type: ${e.type}`);
  }
});

// End-to-end: runTask + normalizeLine together (the contract Task 7 copies)
import { runTask } from "../src/run.mjs";

test("runTask + normalizeLine: fake agent → normalized JSONL contract", async () => {
  const fakeProfile = {
    binary: process.execPath,
    args: ["tests/fixtures/fake-agent.mjs"],
    promptPosition: "arg",
    outputFormat: "json",
    permissionMode: "auto",
    modelFlag: null,
  };
  const out = [];
  const { promise } = runTask({
    profile: fakeProfile,
    prompt: "hello",
    onLine: (line) => {
      for (const e of normalizeLine(line, "json")) {
        out.push(e);
      }
    },
  });
  const { code } = await promise;
  assert.equal(code, 7);
  assert.ok(out.some((e) => e.type === "message" && e.text.includes("hello from fake agent")));
  assert.ok(out.some((e) => e.type === "complete"));
});
