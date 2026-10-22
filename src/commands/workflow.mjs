// Workflow commands: run/resume/status/validate + the `state` helper family
// (the LLM-executor librarian API, ADR-395).
// Renamed from `factory` (ADR-390-amendment) — no deprecation alias.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WorkflowEngine,
  WorkflowDefinition,
  validateWorkflow,
  headlessGateErrors,
  RunStatus,
  LeaseHeldError,
} from "../workflow/engine.mjs";
import { STEP_REGISTRY } from "../workflow/registry.mjs";
import {
  stateStart,
  stateAdvance,
  statePause,
  stateFail,
  stateShow,
} from "../workflow/state.mjs";
import { parkRun, restoreRun } from "../workflow/refs.mjs";
import { printWorkflowHelp } from "../help.mjs";
import { classifyWorkflowStatus } from "../exit-codes.mjs";
import { StepStatus } from "../workflow/base.mjs";
import {
  out,
  err,
  error,
  success,
  failure,
  note,
  panel,
  table,
  keyValue,
  createStepTracker,
  style,
  tint,
  combine,
  sym,  statusStyle,
  ACCENT,
} from "../ui/index.mjs";

const RUNS_DIR = ".adlc/workflows/runs";

export async function cmdWorkflow(args, flags, rawArgv) {
  const sub = args[0] ?? "help";
  const rest = args.slice(1);
  switch (sub) {
    case "run":
      return cmdWorkflowRun(rest, rawArgv);
    case "resume":
      return cmdWorkflowResume(rest, rawArgv);
    case "status":
      return cmdWorkflowStatus(rest);
    case "validate":
      return cmdWorkflowValidate(rest, rawArgv);
    case "state":
      return cmdWorkflowState(rest, rawArgv);
    case "park":
      return cmdWorkflowPark(rest, rawArgv);
    case "restore":
      return cmdWorkflowRestore(rest, rawArgv);
    case "help":
      printWorkflowHelp();
      return 0;
    default:
      err(`${style("Unknown", "red")} ${style(`workflow command: "${sub}"`, "gray")}`);
      printWorkflowHelp();
      return 1;
  }
}

// ── shared arg helpers ───────────────────────────────────────────────────

// Parse repeatable --input k=v pairs from raw argv (after the subcommand).
function parseInputs(rawArgv, subcommand) {
  const inputs = {};
  const idx = rawArgv.indexOf(subcommand);
  const tail = idx === -1 ? rawArgv : rawArgv.slice(idx + 1);
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] === "--input" || tail[i] === "-i") {
      const pair = tail[++i];
      if (pair === undefined || !pair.includes("=")) {
        throw new Error(`--input expects key=value (got ${JSON.stringify(pair)})`);
      }
      const eq = pair.indexOf("=");
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return inputs;
}

// Extract a single --flag value (or null) from raw argv. Both forms are
// accepted: "--flag value" and "--flag=value". The "=" form used to be
// ignored, which silently fell back to the caller's default.
function extractFlagValue(rawArgv, name) {
  const flag = `--${name}`;
  const idx = rawArgv.indexOf(flag);
  if (idx !== -1) {
    const value = rawArgv[idx + 1];
    if (value === undefined || value.startsWith("-")) return null;
    return value;
  }
  const inline = rawArgv.find((arg) => arg.startsWith(`${flag}=`));
  if (inline === undefined) return null;
  const value = inline.slice(flag.length + 1);
  return value === "" ? null : value;
}

function hasFlag(rawArgv, name) {
  return rawArgv.includes(`--${name}`);
}

function installInterruptHandler(engine) {
  const onInt = () => {
    engine.interrupted = true;
    err("");
    err(`${tint("[workflow]", "gray")} ${tint("interrupt received — pausing after current step…", "yellow")}`);
  };
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onInt);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onInt);
  };
}

// --format json: JSONL lifecycle events to stdout (ADR-390-amendment).
function eventEmitterFor(rawArgv) {
  if (!hasFlag(rawArgv, "format")) return null;
  const fmt = extractFlagValue(rawArgv, "format");
  if (fmt !== "json") return null;
  return (event) => {
    process.stdout.write(JSON.stringify(event) + "\n");
  };
}

