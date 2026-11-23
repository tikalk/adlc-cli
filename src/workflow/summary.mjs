// End-of-run summary (adlc-workspace#66).
//
// One message that says how a run ended, built only from the run's own files
// (.adlc/workflows/runs/<run_id>/state.json, inputs.json, log.jsonl and the
// trace events). The engine makes no network call here (ADR-416): a runtime
// that relays runs to a chat thread forwards `text` as it is.
//
// Every string that came from a step (errors, conclusions, links, who answered
// a gate) is redacted, put on one line and capped, and the whole text is kept
// under SUMMARY_MAX_CHARS so it fits one chat message.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./redact.mjs";
import { tracePaths } from "./trace.mjs";

export const SUMMARY_MAX_CHARS = 3000;
export const SUMMARY_FIELD_CHARS = 300;
export const SUMMARY_MAX_LINKS = 10;
const LINK = /^https?:\/\/[^\s<>|]{1,2040}$/i;
const ANSWERER = /^[A-Za-z0-9._-][A-Za-z0-9._@-]{0,63}$/;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readLines(path) {
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** Redacted, one line, capped. Non-strings become "". */
export function cleanField(value, max = SUMMARY_FIELD_CHARS, env = process.env) {
  if (typeof value !== "string") return "";
  const one = redactSecrets(value, env).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function stepLinks(output) {
  const links = [];
  if (!output || typeof output !== "object") return links;
  if (typeof output.mr_url === "string") links.push(output.mr_url.trim());
  if (typeof output.mr_urls === "string") links.push(...output.mr_urls.split(/[\s,]+/));
  return links.filter((l) => LINK.test(l));
}

/**
 * Build the summary of one run from its directory. Returns null when the run
 * has no readable state.json.
 */
export function buildRunSummary(runDir, { env = process.env } = {}) {
  const state = readJson(join(runDir, "state.json"));
  if (!state || typeof state !== "object") return null;
  const inputs = (readJson(join(runDir, "inputs.json")) ?? {}).inputs ?? {};
  const log = readLines(join(runDir, "log.jsonl"));
  const trace = readLines(tracePaths(runDir).events);
  const results = state.step_results && typeof state.step_results === "object" ? state.step_results : {};

  // Step order: as the run started them (log.jsonl), then any result the log
  // does not name, in state order.
  const types = {};
  const order = [];
  for (const e of log) {
    if (e?.event === "step_started" && typeof e.step_id === "string") {
      if (!order.includes(e.step_id)) order.push(e.step_id);
      // The first logged type stands; a later line cannot retype a step.
      if (typeof e.type === "string" && !(e.step_id in types)) types[e.step_id] = e.type;
    }
  }
  for (const id of Object.keys(results)) if (!order.includes(id)) order.push(id);

  const steps = [];
  const gates = [];
  const links = [];
  let conclusion = "";
  let conclusionStep = null;
  let failed = null;
  for (const id of order) {
    const r = results[id];
    if (!r || typeof r !== "object") continue;
    const output = r.output && typeof r.output === "object" ? r.output : {};
    const step = { id: cleanField(id, 80, env), status: typeof r.status === "string" ? r.status : "unknown" };
    if (types[id]) step.type = types[id];
    steps.push(step);
    // Gates only by the type the engine logged when it started the step: any
    // other step can write `choice`/`answered_by` to its own output.
    if (types[id] === "gate" && typeof output.choice === "string") {
      const gate = { id: step.id, choice: cleanField(output.choice, 40, env) };
      if (typeof output.answered_by === "string" && ANSWERER.test(output.answered_by)) gate.answered_by = output.answered_by;
      if (output.auto_passed === true) gate.auto = true;
      gates.push(gate);
    }
    for (const l of stepLinks(output)) {
      const c = cleanField(l, 2048, env);
      if (LINK.test(c) && !links.includes(c)) links.push(c);
    }
    if (typeof output.conclusion === "string" && output.conclusion.trim()) {
      // The execute step's conclusion wins; otherwise the last one.
      if (conclusionStep !== "execute") {
        conclusion = cleanField(output.conclusion, SUMMARY_FIELD_CHARS, env);
        conclusionStep = id;
      }
    }
    // The step that failed: the first failed one with its own error (an `if`
    // or loop around a rejected gate fails too, with no error of its own).
    if (r.status === "failed" && (failed === null || (!failed.own && typeof r.error === "string" && r.error))) {
      const own = typeof r.error === "string" && r.error !== "";
      failed = { id: step.id, error: cleanField(own ? r.error : (state.error ?? ""), SUMMARY_FIELD_CHARS, env), own };
    }
  }

  const started = Date.parse(state.created_at ?? "");
  const ended = Date.parse(state.updated_at ?? "");
  const durationSeconds = Number.isFinite(started) && Number.isFinite(ended) && ended >= started
    ? Math.round((ended - started) / 1000) : null;
  const resumes = trace.filter((e) => e?.payload?.adlc?.event === "run_resumed").length;

  const summary = {
    run_id: cleanField(String(state.run_id ?? ""), 80, env),
    workflow_id: cleanField(String(state.workflow_id ?? ""), 80, env),
    status: typeof state.status === "string" ? state.status : "unknown",
    started_at: state.created_at ?? null,
    ended_at: state.updated_at ?? null,
    duration_seconds: durationSeconds,
    issue_ref: cleanField(inputs.issue_ref, 200, env) || null,
    dispatch: cleanField(inputs.dispatch, 40, env) || null,
    steps,
    gates,
    conclusion: conclusion || null,
    mr_urls: links.slice(0, SUMMARY_MAX_LINKS),
    failed_step: failed ? { id: failed.id, error: failed.error } : null,
    resumes,
  };
  summary.text = renderSummaryText(summary);
  return summary;
}

const MARK = { completed: "✓", failed: "✗", skipped: "–", paused: "⏸", running: "…" };

// Chat-safe text: `&`, `<`, `>` escaped (no links, mentions or broadcasts
// made of step text) and @here/@channel/@everyone broken with a zero-width
// space. Only the rendered text; the JSON fields keep the cleaned values.
export function chatSafe(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1");
}

export function renderSummaryText(raw) {
  const e = chatSafe;
  const s = {
    ...raw,
    run_id: e(raw.run_id), workflow_id: e(raw.workflow_id), issue_ref: raw.issue_ref ? e(raw.issue_ref) : raw.issue_ref,
    dispatch: raw.dispatch ? e(raw.dispatch) : raw.dispatch, conclusion: raw.conclusion ? e(raw.conclusion) : raw.conclusion,
    failed_step: raw.failed_step ? { id: e(raw.failed_step.id), error: e(raw.failed_step.error) } : null,
    mr_urls: raw.mr_urls.map(e),
    gates: raw.gates.map((g) => ({ ...g, id: e(g.id), choice: e(g.choice), ...(g.answered_by ? { answered_by: e(g.answered_by) } : {}) })),
    steps: raw.steps.map((st) => ({ ...st, id: e(st.id) })),
  };
  const lines = [];
  const head = [`*Run ${s.run_id} ${s.status}*`];
  if (s.workflow_id) head.push(s.workflow_id);
  if (s.duration_seconds !== null) head.push(formatDuration(s.duration_seconds));
  lines.push(head.join(" · "));
  const who = [];
  if (s.issue_ref) who.push(`Issue ${s.issue_ref}`);
  if (s.dispatch) who.push(`dispatch ${s.dispatch}`);
  if (who.length) lines.push(who.join(" · "));
  if (s.failed_step) lines.push(`Failed at \`${s.failed_step.id}\`${s.failed_step.error ? `: ${s.failed_step.error}` : ""}`);
  if (s.mr_urls.length) {
    lines.push("MR/PR:");
    for (const l of s.mr_urls) lines.push(`• ${l}`);
  } else {
    lines.push("MR/PR: none");
  }
  if (s.conclusion) lines.push(`Conclusion: ${s.conclusion}`);
  if (s.gates.length) {
    lines.push("Gates:");
    for (const g of s.gates) {
      const by = g.auto ? " (auto)" : g.answered_by ? ` (by ${g.answered_by})` : "";
      lines.push(`• ${g.id}: ${g.choice}${by}`);
    }
  }
  if (s.steps.length) {
    lines.push("Steps:");
    for (const st of s.steps) lines.push(`• ${MARK[st.status] ?? "?"} ${st.id}: ${st.status}`);
  }
  if (s.resumes > 0) lines.push(`Resumed ${s.resumes} time${s.resumes === 1 ? "" : "s"}`);
  let text = lines.join("\n");
  if (text.length > SUMMARY_MAX_CHARS) text = text.slice(0, SUMMARY_MAX_CHARS - 1) + "…";
  return text;
}
