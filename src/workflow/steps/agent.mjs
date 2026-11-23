// Agent-dispatch steps: prompt (arbitrary inline prompt) and command
// (invoke a factory skill/command). Adapted from upstream spec-kit
// step/prompt + step/command @ adbd62a: dispatch targets agent CLIs via
// adlc-cli's run.mjs profiles (registry.mjs) instead of the specify
// integration CLI — the ADR-390 adaptation.

import { gatePayloadsDir } from "../gate-payload.mjs";
import { StepBase, StepResult, StepStatus, typeName } from "../base.mjs";
import { evaluateExpression } from "../expressions.mjs";
import { runTask } from "../../run.mjs";
import { getRunProfile } from "../../registry.mjs";
import { readAgent } from "../../utils/init-options.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { currentHeadSha } from "../gate-context.mjs";
import { redactSecrets } from "../redact.mjs";

const rid = (config) => `'${config.id ?? "?"}'`;

// ADR-542: an agent that exits non-zero within this many seconds of spawn is
// an infrastructure failure (retryable), not a logical one. The env override
// is a test seam (kept out of README on purpose); production stays at 60.
// Read lazily so tests can set the override after module load.
export function fastFailureThresholdSeconds() {
  const raw = Number(process.env.ADLC_FAST_FAILURE_THRESHOLD_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

// Resolve the agent key: step > workflow default (context) > project default
// (.adlc/init-options.json). Returns null when nothing resolves — the step
// then fails with a clear message.
//
// The third tier was documented here but never implemented: any workflow
// relying on the project default alone (e.g. the bundled `factory` built-in,
// which sets neither a step nor a workflow integration) failed every agent
// step with "no agent/integration configured", even though .adlc/init-
// options.json had `agent` set to exactly what the error suggested setting.
function resolveAgent(config, context) {
  return (
    config.integration ??
    context.defaultIntegration ??
    (process.env.ADLC_AGENT ? process.env.ADLC_AGENT.trim() : null) ??
    readAgent(context.projectRoot) ??
    null
  );
}

// Resolve agent setting (model or mode): step value > workflow default > CLI flag/env > null.
// Either level can specify a single string (applies to all agents) OR a mapping
// keyed by agent/integration name (e.g. { opencode: "plan", "claude-code": "plan" }).
export function resolveAgentSetting(stepValue, workflowDefault, agentKey, envOverride) {
  const pick = (val) => {
    if (val === null || val === undefined) return null;
    if (typeof val === "string") return val;
    if (typeof val === "object" && !Array.isArray(val)) {
      if (agentKey && agentKey in val) return val[agentKey];
      if ("default" in val) return val.default;
    }
    return null;
  };
  return envOverride?.trim() || pick(stepValue) || pick(workflowDefault) || null;
}

async function runAgentStep({ agentKey, model, mode, prompt, context, config, timeoutSec }) {
  if (!agentKey) {
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Step ${rid(config)}: no agent/integration configured. Set step 'integration:', workflow 'workflow.integration:', or .adlc/init-options.json agent.`,
      output: { integration: null, model: model ?? null, mode: mode ?? null, input: prompt, stdout: "", stderr: "", exit_code: -1 },
    });
  }
  let profile;
  try {
    profile = getRunProfile(agentKey);
  } catch {
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Step ${rid(config)}: unknown agent/integration ${JSON.stringify(agentKey)}. Run 'adlc-cli agent list' for supported keys.`,
      output: { integration: agentKey, model: model ?? null, mode: mode ?? null, input: prompt, stdout: "", stderr: "", exit_code: -1 },
    });
  }

  // Run context (ADR-444): who the step is and where it may leave a small
  // structured result. A file from an earlier attempt is removed first so a
  // retried step can never surface a stale value.
  const runEnv = runContextEnv(context, config);
  prepareStepOutput(runEnv.ADLC_STEP_OUTPUT);
  // Question pause (adlc-workspace#148): clear a question file left by an
  // earlier pause (it was persisted into that pause's step output), so only a
  // question written during THIS attempt can pause the run; record the resume
  // answer once.
  prepareQuestionRun(runEnv, context, config);

  // runTask streams lines; collect them as the step's stdout.
  let stdout = "";
  let exit = { code: null, signal: null };
  let timedOut = false;
  let timer = null;

  let taskHandle;
  try {
    taskHandle = runTask({
      profile,
      prompt,
      model,
      mode,
      cwd: context.projectRoot || process.cwd(),
      env: runEnv,
      onLine: (line) => {
        stdout += line + "\n";
      },
    });
  } catch (err) {
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Agent step ${rid(config)} failed to start: ${err.message}`,
      output: { integration: agentKey, model: model ?? null, mode: mode ?? null, input: prompt, stdout: "", stderr: err.message, exit_code: -1 },
    });
  }
  const { promise, kill } = taskHandle;
  // ADR-542: the fast-failure clock starts at spawn, so a cold-pod crash or
  // gateway blip at start-up is told apart from a wrong answer later on.
  const spawnedAt = process.hrtime.bigint();

  if (timeoutSec && Number.isFinite(timeoutSec) && timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      kill("SIGKILL");
    }, timeoutSec * 1000);
    if (timer.unref) timer.unref();
  }

  const onInt = () => {
    timedOut = false;
    kill("SIGKILL");
  };
  process.on("SIGINT", onInt);

  try {
    exit = await promise;
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onInt);
  }

  const output = {
    integration: agentKey,
    model: model ?? null,
    mode: mode ?? null,
    input: prompt,
    stdout,
    stderr: "",
    exit_code: exit.code,
  };

  if (process.listenerCount("SIGINT") > 0 && exit.signal === "SIGINT") {
    output.interrupted = true;
    return new StepResult({
      status: StepStatus.FAILED,
      error: `Agent step ${rid(config)} interrupted (SIGINT).`,
      output,
    });
  }
  // The step's own time limit killed the agent. It is still a failed step
  // (the run fails and exits 10, as before), but it is reported apart from an
  // agent that failed by itself: the error starts with "timeout:", names the
  // step and the limit, and the output carries timed_out / timeout_seconds.
  if (timedOut && exit.code !== 0) {
    output.timed_out = true;
    output.timeout_seconds = timeoutSec;
    // Elapsed is still recorded (F6 pins it): a timeout is a hung agent, not
    // a cold-pod crash, so the run stays a logical failure (exit 10) with
    // elapsed but no fast_failure mark.
    const agentElapsedSeconds = Number(process.hrtime.bigint() - spawnedAt) / 1e9;
    output.agent_elapsed_seconds = Math.round(agentElapsedSeconds * 10) / 10;
    return new StepResult({
      status: StepStatus.FAILED,
      error:
        `timeout: step ${config.id ?? "?"} exceeded ${timeoutSec}s: the agent was killed by the step's time limit, ` +
        `it did not fail by itself (set 'timeout:' on the step to change the limit).`,
      output,
    });
  }
  if (exit.code !== 0) {
    // ADR-542: non-zero exit within the threshold of spawn is classified as
    // an infrastructure failure; the engine persists it on the run state so
    // the command boundary exits with the retryable code. A kill by the
    // step's own timeout is the opposite signal (a hung agent, not a cold
    // pod) — it stays a logical failure, so the dead `timedOut` flag gates
    // the mark here.
    const agentElapsedSeconds = Number(process.hrtime.bigint() - spawnedAt) / 1e9;
    const fastFailure = !timedOut && agentElapsedSeconds < fastFailureThresholdSeconds();
    output.agent_elapsed_seconds = Math.round(agentElapsedSeconds * 10) / 10;
    if (fastFailure) output.fast_failure = true;
    return new StepResult({
      status: StepStatus.FAILED,
      error:
        `Agent step ${rid(config)} exited with code ${exit.code ?? "signal " + exit.signal}.` +
        (fastFailure
          ? ` The agent failed ${Math.round(agentElapsedSeconds)}s after start — classified as an infrastructure failure (retryable; ADR-542), not a wrong answer.`
          : ""),
      output,
    });
  }
  Object.assign(output, readStepOutput(runEnv.ADLC_STEP_OUTPUT, rid(config)));
  // A refusal ends the run (adlc-workspace#167): a step whose conclusion
  // starts with `blocked:` (a dependency gate, no issue, a refused publish)
  // FAILS even though the agent exited 0, so no later gate pauses with
  // nothing to approve and no later step runs. A logical failure — never
  // fast_failure — so `workflow run` exits 10 and the lane does not retry.
  // Checked before the question payload: a refused step never asks. Read from
  // the raw file, not the validated merge: one invalid sibling field drops
  // the whole object, and the refusal must still end the run (fail closed).
  const blocked = readBlockedConclusion(runEnv.ADLC_STEP_OUTPUT);
  if (blocked !== null) {
    return new StepResult({
      status: StepStatus.FAILED,
      // Agent-written text: redact secrets with the env the agent ran with,
      // and keep it on one line (it reaches run_failed and the runtime log).
      // Redact the whole text first, then collapse and cap it.
      error: `Agent step ${rid(config)}: ${redactSecrets(blocked, { ...process.env, ...runEnv }).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, MAX_OUTPUT_VALUE)}`,
      output,
    });
  }
  // Question payload (adlc-workspace#148): after exit 0, a valid
  // runs/<run_id>/questions/<step_id>.json pauses the run with kind=question
  // instead of completing. Invalid payloads keep COMPLETED with a warning.
  const question = readQuestionPayload(runEnv, context, config);
  if (question.valid) {
    const pauseCount = priorPauseCount(context, config) + 1;
    if (pauseCount > MAX_QUESTION_PAUSES) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Agent step ${rid(config)}: blocked: question budget exhausted (max ${MAX_QUESTION_PAUSES} pauses per step per run).`,
        output: { ...output, pause_count: pauseCount },
      });
    }
    return new StepResult({
      status: StepStatus.PAUSED,
      output: {
        ...output,
        kind: "question",
        answer_input: `answer_${config.id}`,
        payload: question.payload,
        head_sha: currentHeadSha(context.projectRoot) ?? "unknown",
        pause_count: pauseCount,
      },
    });
  }
  if (question.present) {
    console.error(`[workflow] step ${rid(config)}: question payload ignored (${question.why})`);
    output.question_warning = `question payload ignored: ${question.why}`;
  }
  return new StepResult({ status: StepStatus.COMPLETED, output });
}

// ── blocked conclusion (adlc-workspace#167) ───────────────────────────────
// The step's `conclusion` when it starts with `blocked:` (any case, after
// whitespace and invisible format characters such as U+200B), else null.
// Independent of the all-or-nothing output validation: a file the merge
// rejects (a non-string sibling, too many fields, an over-long value, a
// reserved key) or that does not parse as JSON still carries the refusal.
// The caller redacts the whole text before it caps it.
const BLOCKED_PREFIX = /^[\s\p{Cf}]*blocked:/iu;
// Every "conclusion": "<string>" in a file that does not parse, whole (the
// file is already bounded by MAX_OUTPUT_FILE).
const CONCLUSION_IN_RAW = /"conclusion"\s*:\s*"((?:[^"\\]|\\.)*)/g;

// Decode a JSON string body tolerantly: valid escapes are decoded one by one
// (so `\u0067lpat-…` is redacted as `glpat-…`), invalid ones are left as they
// are, and raw control characters are kept for the caller to collapse.
function decodeJsonStringBody(body) {
  const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return body.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, e) =>
    e[0] === "u" ? String.fromCharCode(parseInt(e.slice(1), 16)) : simple[e]);
}

function readBlockedConclusion(path) {
  if (!path || !existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // Unreadable: the merge reads nothing from it either; the step keeps
    // today's outcome (only a readable `blocked:` changes it).
    return null;
  }
  if (raw.length > MAX_OUTPUT_FILE) raw = raw.slice(0, MAX_OUTPUT_FILE);
  const candidates = [];
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.conclusion === "string") {
      candidates.push(data.conclusion);
    }
  } catch {
    // Not JSON: every "conclusion" string in the text counts, decoded.
    for (const m of raw.matchAll(CONCLUSION_IN_RAW)) candidates.push(decodeJsonStringBody(m[1]));
  }
  const hit = candidates.find((c) => BLOCKED_PREFIX.test(c));
  return hit === undefined ? null : hit.replace(/^[\s\p{Cf}]+/u, "");
}

// ── question payload (adlc-workspace#148) ─────────────────────────────────
// Caps: max 3 questions per payload, max 3 pauses per step per run.
export const MAX_QUESTION_PAUSES = 3;
export const MAX_QUESTIONS_PER_PAYLOAD = 3;
// Scheme is case-insensitive (RFC 3986 §3.1): HTTPS:// is as valid as https://.
const MR_URL = /^https?:\/\/[^\s<>|]{1,2040}$/i;

function questionPath(runEnv) {
  return runEnv.ADLC_STEP_QUESTION ?? null;
}

function readQuestionPayload(runEnv, context, config) {
  const path = questionPath(runEnv);
  if (!path || !existsSync(path)) return { present: false, valid: false };
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { present: true, valid: false, why: `unreadable: ${err.message}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { present: true, valid: false, why: "not JSON" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { present: true, valid: false, why: "not a JSON object" };
  }
  if (typeof data.summary !== "string" || data.summary.trim() === "") {
    return { present: true, valid: false, why: "missing summary" };
  }
  const questions = data.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { present: true, valid: false, why: "missing questions array" };
  }
  if (questions.length > MAX_QUESTIONS_PER_PAYLOAD) {
    return { present: true, valid: false, why: `more than ${MAX_QUESTIONS_PER_PAYLOAD} questions` };
  }
  for (const q of questions) {
    if (q === null || typeof q !== "object" || Array.isArray(q) ||
        typeof q.id !== "string" || q.id === "" ||
        typeof q.text !== "string" || q.text === "") {
      return { present: true, valid: false, why: "question needs string id and text" };
    }
  }
  const payload = { summary: data.summary, questions };
  if (typeof data.resume_hint === "string" && data.resume_hint !== "") payload.resume_hint = data.resume_hint;
  // The run's draft MR (ADR-531 D6): the runtime links it in the Slack post.
  // Only a plain http(s) URL is kept; anything else is dropped, never fatal.
  if (typeof data.mr_url === "string" && MR_URL.test(data.mr_url)) payload.mr_url = data.mr_url;
  return { present: true, valid: true, payload };
}

