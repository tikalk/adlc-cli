import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStreamGuard } from "../src/format/stream-guard.mjs";

const flat = readFileSync("tests/fixtures/format/flat-team-context.txt", "utf8");
const clean = readFileSync("tests/fixtures/format/clean-team-context.md", "utf8").trimEnd();

test("none mode passes everything through", () => {
  const g = createStreamGuard({ mode: "none" });
  assert.deepEqual(g.push({ type: "message", text: flat }), [{ type: "message", text: flat }]);
  assert.deepEqual(g.flush(), []);
});

test("warn mode passes text through appends one warning", () => {
  const g = createStreamGuard({ mode: "warn" });
  assert.deepEqual(g.push({ type: "message", text: flat }), [{ type: "message", text: flat }]);
  const out = g.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "warning");
  assert.equal(out[0].code, "collapsed-markdown");
});

test("warn mode emits no warning clean text", () => {
  const g = createStreamGuard({ mode: "warn" });
  g.push({ type: "message", text: clean });
  assert.deepEqual(g.flush(), []);
});

test("fix mode buffers emits one repaired message", () => {
  const g = createStreamGuard({ mode: "fix" });
  assert.deepEqual(g.push({ type: "message", text: flat }), []);
  const out = g.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].text, clean);
});

test("flush is idempotent", () => {
  const g = createStreamGuard({ mode: "fix" });
  g.push({ type: "message", text: flat });
  g.flush();
  assert.deepEqual(g.flush(), []);
});

test("flush after partial turn returns buffered text", () => {
  const g = createStreamGuard({ mode: "fix" });
  g.push({ type: "message", text: flat.slice(0, 100) });
  g.push({ type: "message", text: flat.slice(100) });
  const out = g.flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].text, clean);
});