function makeEngine(projectRoot, rawArgv) {
  const engine = new WorkflowEngine(projectRoot);
  const emitter = eventEmitterFor(rawArgv);
  // The tracker backs the final step tree; in --format json mode nothing is
  // printed here — the JSONL stream is the only output (ADR-406).
  const tracker = createStepTracker("");
  engine.stepTracker = tracker;
  if (emitter !== null) {
    engine.onEvent = emitter;
  } else {
    engine.onStepStart = (stepId, label) => {
      tracker.add(stepId, stepId);
      tracker.start(stepId, label);
      out(`  ${style(sym.step, ACCENT)} ${tint(stepId, "bold")} ${tint(`(${label})`, "gray")}`);
    };
    engine.onStepComplete = (stepId, label, status, stepError) => {
      if (status === StepStatus.COMPLETED) tracker.complete(stepId, label);
      else if (status === StepStatus.FAILED) tracker.error(stepId, stepError ?? "");
      else if (status === StepStatus.SKIPPED) tracker.skip(stepId, label);
      else if (status === StepStatus.PAUSED) tracker.start(stepId, label);
      else tracker.start(stepId, label);
    };
  }
  return engine;
}

function printRunSummary(state, tracker = null) {
  const rows = [["Status:", state.status]];
  if (state.currentStepId) rows.push(["Current:", state.currentStepId]);
  if (state.error) rows.push(["Error:", state.error]);

  out("");
  out(panel({ title: `Run ${state.runId}`, lines: [keyValue(rows)] }));

  if (tracker && tracker.steps.length > 0) {
    out("");
    out(tracker.render());
  }
}

// ── run ──────────────────────────────────────────────────────────────────

async function cmdWorkflowRun(rest, rawArgv) {
  const source = rest.find((a) => !a.startsWith("-"));
  if (!source) {
    error("workflow source required (file path, installed ID, or built-in like 'factory')");
    err(tint("Usage: adlc-cli workflow run <source> --input key=value [--format json]", "gray"));
    return 1;
  }

  const projectRoot = process.cwd();
  const engine = makeEngine(projectRoot, rawArgv);

  let definition;
  try {
    definition = engine.loadWorkflow(source);
  } catch (exc) {
    error(exc.message);
    return 1;
  }

  const validationErrors = engine.validate(definition, STEP_REGISTRY);
  if (hasFlag(rawArgv, "headless")) {
    validationErrors.push(...headlessGateErrors(definition));
  }
  if (validationErrors.length > 0) {
    err(`${style("Error:", "red")} workflow validation failed:`);
    for (const message of validationErrors) {
      err(`  ${style(sym.failure, "red")} ${tint(message, "gray")}`);
    }
    return 1;
  }

  let inputs;
  try {
    inputs = parseInputs(rawArgv, "run");
  } catch (exc) {
    error(exc.message);
    return 1;
  }

  const removeHandlers = installInterruptHandler(engine);
  try {
    const state = await engine.execute(definition, inputs, null, STEP_REGISTRY);
    if (engine.onEvent === null) printRunSummary(state, engine.stepTracker);
    if (state.status === RunStatus.PAUSED) {
      out("");
      note(`Paused at gate. Resume with: adlc-cli workflow resume ${state.runId} --input <verdict>=<choice>`);
    }
    // Lane contract: PAUSED exits 3 so the Argo expression
    // `asInt(lastRetry.exitCode) != 10 && asInt(lastRetry.exitCode) != 3`
    // excludes it from retries.
    return classifyWorkflowStatus(state.status).exitCode;
  } catch (exc) {
    error(exc.message);
    return 1;
  } finally {
    removeHandlers();
  }
}

// ── resume ───────────────────────────────────────────────────────────────