function priorPauseCount(context, config) {
  const prev = context.steps?.[config.id]?.output;
  const n = prev?.pause_count;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
}

// ── run context + structured step output (ADR-444) ─────────────────────────

// `choice`, `answered_by` and `auto_passed` are a gate's own fields: no step
// output may supply them (adlc-workspace#66, the end-of-run summary).
const RESERVED_OUTPUT_KEYS = new Set(["integration", "model", "input", "stdout", "stderr", "exit_code", "interrupted", "choice", "answered_by", "auto_passed"]);
const OUTPUT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_OUTPUT_ENTRIES = 16;
const MAX_OUTPUT_VALUE = 2048;
// Generous bound on the raw file; any valid object is far smaller.
const MAX_OUTPUT_FILE = 64 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Remove a file left by an earlier attempt (a retry must never surface a stale
// value) and create its directory, so a step can write it with a plain redirect.
export function prepareStepOutput(path) {
  if (!path) return;
  try { rmSync(path, { force: true }); } catch {}
  try { mkdirSync(dirname(path), { recursive: true }); } catch {}
}

// Before each agent attempt (adlc-workspace#148): remove any question file
// from an earlier pause — its payload already lives in that pause's step
// output — and make sure the directory exists, so the agent can write a new
// one with a plain redirect. On resume, record the answer exactly once per
// pause in runs/<run_id>/answers/<step_id>.json.
export function prepareQuestionRun(runEnv, context, config) {
  const qpath = runEnv.ADLC_STEP_QUESTION;
  if (qpath) {
    try { rmSync(qpath, { force: true }); } catch {}
    try { mkdirSync(dirname(qpath), { recursive: true }); } catch {}
  }
  const apath = runEnv.ADLC_STEP_ANSWERS;
  const text = context.inputs?.[`answer_${config.id}`];
  if (!apath || typeof text !== "string" || text === "") return;
  const prev = context.steps?.[config.id]?.output;
  const pause = Number.isInteger(prev?.pause_count) ? prev.pause_count : 0;
  let entries = [];
  try {
    if (existsSync(apath)) {
      const parsed = JSON.parse(readFileSync(apath, "utf-8"));
      if (Array.isArray(parsed)) entries = parsed;
    }
  } catch {}
  if (entries.some((e) => e && e.pause === pause)) return; // already recorded (retry)
  const qs = prev?.payload?.questions;
  entries.push({
    question_id: Array.isArray(qs) && qs.length === 1 && typeof qs[0]?.id === "string" ? qs[0].id : null,
    pause,
    text,
    answered_by: process.env.ADLC_ANSWERED_BY ?? "operator",
    ts: new Date().toISOString(),
  });
  try { mkdirSync(dirname(apath), { recursive: true }); } catch {}
  try { writeFileSync(apath, JSON.stringify(entries)); } catch {}
}

export function runContextEnv(context, config) {
  const env = {};
  const runId = typeof context.runId === "string" ? context.runId : null;
  const stepId = typeof config.id === "string" ? config.id : null;
  if (runId) env.ADLC_RUN_ID = runId;
  if (stepId) env.ADLC_STEP_ID = stepId;
  // Path-safe ids only: the file is deleted before the step and read after it.
  if (runId && stepId && SAFE_ID.test(runId) && SAFE_ID.test(stepId) && context.projectRoot) {
    env.ADLC_STEP_OUTPUT = join(context.projectRoot, ".adlc", "workflows", "runs", runId, "steps", `${stepId}.output.json`);
    // Question payload path (adlc-workspace#148): the agent leaves
    // runs/<run_id>/questions/<step_id>.json to pause the run with a question.
    env.ADLC_STEP_QUESTION = join(context.projectRoot, ".adlc", "workflows", "runs", runId, "questions", `${stepId}.json`);
    // Answers file on resume (append-only list of {question_id, text,
    // answered_by, ts}): set when the run resumes with answer_<step_id>.
    const answerKey = `answer_${stepId}`;
    const answer = context.inputs?.[answerKey];
    if (typeof answer === "string" && answer !== "") {
      env.ADLC_STEP_ANSWERS = join(context.projectRoot, ".adlc", "workflows", "runs", runId, "answers", `${stepId}.json`);
    }
  }
  // Gate payloads (ADR-515): where a step may write
  // gate-payloads/<gate_id>.json, and which gates are still ahead.
  const payloads = gatePayloadsDir(context.projectRoot, runId);
  if (payloads) env.ADLC_GATE_PAYLOADS = payloads;
  const upcoming = (context.gateIds ?? []).filter((id) => context.steps?.[id]?.status !== "completed");
  if (upcoming.length) env.ADLC_UPCOMING_GATES = upcoming.join(",");
  const issueRef = context.inputs?.issue_ref;
  if (typeof issueRef === "string" && issueRef !== "") env.ADLC_ISSUE_REF = issueRef;
  return env;
}

// The step's structured result: a flat object of short strings, merged only
// when every entry is valid — otherwise nothing (and a log line). The values
// are untrusted; renderers sanitise them (links: safeMrLink).
export function readStepOutput(path, stepRef) {
  if (!path || !existsSync(path)) return {};
  const reject = (why) => {
    console.error(`[workflow] step ${stepRef}: step output ignored (${why})`);
    return {};
  };
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return reject(`unreadable: ${err.message}`);
  }
  if (raw.length > MAX_OUTPUT_FILE) return reject("file too large");
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return reject("not JSON");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return reject("not a JSON object");
  const entries = Object.entries(data);
  if (entries.length > MAX_OUTPUT_ENTRIES) return reject(`more than ${MAX_OUTPUT_ENTRIES} fields`);
  for (const [key, value] of entries) {
    if (!OUTPUT_KEY.test(key)) return reject(`invalid key ${JSON.stringify(key)}`);
    if (RESERVED_OUTPUT_KEYS.has(key)) return reject(`reserved key ${JSON.stringify(key)}`);
    if (typeof value !== "string") return reject(`field ${key} is not a string`);
    if (value.length > MAX_OUTPUT_VALUE) return reject(`field ${key} exceeds ${MAX_OUTPUT_VALUE} characters`);
  }
  return Object.fromEntries(entries);
}

