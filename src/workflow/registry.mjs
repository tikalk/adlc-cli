// Step registry — maps type_key → StepBase instances.
// Ported from upstream spec-kit workflows/__init__.py @ adbd62a.
// The `init` step and catalog-network commands are NOT ported (ADR-390).

import { CommandStep, PromptStep } from "./steps/agent.mjs";
import { ShellStep } from "./steps/shell.mjs";
import { GateStep } from "./steps/gate.mjs";
import {
  IfThenStep,
  SwitchStep,
  WhileStep,
  DoWhileStep,
  FanOutStep,
  FanInStep,
  SlotStep,
} from "./steps/control.mjs";

export const STEP_REGISTRY = {};

function registerStep(step) {
  const key = step.typeKey;
  if (!key) throw new Error("Cannot register step type with an empty type_key.");
  if (key in STEP_REGISTRY) throw new Error(`Step type with key '${key}' is already registered.`);
  STEP_REGISTRY[key] = step;
}

export function getStepType(typeKey) {
  return STEP_REGISTRY[typeKey] ?? null;
}

export function registerBuiltinSteps() {
  registerStep(new CommandStep());
  registerStep(new DoWhileStep());
  registerStep(new FanInStep());
  registerStep(new FanOutStep());
  registerStep(new GateStep());
  registerStep(new IfThenStep());
  registerStep(new PromptStep());
  registerStep(new ShellStep());
  registerStep(new SlotStep());
  registerStep(new SwitchStep());
  registerStep(new WhileStep());
}

registerBuiltinSteps();

// The step types the factory ships (snapshot before any extension could load).
export const BUILTIN_STEP_TYPES = Object.freeze(new Set(Object.keys(STEP_REGISTRY)));