async function cmdWorkflowResume(rest, rawArgv) {
  const runId = rest.find((a) => !a.startsWith("-"));
  if (!runId) {
    error("run ID required");
    err(tint("Usage: adlc-cli workflow resume <run_id> --input key=value [--format json]", "gray"));
    return 1;
  }

  const projectRoot = process.cwd();
  const engine = makeEngine(projectRoot, rawArgv);

  let inputs;
  try {
    inputs = parseInputs(rawArgv, "resume");
  } catch (exc) {
    error(exc.message);
    return 1;
  }

  const removeHandlers = installInterruptHandler(engine);
  try {
    const state = await engine.resume(runId, inputs, STEP_REGISTRY);
    if (engine.onEvent === null) printRunSummary(state);
    if (state.status === RunStatus.PAUSED) {
      out("");
      note(`Still paused. Resume with: adlc-cli workflow resume ${state.runId} --input <verdict>=<choice>`);
    }
    // Lane contract: PAUSED exits 3 so the Argo expression
    // `asInt(lastRetry.exitCode) != 10 && asInt(lastRetry.exitCode) != 3`
    // excludes it from retries.
    return classifyWorkflowStatus(state.status).exitCode;
  } catch (exc) {
    if (exc instanceof LeaseHeldError) {
      error(exc.message);
      return 1;
    }
    error(exc.message);
    return 1;
  } finally {
    removeHandlers();
  }
}

// ── park / restore (ADR-391-amendment-3) ─────────────────────────────────

// Save a gate-paused run, with the gate's thread handle, to the remote run
// ref so another pod can restore and resume it.
async function cmdWorkflowPark(rest, rawArgv) {
  const runId = firstPositional(rest, rawArgv);
  const handleFile = extractFlagValue(rawArgv, "handle-file");
  if (!runId || !handleFile) {
    console.error("Usage: adlc-cli workflow park <run_id> --handle-file <path> [--remote <name>]");
    return 1;
  }
  try {
    const ref = parkRun(process.cwd(), runId, { handleFile, remote: extractFlagValue(rawArgv, "remote") ?? "origin" });
    console.log(`parked ${runId} → ${ref}`);
    return 0;
  } catch (exc) {
    console.error(`Error: ${exc.message}`);
    return 1;
  }
}

// Materialize a parked run from the remote run ref into runs/<run_id>/.
async function cmdWorkflowRestore(rest, rawArgv) {
  const runId = firstPositional(rest, rawArgv);
  if (!runId) {
    console.error("Usage: adlc-cli workflow restore <run_id> [--remote <name>] [--issue-ref <ref>]");
    return 1;
  }
  try {
    const dir = restoreRun(process.cwd(), runId, {
      remote: extractFlagValue(rawArgv, "remote") ?? "origin",
      issueRef: extractFlagValue(rawArgv, "issue-ref"),
    });
    console.log(`restored ${runId} → ${dir}`);
    return 0;
  } catch (exc) {
    console.error(`Error: ${exc.message}`);
    return 1;
  }
}

// The first argument that is neither a flag nor a flag's value.
//
// parseArgs strips a flag's name from the positional list but keeps its
// value, so the run id cannot simply be the first positional: in
// `workflow restore --remote origin <run_id>` that would read the
// remote's name as the run id. Every value the valued flags carry is
// therefore excluded before the first positional is taken.
function firstPositional(rest, rawArgv) {
  const consumed = valuedFlagValues(rawArgv);
  for (const token of rest) {
    if (token.startsWith("-")) continue;
    if (consumed.has(token)) continue;
    return token;
  }
  return null;
}

// Flags whose value is a separate argument.
const VALUED_FLAGS = ["handle-file", "remote", "issue-ref"];

// Every value the valued flags carry, in either form ("--flag value" and
// "--flag=value").
function valuedFlagValues(rawArgv) {
  const values = new Set();
  for (const arg of rawArgv) {
    for (const name of VALUED_FLAGS) {
      const flag = `--${name}`;
      if (arg === flag) continue;
      if (arg.startsWith(`${flag}=`)) {
        const value = arg.slice(flag.length + 1);
        if (value !== "") values.add(value);
      }
    }
  }
  for (let i = 0; i < rawArgv.length; i++) {
    for (const name of VALUED_FLAGS) {
      if (rawArgv[i] !== `--${name}`) continue;
      const value = rawArgv[i + 1];
      if (value !== undefined && !value.startsWith("-")) values.add(value);
    }
  }
  return values;
}

// ── status ───────────────────────────────────────────────────────────────

