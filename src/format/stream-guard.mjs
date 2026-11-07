// Stream guard for live `agent run` output (format-guard).
//
// Buffers assistant message text across one turn, then either warns or
// repairs at the turn boundary. Never throws: ambiguous input is reported
// as a warning event, never guessed.

import { detectCollapsed } from "./detect.mjs";
import { reflowMarkdown } from "./reflow.mjs";

export function createStreamGuard({ mode = "warn", minLength = 200 } = {}) {
  if (!["none", "warn", "fix"].includes(mode)) {
    throw new Error(`unknown stream-guard mode: "${mode}"`);
  }
  let buffer = [];
  let flushed = false;

  return {
    push(event) {
      if (mode === "none" || event?.type !== "message") return [event];
      flushed = false;
      const text = typeof event.text === "string" ? event.text : "";
      buffer.push(text);
      if (mode === "warn") return [event];
      return [];
    },
    flush() {
      if (flushed) return [];
      flushed = true;
      if (mode === "none") return [];
      const joined = buffer.join("");
      buffer = [];
      if (!joined) return [];
      const detected = detectCollapsed(joined, { minLength });
      if (!detected.collapsed) return [];
      if (mode === "warn") {
        return [{
          type: "warning",
          code: "collapsed-markdown",
          family: detected.family,
          reasons: detected.reasons,
          chars: joined.length,
        }];
      }
      const fixed = reflowMarkdown(joined);
      if (fixed.ambiguous) {
        return [{
          type: "warning",
          code: "reflow-ambiguous",
          family: detected.family,
          reasons: detected.reasons,
          chars: joined.length,
        }];
      }
      return [{ type: "message", text: fixed.text }];
    },
  };
}
