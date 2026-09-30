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
} from "../factory/engine.mjs";
import { STEP_REGISTRY } from "../factory/registry.mjs";
import {
  stateStart,
  stateAdvance,
  statePause,
  stateFail,
  stateShow,
} from "../factory/state.mjs";
import { printWorkflowHelp } from "../help.mjs";
import { classifyWorkflowStatus } from "../exit-codes.mjs";

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
    case "help":
      printWorkflowHelp();
      return 0;
    default:
      console.error(`Unknown workflow command: "${sub}"`);
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

// Extract a single --flag value (or null) from raw argv.
function extractFlagValue(rawArgv, name) {
  const flag = `--${name}`;
  const idx = rawArgv.indexOf(flag);
  if (idx === -1) return null;
  const value = rawArgv[idx + 1];
  if (value === undefined || value.startsWith("-")) return null;
  return value;
}

function hasFlag(rawArgv, name) {
  return rawArgv.includes(`--${name}`);
}

function installInterruptHandler(engine) {
  const onInt = () => {
    engine.interrupted = true;
    console.error("\n[workflow] interrupt received — pausing after current step…");
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
  if (emitter !== null) {
    engine.onEvent = emitter;
  } else {
    engine.onStepStart = (stepId, label) => {
      console.log(`  ▶ ${stepId} (${label})`);
    };
  }
  return engine;
}

function printRunSummary(state) {
  console.log(`\nRun ID: ${state.runId}`);
  console.log(`Status: ${state.status}`);
  if (state.currentStepId) console.log(`Current: ${state.currentStepId}`);
  if (state.error) console.log(`Error:  ${state.error}`);
}

// ── run ──────────────────────────────────────────────────────────────────

async function cmdWorkflowRun(rest, rawArgv) {
  const source = rest.find((a) => !a.startsWith("-"));
  if (!source) {
    console.error("Error: workflow source required (file path, installed ID, or built-in like 'factory')");
    console.error("Usage: adlc-cli workflow run <source> --input key=value [--format json]");
    return 1;
  }

  const projectRoot = process.cwd();
  const engine = makeEngine(projectRoot, rawArgv);

  let definition;
  try {
    definition = engine.loadWorkflow(source);
  } catch (exc) {
    console.error(`Error: ${exc.message}`);
    return 1;
  }

  const validationErrors = engine.validate(definition, STEP_REGISTRY);
  if (hasFlag(rawArgv, "headless")) {
    validationErrors.push(...headlessGateErrors(definition));
  }
  if (validationErrors.length > 0) {
    console.error("Workflow validation failed:");
    for (const err of validationErrors) console.error(`  ✗ ${err}`);
    return 1;
  }

  let inputs;
  try {
    inputs = parseInputs(rawArgv, "run");
  } catch (exc) {
    console.error(`Error: ${exc.message}`);
    return 1;
  }

  const removeHandlers = installInterruptHandler(engine);
  try {
    const state = await engine.execute(definition, inputs, null, STEP_REGISTRY);
    if (engine.onEvent === null) printRunSummary(state);
    if (state.status === RunStatus.PAUSED) {
      console.log(`\nPaused at gate. Resume with: adlc-cli workflow resume ${state.runId} --input <verdict>=<choice>`);
    }
    // Lane contract: PAUSED exits 3 so the Argo expression
    // `asInt(lastRetry.exitCode) != 10 && asInt(lastRetry.exitCode) != 3`
    // excludes it from retries.
    return classifyWorkflowStatus(state.status).exitCode;
  } catch (exc) {
    if (exc instanceof LeaseHeldError) {
      console.error(`Error: ${exc.message}`);
      return 1;
    }
    console.error(`Error: ${exc.message}`);
    return 1;
  } finally {
    removeHandlers();
  }
}

// ── resume ───────────────────────────────────────────────────────────────

async function cmdWorkflowResume(rest, rawArgv) {
  const runId = rest.find((a) => !a.startsWith("-"));
  if (!runId) {
    console.error("Error: run ID required");
    console.error("Usage: adlc-cli workflow resume <run_id> --input key=value [--format json]");
    return 1;
  }

  const projectRoot = process.cwd();
  const engine = makeEngine(projectRoot, rawArgv);

  let inputs;
  try {
    inputs = parseInputs(rawArgv, "resume");
  } catch (exc) {
    console.error(`Error: ${exc.message}`);
    return 1;
  }

  const removeHandlers = installInterruptHandler(engine);
  try {
    const state = await engine.resume(runId, inputs, STEP_REGISTRY);
    if (engine.onEvent === null) printRunSummary(state);
    if (state.status === RunStatus.PAUSED) {
      console.log(`\nStill paused. Resume with: adlc-cli workflow resume ${state.runId} --input <verdict>=<choice>`);
    }
    // Lane contract: PAUSED exits 3 so the Argo expression
    // `asInt(lastRetry.exitCode) != 10 && asInt(lastRetry.exitCode) != 3`
    // excludes it from retries.
    return classifyWorkflowStatus(state.status).exitCode;
  } catch (exc) {
    if (exc instanceof LeaseHeldError) {
      console.error(`Error: ${exc.message}`);
      return 1;
    }
    console.error(`Error: ${exc.message}`);
    return 1;
  } finally {
    removeHandlers();
  }
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
      console.error(`Error: ${exc.message}`);
      return 1;
    }
    console.log(`Run ID: ${state.run_id}`);
    console.log(`Status: ${state.status}`);
    if (state.current_step_id) console.log(`Current: ${state.current_step_id}`);
    const stepResults = state.step_results ?? {};
    const ids = Object.keys(stepResults);
    if (ids.length > 0) {
      console.log(`\nSteps (${ids.length}):`);
      for (const id of ids) {
        console.log(`  ${statusIcon(stepResults[id].status)} ${id} — ${stepResults[id].status}`);
      }
    }
    return 0;
  }

  const runs = engine.listRuns();
  if (runs.length === 0) {
    console.log(`No workflow runs found (${join(projectRoot, RUNS_DIR)})`);
    return 0;
  }
  console.log(`Workflow runs (${runs.length}):`);
  for (const run of runs) {
    const current = run.current_step_id ? ` · ${run.current_step_id}` : "";
    console.log(`  ${statusIcon(run.status)} ${run.run_id} — ${run.status}${current} (${run.updated_at ?? ""})`);
  }
  return 0;
}