async function cmdWorkflowStatus(rest) {
  const runId = rest.find((a) => !a.startsWith("-"));
  const projectRoot = process.cwd();
  const engine = new WorkflowEngine(projectRoot);

  if (runId) {
    let state;
    try {
      state = loadStateRaw(runId, projectRoot);
    } catch (exc) {
      error(exc.message);
      return 1;
    }
    const rows = [["Status:", state.status]];
    if (state.current_step_id) rows.push(["Current:", state.current_step_id]);

    out("");
    out(panel({ title: `Run ${state.run_id}`, lines: [keyValue(rows)] }));

    const stepResults = state.step_results ?? {};
    const ids = Object.keys(stepResults);
    if (ids.length > 0) {
      const tracker = createStepTracker(`Steps (${ids.length})`);
      for (const id of ids) {
        tracker.add(id, id);
        const status = stepResults[id].status;
        if (status === StepStatus.COMPLETED) tracker.complete(id);
        else if (status === StepStatus.FAILED) tracker.error(id, stepResults[id].error ?? "");
        else if (status === StepStatus.SKIPPED) tracker.skip(id);
        else if (status === StepStatus.RUNNING) tracker.start(id);
        else tracker.add(id, id);
      }
      out("");
      out(tracker.render());
    }
    return 0;
  }

  const runs = engine.listRuns();
  if (runs.length === 0) {
    out("");
    note(`No workflow runs found (${join(projectRoot, RUNS_DIR)})`);
    return 0;
  }
  out("");
  out(
    table({
      title: `Workflow runs (${runs.length})`,
      columns: [
        { header: "Run ID", style: ACCENT },
        { header: "Status" },
        { header: "Current", optional: true },
        { header: "Updated", optional: true },
      ],
      rows: runs.map((run) => [
        run.run_id,
        statusCell(run.status),
        run.current_step_id ?? "",
        run.updated_at ?? "",
      ]),
    }),
  );
  out("");
  return 0;
}

// A status rendered as a colored glyph plus the raw status name.
function statusCell(status) {
  const { glyph, color } = statusStyle(status);
  return combine(style(glyph, color ?? "gray"), " ", status);
}