// ── prompt ───────────────────────────────────────────────────────────────

export class PromptStep extends StepBase {
  static typeKey = "prompt";

  async execute(config, context) {
    let prompt = config.prompt ?? "";
    if (typeof prompt === "string" && prompt.includes("{{")) {
      prompt = evaluateExpression(prompt, context);
    }
    prompt = String(prompt);

    const agentKey = resolveAgent(config, context);
    const model = resolveAgentSetting(config.model, context.defaultModel, agentKey, process.env.ADLC_MODEL);
    const mode = resolveAgentSetting(config.mode, context.defaultMode, agentKey, process.env.ADLC_MODE);
    const timeout = config.timeout ?? 3600;

    return runAgentStep({ agentKey, model, mode, prompt, context, config, timeoutSec: timeout });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("prompt" in config)) {
      errors.push(`Prompt step ${rid(config)} is missing 'prompt' field.`);
    } else if (typeof config.prompt !== "string") {
      errors.push(`Prompt step ${rid(config)}: 'prompt' must be a string, got ${typeName(config.prompt)}.`);
    }
    if ("model" in config && config.model !== null && typeof config.model !== "string" &&
        (typeof config.model !== "object" || Array.isArray(config.model))) {
      errors.push(`Prompt step ${rid(config)}: 'model' must be a string, mapping, or null, got ${typeName(config.model)}.`);
    }
    if ("mode" in config && config.mode !== null && typeof config.mode !== "string" &&
        (typeof config.mode !== "object" || Array.isArray(config.mode))) {
      errors.push(`Prompt step ${rid(config)}: 'mode' must be a string, mapping, or null, got ${typeName(config.mode)}.`);
    }
    if ("timeout" in config) {
      const t = config.timeout;
      if (typeof t === "boolean" || typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
        errors.push(`Prompt step ${rid(config)}: 'timeout' must be a positive number of seconds, got ${JSON.stringify(t)}.`);
      }
    }
    return errors;
  }
}

