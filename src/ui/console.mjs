// Output facade: writers plus the semantic one-liners every command uses.
//
// stdout carries the human-facing result; stderr carries failures. A panel
// body always goes to one stream only — the old code mixed `console.log` and
// `console.error` inside the same `┌─ │ └─` box, which is why the borders
// tore apart in a terminal.
//
// Always print through these writers, never `console.log`. The renderers
// return a `SafeString` (a String subclass) so the renderers can tell styled
// text from untrusted text; `console.log` would `util.inspect` that subclass
// and print `[String (SafeString): '…']` instead of the text. `out()`/`err()`
// interpolate, which yields the raw string.

import { style, asText } from "./ansi.mjs";
import { sym, ACCENT } from "./theme.mjs";

/** Write a line to stdout. */
export function out(text = "") {
  process.stdout.write(`${text}\n`);
}

/** Write a line to stderr. */
export function err(text = "") {
  process.stderr.write(`${text}\n`);
}

/** Write raw text to stdout with no trailing newline. */
export function write(text) {
  process.stdout.write(String(text ?? ""));
}

/** A blank line on stdout. */
export function blank() {
  out("");
}

/** A section heading — bold accent, used above panels and lists. */
export function heading(text) {
  out(style(text, ACCENT, "bold"));
}

/** A step marker: `▶ doing the thing`. */
export function step(text) {
  out(`${style(sym.step, ACCENT)} ${asText(text)}`);
}

/** A success line: `✓ done`. */
export function success(text) {
  out(`${style(sym.success, "green")} ${asText(text)}`);
}

/** A failure line on stderr: `✗ failed`. */
export function failure(text) {
  err(`${style(sym.failure, "red")} ${asText(text)}`);
}

/** A warning line on stderr. */
export function warn(text) {
  err(`${style(sym.warn, "yellow")} ${asText(text)}`);
}

/** An error line on stderr, labeled the way specify labels them. */
export function error(text) {
  err(`${style("Error:", "red")} ${asText(text)}`);
}

/** A dim informational line on stdout. */
export function note(text) {
  out(style(text, "gray"));
}

/** A secondary line on stdout, indented under the current step. */
export function detail(text) {
  out(`  ${style(text, "gray")}`);
}

/**
 * An indented result line under the current step: `  ✓ text`.
 * @param {string} text
 * @param {{glyph?: string, color?: string}} [options]
 */
export function item(text, { glyph = sym.bullet, color = "gray" } = {}) {
  out(`  ${style(glyph, color)} ${asText(text)}`);
}
