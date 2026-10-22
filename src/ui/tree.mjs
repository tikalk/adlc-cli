// Step tree — the specify CLI's `StepTracker`, rendered as a Rich tree.
//
//   factory
//   ├── ● plan     (approved)
//   ├── ● build
//   └── ○ verify
//
// A tree (not a panel) because the workflow runner appends steps as it goes
// and the reader needs to see the whole ladder at a glance.

import { style, asText, SafeString } from "./ansi.mjs";
import { ACCENT, sym } from "./theme.mjs";

const GUIDE_MID = "├──";
const GUIDE_LAST = "└──";

/**
 * Create a step tracker.
 *
 * @param {string} title
 */
export function createStepTracker(title = "") {
  const steps = [];
  const byKey = new Map();

  function upsert(key, label) {
    let step = byKey.get(key);
    if (!step) {
      step = { key, label: label ?? key, status: "pending", detail: "" };
      steps.push(step);
      byKey.set(key, step);
    } else if (label) {
      step.label = label;
    }
    return step;
  }

  function update(key, status, detail) {
    const step = upsert(key);
    step.status = status;
    if (detail) step.detail = detail;
    return step;
  }

  return {
    /** Register a step without starting it. */
    add(key, label) {
      return upsert(key, label);
    },
    /** Mark a step as running. */
    start(key, detail) {
      return update(key, "running", detail);
    },
    /** Mark a step as done. */
    complete(key, detail) {
      return update(key, "done", detail);
    },
    /** Mark a step as failed. */
    error(key, detail) {
      return update(key, "error", detail);
    },
    /** Mark a step as skipped. */
    skip(key, detail) {
      return update(key, "skipped", detail);
    },
    /** The tracked steps, in insertion order. */
    steps,
    /** Render a single step as a tree row (without the guide). */
    line(step) {
      return styleStep(step);
    },
    /** Render the whole tree, including the title. */
    render() {
      const lines = [];
      if (title) lines.push(style(title, ACCENT, "bold"));
      steps.forEach((step, index) => {
        const guide = index === steps.length - 1 ? GUIDE_LAST : GUIDE_MID;
        lines.push(`${style(guide, "gray")} ${styleStep(step)}`);
      });
      return new SafeString(lines.join("\n"));
    },
  };
}

/**
 * Render one step: glyph + label + optional dim detail.
 * The label inherits the terminal's default foreground so it stays legible
 * on light backgrounds; only the glyph and the detail are colored.
 */
function styleStep(step) {
  const detail = step.detail ? ` ${style(`(${asText(step.detail)})`, "gray")}` : "";
  switch (step.status) {
    case "done":
      return `${style(sym.done, ACCENT)} ${asText(step.label)}${detail}`;
    case "running":
      return `${style(sym.running, ACCENT)} ${asText(step.label)}${detail}`;
    case "error":
      return `${style(sym.done, "red")} ${asText(step.label)}${detail}`;
    case "skipped":
      return `${style(sym.pending, "yellow")} ${asText(step.label)}${detail}`;
    case "pending":
    default:
      return `${style(sym.pending, ACCENT)} ${style(step.label, "gray")}${detail}`;
  }
}
