import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAssistantTexts, auditJsonl, auditOpencode, defaultSqliteJson } from "../src/format/audit.mjs";

test("extracts text from Claude-style assistant records", () => {
  const texts = extractAssistantTexts({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  assert.deepEqual(texts, ["hello"]);
});

test("extracts text from flat records", () => {
  assert.deepEqual(extractAssistantTexts({ type: "assistant", text: "hi" }), ["hi"]);
});

test("ignores user records", () => {
  assert.deepEqual(extractAssistantTexts({ type: "user", message: { content: [{ type: "text", text: "q" }] } }), []);
});

test("auditJsonl counts a collapsed record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-audit-"));
  mkdirSync(join(dir, "p"), { recursive: true });
  const flat = "## Team Context & Decisions | a | b | |--|--| | 1 | 2 | " + "x".repeat(900);
  writeFileSync(join(dir, "p", "s.jsonl"), JSON.stringify({ type: "assistant", text: flat }) + "\n");
  const r = await auditJsonl({ dir });
  assert.equal(r.scanned, 1);
  assert.equal(r.collapsed, 1);
});

test("auditOpencode maps injected sqlite rows", async () => {
  const flat = "## Team Context & Decisions | a | b | |--|--| | 1 | 2 | " + "x".repeat(900);
  const sqlite = () => [{ data: JSON.stringify({ content: [{ type: "text", text: flat }] }) }];
  const r = await auditOpencode({ dbPath: "unused", sqlite });
  assert.equal(r.collapsed, 1);
});

test("defaultSqliteJson refuses dash-prefixed db paths", () => {
  assert.throws(() => defaultSqliteJson("-x", "SELECT 1"), /suspicious --db/);
});
