// Detector for collapsed Markdown output (format-guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { detectCollapsed } from "../src/format/detect.mjs";

const flat = readFileSync("tests/fixtures/format/flat-team-context.txt", "utf8");
const clean = readFileSync("tests/fixtures/format/clean-team-context.md", "utf8");

test("detects the flat Team Context block", () => {
  const r = detectCollapsed(flat);
  assert.equal(r.collapsed, true);
  assert.equal(r.family, "team-context");
  assert.ok(r.reasons.includes("zero-newlines"));
});

test("leaves a correctly formatted block alone", () => {
  assert.equal(detectCollapsed(clean).collapsed, false);
});

test("ignores short single-line text", () => {
  assert.equal(detectCollapsed("## Done — everything passed.").collapsed, false);
});

test("ignores URLs", () => {
  assert.equal(
    detectCollapsed("https://example.com/a/very/long/path?with=query&and=more").collapsed,
    false
  );
});

test("ignores JSON", () => {
  const json = JSON.stringify({ a: 1, b: [2, 3], c: "x".repeat(300) });
  const r = detectCollapsed(json);
  assert.equal(r.collapsed, false);
  assert.ok(r.reasons.includes("protected-shape"));
});

test("ignores a single fenced code block", () => {
  const text = "```js\n" + "const x = 1;\n".repeat(80) + "```";
  const r = detectCollapsed(text);
  assert.equal(r.collapsed, false);
  assert.ok(r.reasons.includes("protected-shape"));
});

test("flags long markdown with two structural markers", () => {
  const text = "## Result | a | b | |--|--| | 1 | 2 | " + "x".repeat(250);
  const r = detectCollapsed(text);
  assert.equal(r.collapsed, true);
  assert.equal(r.family, "markdown");
});
