// Transcript audit (format-guard): read-only scan of assistant texts.
//
// Scans Claude-style JSONL transcripts and OpenCode session SQLite rows.
// Pure aggregation — never writes, never repairs.

import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { detectCollapsed } from "./detect.mjs";

export const AUDIT_LONG_MIN = 800;

export function extractAssistantTexts(record) {
  if (!record || typeof record !== "object") return [];
  if (record.type === "user" || record.message?.role === "user") return [];
  const out = [];
  const pushText = (v) => {
    if (typeof v === "string" && v) out.push(v);
  };
  const parts = record.message?.content ?? record.content;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      if (typeof p === "string") pushText(p);
      else if (p && typeof p === "object" && p.type === "text") pushText(p.text);
    }
    if (out.length > 0) return out;
  }
  pushText(record.text);
  return out;
}

function recordTimeMs(record) {
  for (const key of ["timestamp", "time", "time_created", "created"]) {
    const v = record?.[key] ?? record?.message?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v === "string" && v) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return null;
}

function aggregate(entries) {
  const long = entries.filter((e) => e.text.length >= AUDIT_LONG_MIN);
  const byFamily = {};
  const samples = [];
  let collapsed = 0;
  for (const e of long) {
    const r = detectCollapsed(e.text);
    if (!r.collapsed) continue;
    collapsed += 1;
    byFamily[r.family] = (byFamily[r.family] ?? 0) + 1;
    if (samples.length < 10) {
      samples.push({ sessionID: e.sessionID, seq: e.seq, chars: e.text.length, family: r.family });
    }
  }
  return {
    scanned: entries.length,
    long: long.length,
    collapsed,
    rate: long.length === 0 ? 0 : collapsed / long.length,
    byFamily,
    samples,
  };
}

function walkJsonl(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkJsonl(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
  }
  return found;
}

export async function auditJsonl({ dir, sinceMs = 0 } = {}) {
  const entries = [];
  for (const file of walkJsonl(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    let seq = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      seq += 1;
      if (sinceMs) {
        const t = recordTimeMs(record);
        if (t !== null && t < sinceMs) continue;
      }
      for (const text of extractAssistantTexts(record)) {
        entries.push({ text, sessionID: file, seq });
      }
    }
  }
  return aggregate(entries);
}

export function defaultSqliteJson(dbPath, sql) {
  let raw;
  try {
    raw = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
  } catch (cause) {
    if (cause?.code === "ENOENT") throw new Error("sqlite3 is required for --source opencode");
    throw cause;
  }
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

const OPENCODE_SQL =
  "SELECT data FROM session_message WHERE type='assistant' ORDER BY time_created DESC LIMIT 4000";

export async function auditOpencode({ dbPath, sinceMs = 0, sqlite = defaultSqliteJson } = {}) {
  const rows = sqlite(dbPath, OPENCODE_SQL);
  const entries = [];
  let seq = 0;
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.data);
    } catch {
      continue;
    }
    seq += 1;
    if (sinceMs) {
      const t = recordTimeMs(payload) ?? recordTimeMs(row);
      if (t !== null && t < sinceMs) continue;
    }
    for (const text of extractAssistantTexts(payload)) {
      entries.push({ text, sessionID: dbPath, seq });
    }
  }
  return aggregate(entries);
}
