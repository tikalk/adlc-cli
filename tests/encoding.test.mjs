// UTF-8 BOM normalization (Windows PowerShell 5.1 ANSI misread fix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureUtf8Bom, normalizePs1Scripts } from "../src/utils/encoding.mjs";

const hasBom = (buf) => buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

test("ensureUtf8Bom: adds BOM to non-ASCII file", () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-bom-"));
  const file = join(dir, "boot.ps1");
  writeFileSync(file, "Write-Host 'café — test'");
  assert.equal(ensureUtf8Bom(file), true);
  const buf = readFileSync(file);
  assert.ok(hasBom(buf), "has UTF-8 BOM");
  assert.equal(buf.slice(3).toString("utf-8"), "Write-Host 'café — test'");
});

test("ensureUtf8Bom: idempotent on already-BOM'd file", () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-bom-"));
  const file = join(dir, "boot.ps1");
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("café")]));
  assert.equal(ensureUtf8Bom(file), false);
  const buf = readFileSync(file);
  assert.ok(hasBom(buf));
  assert.equal(buf.length, 3 + Buffer.byteLength("café"));
});

test("ensureUtf8Bom: skips pure-ASCII file (safe under any codepage)", () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-bom-"));
  const file = join(dir, "boot.ps1");
  const before = "Write-Host 'hello'\n";
  writeFileSync(file, before);
  assert.equal(ensureUtf8Bom(file), false);
  assert.equal(readFileSync(file, "utf-8"), before);
});

test("ensureUtf8Bom: skips non-UTF-8 (never corrupts)", () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-bom-"));
  const file = join(dir, "boot.ps1");
  // 0x94 standalone is invalid UTF-8 (latin-1 byte)
  const original = Buffer.from([0x57, 0x94, 0x58]);
  writeFileSync(file, original);
  assert.equal(ensureUtf8Bom(file), false);
  assert.deepEqual(readFileSync(file), original);
});

test("ensureUtf8Bom: returns false for missing file", () => {
  assert.equal(ensureUtf8Bom(join(tmpdir(), "adlc-nope", "missing.ps1")), false);
});

test("normalizePs1Scripts: recursive, only .ps1, counts rewrites", () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-bom-"));
  mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
  writeFileSync(join(dir, "a.ps1"), "café");
  writeFileSync(join(dir, "nested", "b.ps1"), "naïve");
  writeFileSync(join(dir, "nested", "deeper", "c.PS1"), "—");
  writeFileSync(join(dir, "ascii.ps1"), "plain");
  writeFileSync(join(dir, "notes.md"), "café — not rewritten");

  assert.equal(normalizePs1Scripts(dir), 3);
  assert.ok(hasBom(readFileSync(join(dir, "a.ps1"))));
  assert.ok(hasBom(readFileSync(join(dir, "nested", "b.ps1"))));
  assert.ok(hasBom(readFileSync(join(dir, "nested", "deeper", "c.PS1"))));
  assert.ok(!hasBom(readFileSync(join(dir, "ascii.ps1"))));
  assert.ok(!hasBom(readFileSync(join(dir, "notes.md"))));

  // Second pass: everything already handled → 0 rewrites
  assert.equal(normalizePs1Scripts(dir), 0);
});

test("normalizePs1Scripts: missing root returns 0", () => {
  assert.equal(normalizePs1Scripts(join(tmpdir(), "adlc-nope", "skills")), 0);
  assert.equal(existsSync(join(tmpdir(), "adlc-nope", "skills")), false);
});
