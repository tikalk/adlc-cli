// UTF-8 BOM normalization for PowerShell scripts.
//
// Windows PowerShell 5.1 (powershell.exe) reads BOM-less .ps1 files using the
// system ANSI codepage (windows-1251/1252/...). Multi-byte UTF-8 sequences
// then decode to arbitrary characters — an em dash (E2 80 94) becomes
// U+201D RIGHT DOUBLE QUOTATION MARK on windows-1251/1252, which PowerShell
// treats as a string delimiter, so the tokenizer flips string state mid-file
// and the script fails to parse ("Missing closing ')'", cascading
// "unexpected token" errors). A UTF-8 BOM makes 5.1 decode the file as UTF-8
// regardless of the system locale; PowerShell 7+ and bash ignore it.
//
// Rewrites are conservative: skip files that already have a BOM (any
// encoding), are pure ASCII (safe under every codepage), or are not valid
// UTF-8 (a rewrite would corrupt them).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function ensureUtf8Bom(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return false;
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return false;
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return false; // UTF-16 BOM — already charset-explicit, leave alone
  }
  if (!buf.some((b) => b > 0x7f)) return false; // pure ASCII — safe under any ANSI codepage
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return false; // not UTF-8 — never rewrite blindly
  }
  try {
    writeFileSync(file, Buffer.concat([UTF8_BOM, buf]));
  } catch {
    return false;
  }
  return true;
}

export function normalizePs1Scripts(root) {
  // Recursively add the UTF-8 BOM to non-ASCII .ps1 files under root.
  // Returns the number of files rewritten (0 when root is missing/unreadable).
  let fixed = 0;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      fixed += normalizePs1Scripts(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".ps1")) {
      if (ensureUtf8Bom(full)) fixed++;
    }
  }
  return fixed;
}
