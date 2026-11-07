// Deterministic reflow for collapsed Markdown (format-guard).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reflowMarkdown } from "../src/format/reflow.mjs";

const flat = readFileSync("tests/fixtures/format/flat-team-context.txt", "utf8");
const clean = readFileSync("tests/fixtures/format/clean-team-context.md", "utf8").trimEnd();
const nonWs = (s) => s.replace(/\s/g, "").length;
const pipes = (s) => (s.match(/\|/g) ?? []).length;

test("reflows the flat Team Context block into the expected clean form", () => {
  const r = reflowMarkdown(flat);
  assert.equal(r.ambiguous, false);
  assert.equal(r.text, clean);
});

test("reflow is idempotent", () => {
  const once = reflowMarkdown(flat).text;
  assert.equal(reflowMarkdown(once).text, once);
});

test("reflow preserves non-whitespace content and pipe count", () => {
  const out = reflowMarkdown(flat).text;
  assert.equal(nonWs(out), nonWs(flat));
  assert.equal(pipes(out), pipes(flat));
});

test("reflow keeps prose before the first heading", () => {
  const input = "Here is the summary. ## Result | a | b | |--|--| | 1 | 2 |";
  const out = reflowMarkdown(input).text;
  assert.match(out, /^Here is the summary\.\n\n## Result/);
});

test("reflow protects fenced code", () => {
  const input = "Intro ## Not a heading\n```md\n## still code\n```";
  const out = reflowMarkdown(input).text;
  assert.ok(out.includes("```md\n## still code\n```"));
});

test("reflow keeps pipes inside inline code within a table", () => {
  const input = "## T | a | b | |--|--| | `x | y` | 2 |";
  const out = reflowMarkdown(input).text;
  assert.ok(out.includes("`x | y`"));
  assert.equal(pipes(out), pipes(input));
});

test("ambiguous table returns the original untouched", () => {
  const input = readFileSync("tests/fixtures/format/ambiguous-table.txt", "utf8");
  const r = reflowMarkdown(input);
  assert.equal(r.ambiguous, true);
  assert.equal(r.text, input);
});
