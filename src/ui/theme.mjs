// Visual language: the palette and the glyph set.
//
// The accent is `cyan` — the same accent the specify CLI uses, so the two
// CLIs read as one family. Every color decision lives here, so a palette
// change is a one-line edit.

export const ACCENT = "cyan";

/** Status glyphs. Kept ASCII-adjacent so they render in every terminal. */
export const sym = {
  success: "✓",
  failure: "✗",
  warn: "!",
  info: "•",
  step: "▶",
  arrow: "→",
  done: "●",
  pending: "○",
  running: "○",
  skipped: "○",
  bullet: "•",
  // "Already there, nothing to do" — kept from the original `= path` marker.
  exists: "=",
};

/**
 * Status → glyph + color. Used by the step tree, run lists and tables.
 * @param {string} status
 * @returns {{glyph: string, color: string|undefined}}
 */
export function statusStyle(status) {
  switch (status) {
    case "completed":
    case "done":
      return { glyph: sym.success, color: "green" };
    case "failed":
    case "error":
      return { glyph: sym.failure, color: "red" };
    case "paused":
      return { glyph: "⏸", color: "yellow" };
    case "aborted":
      return { glyph: "⛔", color: "red" };
    case "running":
      return { glyph: sym.step, color: "cyan" };
    case "skipped":
      return { glyph: sym.pending, color: "yellow" };
    case "pending":
      return { glyph: sym.pending, color: "gray" };
    default:
      return { glyph: sym.pending, color: "gray" };
  }
}
