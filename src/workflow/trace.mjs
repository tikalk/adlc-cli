// Trace bundle v1 (ADR-490) — run identity, lifecycle events and artifact
// metadata written into the run dir, and therefore into the pushed run ref.
//
// Layout:
//   trace/manifest.json   always retained
//   trace/events.jsonl    ADR-362 envelope, ADR-364 canonical types
//   trace/artifacts.json  content-addressed artifact index
//
// Capture-time redaction (ADR-478 amended by ADR-488/490): every string that
// enters the trace passes through the shared text redactor first. Writes are
// fail-soft at the call sites — telemetry never fails a run.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { RunStatus } from "./base.mjs";
import { redactSecrets } from "./redact.mjs";
import { readAgent } from "../utils/init-options.mjs";
import { currentHeadSha } from "./gate-context.mjs";

export const TRACE_SCHEMA_VERSION = 1;

const TRACE_DIR = "trace";
const DEFAULT_AGENT_ID = "adlc-cli";

// ADR-364 canonical event types, keyed by the run-log event name.
const CANONICAL_EVENT_TYPES = Object.freeze({
  workflow_failed: "error",
  resume_failed: "error",
  run_failed: "error",
  workflow_finished: "complete",
  run_completed: "complete",
  gate_paused: "permission_request",
  permission_request: "permission_request",
});

export function tracePaths(runDir) {
  const dir = join(runDir, TRACE_DIR);
  return {
    dir,
    manifest: join(dir, "manifest.json"),
    events: join(dir, "events.jsonl"),
    artifacts: join(dir, "artifacts.json"),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

// Walk a structured value and redact every string, so the emitted JSON stays
// valid (redacting a serialized document could corrupt it).
function redactDeep(value, env = process.env) {
  if (typeof value === "string") return redactSecrets(value, env);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, env));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, env);
    return out;
  }
  return value;
}

function readFileHash(projectRoot, candidates) {
  for (const rel of candidates) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      return sha256Hex(readFileSync(abs));
    } catch {
      return null;
    }
  }
  return null;
}

function gitValue(projectRoot, args) {
  const out = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
  if (out.error || out.status !== 0) return null;
  const text = String(out.stdout ?? "").trim();
  return text || null;
}

function issueRefFor(state, issueRef) {
  if (issueRef !== undefined && issueRef !== null && String(issueRef) !== "") return String(issueRef);
  const input = state?.inputs?.issue_ref;
  if (input !== undefined && input !== null && String(input) !== "") return String(input);
  const env = (process.env.ADLC_ISSUE_REF ?? "").trim();
  return env || null;
}

function manifestFor({ state, projectRoot, definition, issueRef, workloadClass }) {
  const agent = readAgent(projectRoot) ?? process.env.ADLC_AGENT ?? null;
  return {
    schema_version: TRACE_SCHEMA_VERSION,
    run_id: state.runId,
    workflow_id: state.workflowId,
    issue_ref: issueRefFor(state, issueRef),
    repository: {
      remote: gitValue(projectRoot, ["config", "--get", "remote.origin.url"]),
      branch: gitValue(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
      run_start_sha: state.runStartSha ?? currentHeadSha(projectRoot),
      head_sha: currentHeadSha(projectRoot),
    },
    agent: {
      id: agent,
      session_id: process.env.ADLC_AGENT_SESSION_ID ?? null,
      parent_session_id: process.env.ADLC_PARENT_SESSION_ID ?? null,
    },
    model: {
      name: definition?.defaultModel ?? null,
      route: definition?.defaultIntegration ?? null,
    },
    container: {
      image_digest: process.env.ADLC_CONTAINER_IMAGE_DIGEST ?? null,
    },
    config: {
      skill_lock_hash: readFileHash(projectRoot, ["skills-lock.json"]),
      mcp_config_hash: readFileHash(projectRoot, [".mcp.json", ".opencode/mcp.json"]),
    },
    created_at: state.createdAt ?? nowIso(),
    updated_at: nowIso(),
    finished_at: null,
    outcome: state.status ?? RunStatus.RUNNING,
    gateway_cost: null,
    retention_class: "pending",
    workload_class: workloadClass ?? process.env.ADLC_WORKLOAD_CLASS ?? "unknown",
  };
}

// Create the bundle for a run (idempotent). An existing manifest is updated,
// never recreated, so a resumed run keeps its original identity.
export function initTrace(runDir, {
  state = null,
  projectRoot = state?.projectRoot ?? process.cwd(),
  definition = null,
  issueRef = undefined,
  workloadClass = null,
} = {}) {
  const paths = tracePaths(runDir);
  mkdirSync(paths.dir, { recursive: true });

  let manifest;
  if (existsSync(paths.manifest)) {
    try {
      manifest = JSON.parse(readFileSync(paths.manifest, "utf-8"));
      manifest.updated_at = nowIso();
      if (state?.status) manifest.outcome = state.status;
    } catch {
      manifest = manifestFor({ state, projectRoot, definition, issueRef, workloadClass });
    }
  } else {
    manifest = manifestFor({ state, projectRoot, definition, issueRef, workloadClass });
  }
  writeJson(paths.manifest, redactDeep(manifest));

  if (!existsSync(paths.events)) writeFileSync(paths.events, "", "utf-8");
  if (!existsSync(paths.artifacts)) {
    writeJson(paths.artifacts, { schema_version: TRACE_SCHEMA_VERSION, artifacts: [] });
  }
  return manifest;
}

function lastEventName(paths) {
  if (!existsSync(paths.events)) return null;
  try {
    const text = readFileSync(paths.events, "utf-8").trimEnd();
    if (!text) return null;
    const lastLine = text.slice(text.lastIndexOf("\n") + 1);
    return JSON.parse(lastLine)?.payload?.adlc?.event ?? null;
  } catch {
    return null;
  }
}

// Append one ADR-362 envelope. The original run-log entry rides under
// payload.adlc so ADR-362 consumers keep parsing the stream unchanged.
export function appendTraceEvent(runDir, entry = {}, { agentId = DEFAULT_AGENT_ID } = {}) {
  const paths = tracePaths(runDir);
  mkdirSync(paths.dir, { recursive: true });
  if (!existsSync(paths.events)) writeFileSync(paths.events, "", "utf-8");

  const eventName = String(entry.event ?? "log");
  const type = CANONICAL_EVENT_TYPES[eventName] ?? "log";
  const envelope = {
    schema_version: 1,
    agent_id: agentId,
    ts: entry.timestamp ?? nowIso(),
    type,
    payload: { adlc: redactDeep({ ...entry }) },
  };
  appendFileSync(paths.events, JSON.stringify(envelope) + "\n", "utf-8");
  return envelope;
}

function successSampleRate(raw = process.env.ADLC_TRACE_SUCCESS_SAMPLE_RATE) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return 0;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return rate >= 1 ? 1 : rate;
}