function statusIcon(status) {
  switch (status) {
    case RunStatus.COMPLETED: return "✓";
    case RunStatus.PAUSED: return "⏸";
    case RunStatus.FAILED: return "✗";
    case RunStatus.ABORTED: return "⛔";
    case RunStatus.RUNNING: return "▶";
    default: return "○";
  }
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
    console.error("Error: source required");
    console.error("Usage: adlc-cli workflow validate <workflow.yml|id> [--headless]");
    return 1;
  }

  const projectRoot = process.cwd();
  const engine = new WorkflowEngine(projectRoot);
  let definition;
  try {
    definition = engine.loadWorkflow(source);
  } catch (exc) {
    console.error(`Error: ${exc.message}`);
    return 1;
  }

  const errors = engine.validate(definition, STEP_REGISTRY);
  if (hasFlag(rawArgv, "headless")) {
    // --headless: every gate must declare verdict_input (ADR-391-amendment).
    errors.push(...headlessGateErrors(definition));
  }
  if (errors.length === 0) {
    console.log(`✓ ${definition.id} (${definition.name} v${definition.version}) — valid`);
    console.log(`  ${definition.steps.length} step(s), ${Object.keys(definition.inputs).length} input(s)`);
    return 0;
  }
  console.error(`Validation failed for ${source}:`);
  for (const err of errors) console.error(`  ✗ ${err}`);
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
          console.error("Error: --workflow <id|path> required");
          console.error("Usage: adlc-cli workflow state start --workflow <source> [--run-id <id>] [--input k=v]");
          return 1;
        }
        const runId = extractFlagValue(rawArgv, "run-id");
        const inputs = parseInputs(rawArgv, "start");
        const state = await stateStart({ projectRoot, workflowSource, runId, inputs });
        console.log(state.runId);
        return 0;
      }
      case "advance": {
        const runId = rest[1];
        const stepId = extractFlagValue(rawArgv, "step");
        const status = extractFlagValue(rawArgv, "status") ?? "completed";
        if (!runId || !stepId) {
          console.error("Error: run id and --step <id> required");
          console.error("Usage: adlc-cli workflow state advance <run_id> --step <id> --status completed|failed [--output-file <path>] [--error <msg>]");
          return 1;
        }
        if (!["completed", "failed"].includes(status)) {
          console.error(`Error: --status must be completed|failed, got '${status}'`);
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
        console.log(`${state.status}${state.currentStepId ? ` · next: ${state.currentStepId}` : ""}`);
        return 0;
      }
      case "pause": {
        const runId = rest[1];
        const stepId = extractFlagValue(rawArgv, "step");
        if (!runId || !stepId) {
          console.error("Error: run id and --step <id> required");
          console.error("Usage: adlc-cli workflow state pause <run_id> --step <id>");
          return 1;
        }
        const state = await statePause({ projectRoot, runId, stepId });
        console.log(`paused at ${state.currentStepId}`);
        return 0;
      }
      case "fail": {
        const runId = rest[1];
        if (!runId) {
          console.error("Error: run id required");
          console.error("Usage: adlc-cli workflow state fail <run_id> --error <msg>");
          return 1;
        }
        const state = await stateFail({ projectRoot, runId, error: extractFlagValue(rawArgv, "error") });
        console.log(`failed: ${state.error}`);
        return 0;
      }
      case "show": {
        const runId = rest[1];
        if (!runId) {
          console.error("Error: run id required");
          console.error("Usage: adlc-cli workflow state show <run_id>");
          return 1;
        }
        const state = stateShow({ projectRoot, runId });
        console.log(JSON.stringify({
          run_id: state.runId,
          workflow_id: state.workflowId,
          status: state.status,
          current_step_index: state.currentStepIndex,
          current_step_id: state.currentStepId,
          step_results: Object.fromEntries(
            Object.entries(state.stepResults).map(([k, v]) => [k, { status: v.status, error: v.error ?? null }]),
          ),
          error: state.error,
        }, null, 2));
        return 0;
      }
      case "help":
      default:
        console.log(`Usage: adlc-cli workflow state <command>

Commands:
  start   --workflow <id|path> [--run-id <id>] [--input k=v]   Create a run (lease acquired)
  advance <run_id> --step <id> --status completed|failed
          [--output-file <path> | --output-json <json>] [--error <msg>]   Record a step result
  pause   <run_id> --step <id>                                 Park at a gate/checkpoint (lease released)
  fail    <run_id> --error <msg>                               Terminal failure (lease released)
  show    <run_id>                                             Read-only state access`);
        return sub === "help" ? 0 : 1;
    }
  } catch (exc) {
    if (exc instanceof LeaseHeldError) {
      console.error(`Error: ${exc.message}`);
      return 1;
    }
    console.error(`Error: ${exc.message}`);
    return 1;
  }
}