// ── command ──────────────────────────────────────────────────────────────

export class CommandStep extends StepBase {
  static typeKey = "command";

  async execute(config, context) {
    // In the factory port, `command:` names a factory skill/command — the
    // prompt is the command identifier plus resolved input args. The agent
    // resolves the command from its installed skills.
    const command = config.command ?? "";
    if (typeof command !== "string" || command === "") {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Command step ${rid(config)}: 'command' must be a non-empty string.`,
        output: { command: null, input: {}, stdout: "", stderr: "", exit_code: -1 },
      });
    }

    // Resolve input values (args + arbitrary keys) through expressions.
    const rawInput = config.input ?? {};
    const input = {};
    if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
      for (const [key, value] of Object.entries(rawInput)) {
        if (typeof value === "string" && value.includes("{{")) {
          input[key] = evaluateExpression(value, context);
        } else {
          input[key] = value;
        }
      }
    }

    const agentKey = resolveAgent(config, context);
    const model = resolveAgentSetting(config.model, context.defaultModel, agentKey, process.env.ADLC_MODEL);
    const mode = resolveAgentSetting(config.mode, context.defaultMode, agentKey, process.env.ADLC_MODE);
    const options = config.options ?? {};
    const timeout = config.timeout ?? 3600;

    // Compose the dispatch prompt: "/<command> <args>" style — agents with
    // installed factory skills resolve the slash form natively.
    const args = input.args !== undefined ? String(input.args) : "";
    const extraOptions = Object.entries(options)
      .map(([k, v]) => (v === true ? `--${k}` : `--${k} ${String(v)}`))
      .join(" ");
    const prompt = [`/${command}`, extraOptions, args].filter((s) => s !== "").join(" ");

    return runAgentStep({ agentKey, model, mode, prompt, context, config, timeoutSec: timeout });
  }

  validate(config) {
    const errors = super.validate(config);
    if (!("command" in config)) {
      errors.push(`Command step ${rid(config)} is missing 'command' field.`);
    } else if (typeof config.command !== "string") {
      errors.push(`Command step ${rid(config)}: 'command' must be a string, got ${typeName(config.command)}.`);
    }
    const input = config.input;
    if (input !== null && input !== undefined &&
        (typeof input !== "object" || Array.isArray(input))) {
      errors.push(`Command step ${rid(config)}: 'input' must be a mapping, got ${typeName(input)}.`);
    }
    if ("model" in config && config.model !== null && typeof config.model !== "string" &&
        (typeof config.model !== "object" || Array.isArray(config.model))) {
      errors.push(`Command step ${rid(config)}: 'model' must be a string, mapping, or null, got ${typeName(config.model)}.`);
    }
    if ("mode" in config && config.mode !== null && typeof config.mode !== "string" &&
        (typeof config.mode !== "object" || Array.isArray(config.mode))) {
      errors.push(`Command step ${rid(config)}: 'mode' must be a string, mapping, or null, got ${typeName(config.mode)}.`);
    }
    if ("timeout" in config) {
      const t = config.timeout;
      if (typeof t === "boolean" || typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
        errors.push(`Command step ${rid(config)}: 'timeout' must be a positive number of seconds, got ${JSON.stringify(t)}.`);
      }
    }
    return errors;
  }
}