// Deterministic per-run sampling: the same run always gets the same verdict,
// so re-applying the policy never flips a retained trace into a pruned one.
function sampledIn(runId, rate) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const digest = createHash("sha256").update(String(runId)).digest();
  return digest.readUInt32BE(0) / 0x100000000 < rate;
}

// Close the trace at a session boundary. Terminal statuses apply retention:
// failures and aborts keep full events; successes keep only the manifest
// unless the deployment's sampling policy selects the run (fail closed).
export function finalizeTrace(runDir, state, { sampleRate } = {}) {
  const paths = tracePaths(runDir);
  if (!existsSync(paths.manifest)) return null;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(paths.manifest, "utf-8"));
  } catch {
    return null;
  }

  const status = state?.status ?? manifest.outcome;
  manifest.outcome = status;
  manifest.updated_at = nowIso();

  if (status === RunStatus.PAUSED) {
    if (lastEventName(paths) !== "run_paused") {
      appendTraceEvent(runDir, { event: "run_paused", step_id: state?.currentStepId ?? null });
    }
  } else if ([RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.ABORTED].includes(status)) {
    if (status === RunStatus.COMPLETED) {
      if (lastEventName(paths) !== "run_completed") {
        appendTraceEvent(runDir, { event: "run_completed", status });
      }
    } else if (lastEventName(paths) !== "run_failed") {
      appendTraceEvent(runDir, { event: "run_failed", status, error: state?.error ?? null });
    }

    manifest.finished_at = nowIso();
    if (status === RunStatus.COMPLETED) {
      const rate = sampleRate ?? successSampleRate();
      if (sampledIn(manifest.run_id, rate)) {
        manifest.retention_class = "full-sampled";
        manifest.trace_pruned = false;
      } else {
        manifest.retention_class = "manifest-only";
        manifest.trace_pruned = true;
        rmSync(paths.events, { force: true });
      }
    } else {
      manifest.retention_class = "full";
      manifest.trace_pruned = false;
    }
  }

  writeJson(paths.manifest, redactDeep(manifest));
  return manifest;
}

const ARTIFACT_FIELDS = ["media_type", "storage_uri", "retention_class", "sensitivity", "producing_event"];
const SHA256_RE = /^[0-9a-f]{64}$/;

// Append a content-addressed artifact entry. `path` (relative to the run dir)
// hashes a local file; otherwise an explicit content_sha256 is required.
// Invalid input throws — callers decide whether that is fatal.
export function recordArtifact(runDir, artifact = {}) {
  const paths = tracePaths(runDir);
  mkdirSync(paths.dir, { recursive: true });

  let doc;
  if (existsSync(paths.artifacts)) {
    try {
      doc = JSON.parse(readFileSync(paths.artifacts, "utf-8"));
    } catch {
      doc = { schema_version: TRACE_SCHEMA_VERSION, artifacts: [] };
    }
  } else {
    doc = { schema_version: TRACE_SCHEMA_VERSION, artifacts: [] };
  }
  if (!Array.isArray(doc.artifacts)) doc.artifacts = [];

  const entry = { ...artifact };
  if (entry.content_sha256 !== undefined) {
    if (!SHA256_RE.test(String(entry.content_sha256))) {
      throw new Error("artifact content_sha256 must be a 64-character lowercase hex sha256 digest");
    }
  } else if (entry.path) {
    const abs = isAbsolute(entry.path) ? entry.path : join(runDir, entry.path);
    const bytes = readFileSync(abs);
    entry.content_sha256 = sha256Hex(bytes);
    entry.size = bytes.length;
  } else {
    throw new Error("artifact requires content_sha256 or path");
  }

  if (!Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error("artifact size must be a non-negative integer");
  }
  for (const field of ARTIFACT_FIELDS) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`artifact ${field} is required`);
    }
  }

  entry.created_at = nowIso();
  doc.artifacts.push(redactDeep(entry));
  writeJson(paths.artifacts, doc);
  return entry;
}