function loadStateRaw(runId, projectRoot) {
  const path = join(projectRoot, RUNS_DIR, runId, "state.json");
  if (!existsSync(path)) {
    throw new Error(`Run state not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ── validate ─────────────────────────────────────────────────────────────

async function cmdWorkflowValidate(rest, rawArgv) {
  const source = rest.find((a) => !a.startsWith("-"));
  if (!source) {
    error("source required");
    err(tint("Usage: adlc-cli workflow validate <workflow.yml|id> [--headless]", "gray"));
    return 1;
  }

  const projectRoot = process.cwd();
  const engine = new WorkflowEngine(projectRoot);
  let definition;
  try {
    definition = engine.loadWorkflow(source);
  } catch (exc) {
    error(exc.message);
    return 1;
  }

  const errors = engine.validate(definition, STEP_REGISTRY);
  if (hasFlag(rawArgv, "headless")) {
    // --headless: every gate must declare verdict_input (ADR-391-amendment).
    errors.push(...headlessGateErrors(definition));
  }
  if (errors.length === 0) {
    out("");
    success(`${definition.id} (${definition.name} v${definition.version}) — valid`);
    out(`  ${tint(`${definition.steps.length} step(s), ${Object.keys(definition.inputs).length} input(s)`, "gray")}`);
    return 0;
  }
  err(`${style("Error:", "red")} validation failed for ${source}:`);
  for (const message of errors) {
    err(`  ${style(sym.failure, "red")} ${tint(message, "gray")}`);
  }
  return 1;
}

// ── state (LLM-executor librarian API) ───────────────────────────────────

async function cmdWorkflowState(rest, rawArgv) {
  const sub = rest[0] ?? "help";
  const projectRoot = process.cwd();

  try {
    switch (sub) {
      case "start": {
        const workflowSource = extractFlagValue(rawArgv, "workflow");
        if (!workflowSource) {
          error("--workflow <id|path> required");
          err(tint("Usage: adlc-cli workflow state start --workflow <source> [--run-id <id>] [--input k=v]", "gray"));
          return 1;
        }
        const runId = extractFlagValue(rawArgv, "run-id");
        const inputs = parseInputs(rawArgv, "start");
        const state = await stateStart({ projectRoot, workflowSource, runId, inputs });
        process.stdout.write(`${state.runId}\n`);
        return 0;
      }
      case "advance": {
        const runId = rest[1];
        const stepId = extractFlagValue(rawArgv, "step");
        const status = extractFlagValue(rawArgv, "status") ?? "completed";
        if (!runId || !stepId) {
          error("run id and --step <id> required");
          err(tint("Usage: adlc-cli workflow state advance <run_id> --step <id> --status completed|failed [--output-file <path>] [--error <msg>]", "gray"));
          return 1;
        }
        if (!["completed", "failed"].includes(status)) {
          error(`--status must be completed|failed, got '${status}'`);
          return 1;
        }
        let output = null;
        const outputFile = extractFlagValue(rawArgv, "output-file");
        if (outputFile) {
          output = { data: readFileSync(outputFile, "utf-8") };
        } else {
          const outputJson = extractFlagValue(rawArgv, "output-json");
          if (outputJson) output = JSON.parse(outputJson);
        }
        const error = extractFlagValue(rawArgv, "error");
        const state = await stateAdvance({ projectRoot, runId, stepId, status, output, error });
        process.stdout.write(
          `${state.status}${state.currentStepId ? ` · next: ${state.currentStepId}` : ""}\n`,
        );
        return 0;
      }
      case "pause": {
        const runId = rest[1];
        const stepId = extractFlagValue(rawArgv, "step");
        if (!runId || !stepId) {
          error("run id and --step <id> required");
          err(tint("Usage: adlc-cli workflow state pause <run_id> --step <id>", "gray"));
          return 1;
        }
        const state = await statePause({ projectRoot, runId, stepId });
        process.stdout.write(`paused at ${state.currentStepId}\n`);
        return 0;
      }
      case "fail": {
        const runId = rest[1];
        if (!runId) {
          error("run ID required");
          err(tint("Usage: adlc-cli workflow state fail <run_id> --error <msg>", "gray"));
          return 1;
        }
        const state = await stateFail({ projectRoot, runId, error: extractFlagValue(rawArgv, "error") });
        process.stdout.write(`failed: ${state.error}\n`);
        return 0;
      }
      case "show": {
        const runId = rest[1];
        if (!runId) {
          error("run ID required");
          err(tint("Usage: adlc-cli workflow state show <run_id>", "gray"));
          return 1;
        }
        const state = stateShow({ projectRoot, runId });
        process.stdout.write(
          JSON.stringify({
          run_id: state.runId,
          workflow_id: state.workflowId,
          status: state.status,
          current_step_index: state.currentStepIndex,
          current_step_id: state.currentStepId,
          step_results: Object.fromEntries(
            Object.entries(state.stepResults).map(([k, v]) => [k, { status: v.status, error: v.error ?? null }]),
          ),
          error: state.error,
          }, null, 2) + "\n",
        );
        return 0;
      }
      case "help":
      default:
        out(
          panel({
            title: "Usage",
            lines: [
              tint("adlc-cli workflow state <command>", "bold"),
              "",
              ...[
                ["start   --workflow <id|path> [--run-id <id>] [--input k=v]", "Create a run (lease acquired)"],
                ["advance <run_id> --step <id> --status completed|failed", "Record a step result"],
                ["  [--output-file <path> | --output-json <json>] [--error <msg>]", ""],
                ["pause   <run_id> --step <id>", "Park at a gate/checkpoint (lease released)"],
                ["fail    <run_id> --error <msg>", "Terminal failure (lease released)"],
                ["show    <run_id>", "Read-only state access"],
              ].map(([label, description]) =>
                description
                  ? combine(tint(label, ACCENT), "  ", tint(description, "gray"))
                  : tint(label, "gray"),
              ),
            ],
          }),
        );
        return sub === "help" ? 0 : 1;
    }
  } catch (exc) {
    if (exc instanceof LeaseHeldError) {
      error(exc.message);
      return 1;
    }
    error(exc.message);
    return 1;
  }
}
