// Agent-composed gate payloads (ADR-515; adlc-workspace#164).
//
// A command step before a gate may leave runs/<run_id>/gate-payloads/<gate_id>.json:
//   { "summary": "…", "title"?: "…", "sections"?: [{heading, body}],
//     "artifacts"?: [{label, url}] }
// The gate renders it under the first line of its message, capped, so the
// approver sees what is being approved even when no MR exists. The values are
// agent-written and untrusted: control characters are stripped, lengths are
// capped, and only plain http(s) artifact URLs survive. Slack escaping stays
// with the runtime renderer (agentic-container gate-message.ts).
//
// Not in this version (ADR-515/516 follow-up): agent-proposed `options` and
// revise routing. An `options` key is accepted and ignored.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GATE_PAYLOAD_MAX_LINES = 30;
export const GATE_PAYLOAD_MAX_CHARS = 2000;
const MAX_FILE = 64 * 1024;
const MAX_SECTIONS = 8;
const MAX_ARTIFACTS = 8;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_URL = /^https?:\/\/[^\s<>|]{1,2040}$/i;
// C0/C1 controls except \n and \t.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const clean = (s, max) => {
  const t = String(s).replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export function gatePayloadsDir(projectRoot, runId) {
  if (!projectRoot || typeof runId !== "string" || !SAFE_ID.test(runId)) return null;
  return join(projectRoot, ".adlc", "workflows", "runs", runId, "gate-payloads");
}

/**
 * Read and validate the payload for one gate.
 * @returns {{present: boolean, payload: object|null, why?: string}}
 */
export function readGatePayload(projectRoot, runId, gateId) {
  const dir = gatePayloadsDir(projectRoot, runId);
  if (!dir || typeof gateId !== "string" || !SAFE_ID.test(gateId)) return { present: false, payload: null };
  const path = join(dir, `${gateId}.json`);
  if (!existsSync(path)) return { present: false, payload: null };
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { present: true, payload: null, why: `unreadable: ${err.code ?? err.message}` };
  }
  if (raw.length > MAX_FILE) return { present: true, payload: null, why: "file too large" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { present: true, payload: null, why: "not JSON" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { present: true, payload: null, why: "not a JSON object" };
  }
  if (typeof data.summary !== "string" || data.summary.trim() === "") {
    return { present: true, payload: null, why: "missing summary" };
  }
  const payload = { summary: clean(data.summary, 1000) };
  if (typeof data.title === "string" && data.title.trim()) payload.title = clean(data.title, 200);
  if (Array.isArray(data.sections)) {
    payload.sections = data.sections
      .filter((s) => s && typeof s === "object" && typeof s.heading === "string" && typeof s.body === "string")
      .slice(0, MAX_SECTIONS)
      .map((s) => ({ heading: clean(s.heading, 120), body: clean(s.body, 1500) }))
      .filter((s) => s.heading || s.body);
  }
  if (Array.isArray(data.artifacts)) {
    payload.artifacts = data.artifacts
      .filter((a) => a && typeof a === "object" && typeof a.url === "string" && SAFE_URL.test(a.url.trim()))
      .slice(0, MAX_ARTIFACTS)
      .map((a) => ({ label: clean(typeof a.label === "string" && a.label.trim() ? a.label : a.url, 200), url: a.url.trim() }));
  }
  return { present: true, payload };
}

/** The payload as message lines, capped by line count and characters. */
export function renderGatePayload(payload) {
  const lines = [];
  if (payload.title) lines.push(payload.title);
  lines.push(...payload.summary.split("\n"));
  for (const s of payload.sections ?? []) {
    lines.push("", `${s.heading}:`);
    lines.push(...s.body.split("\n"));
  }
  if (payload.artifacts?.length) {
    lines.push("");
    for (const a of payload.artifacts) lines.push(a.label === a.url ? a.url : `${a.label}: ${a.url}`);
  }
  const out = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= GATE_PAYLOAD_MAX_LINES - 1 || chars + line.length + 1 > GATE_PAYLOAD_MAX_CHARS - 20) {
      out.push("…(truncated)");
      return out.join("\n");
    }
    out.push(line);
    chars += line.length + 1;
  }
  return out.join("\n");
}

/**
 * The gate message with its payload block (or the fallback note) under the
 * first line. `expected` is the gate's `payload: true` opt-in: only then does
 * a missing file show the note; a present but invalid file always does.
 * @returns {{message: string, payload: object|null}}
 */
export function withGatePayload(message, read, expected) {
  let block = null;
  if (read.payload) block = renderGatePayload(read.payload);
  else if (read.present) block = `(no agent payload: ${read.why})`;
  else if (expected) block = "(no agent payload)";
  if (block === null) return { message, payload: null };
  const nl = message.indexOf("\n");
  const head = nl === -1 ? message : message.slice(0, nl);
  const rest = nl === -1 ? "" : message.slice(nl);
  return { message: `${head}\n\n${block}${rest}`, payload: read.payload };
}

/** Ids of the gate steps in a step list (if/else branches and loop bodies included), in order. */
export function gateStepIds(steps, acc = []) {
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== "object") continue;
    if (s.type === "gate" && typeof s.id === "string") acc.push(s.id);
    for (const key of ["then", "else", "steps", "do", "body"]) {
      if (Array.isArray(s[key])) gateStepIds(s[key], acc);
    }
  }
  return acc;
}
