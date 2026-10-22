// Bordered panel — the specify CLI's `rich.panel.Panel` look.
//
//   ╭─ opencode (opencode) ─────────────╮
//   │ Found 12 skill(s) in .agents/skills│
//   ╰─────────────────────────────────────╯
//
// The box is structural, not color: it draws the same with or without a TTY
// so piped output keeps the same shape as terminal output.
//
// Content contract: the title and the body lines are sanitized here. Text
// that carries intentional styling is passed as a `SafeString` (produced by
// `style()` / `tint()`) and passes through untouched.

import {
  style,
  asText,
  SafeString,
  visibleWidth,
  padEnd,
  wrapStyled,
  terminalWidth,
} from "./ansi.mjs";
import { ACCENT } from "./theme.mjs";

const TOP_LEFT = "╭";
const TOP_RIGHT = "╮";
const BOTTOM_LEFT = "╰";
const BOTTOM_RIGHT = "╯";
const HORIZONTAL = "─";
const VERTICAL = "│";

/**
 * Render a bordered panel.
 *
 * @param {object} options
 * @param {string} [options.title]     Panel title, embedded in the top border.
 * @param {string[]} [options.lines]    Body lines (already sanitized/styled).
 * @param {string} [options.accent]     Border + title color.
 * @param {number} [options.minWidth]   Minimum inner content width.
 * @param {number} [options.maxWidth]   Maximum total panel width.
 * @returns {string} The rendered panel (no trailing newline).
 */
export function panel({
  title = "",
  lines = [],
  accent = ACCENT,
  minWidth = 24,
  maxWidth = terminalWidth(),
} = {}) {
  // 2 border columns + 1 padding column on each side.
  const inner = Math.max(8, maxWidth - 4);

  const flat = [];
  for (const line of lines) {
    for (const chunk of wrapStyled(asText(line), inner)) flat.push(chunk);
  }

  const titleText = title ? asText(title) : "";
  let titleVisible = visibleWidth(titleText);
  let titleLabel = titleText;
  if (titleVisible > inner - 2) {
    titleLabel = `${titleText.slice(0, Math.max(0, inner - 3))}…`;
    titleVisible = visibleWidth(titleLabel);
  }

  let contentWidth = minWidth;
  for (const line of flat) contentWidth = Math.max(contentWidth, visibleWidth(line));
  contentWidth = Math.min(contentWidth, inner);
  if (titleText) contentWidth = Math.max(contentWidth, titleVisible + 1);

  const renderedTitle = titleText
    ? ` ${style(titleLabel, accent, "bold")} `
    : "";

  const topFill = titleText
    ? HORIZONTAL.repeat(Math.max(0, contentWidth - titleVisible - 1))
    : HORIZONTAL.repeat(contentWidth + 1);

  const out = [];
  out.push(
    `${style(TOP_LEFT + HORIZONTAL, accent)}${renderedTitle}${style(topFill + TOP_RIGHT, accent)}`,
  );
  for (const line of flat) {
    out.push(`${style(VERTICAL, accent)} ${padEnd(line, contentWidth)} ${style(VERTICAL, accent)}`);
  }
  out.push(
    `${style(BOTTOM_LEFT, accent)}${style(HORIZONTAL.repeat(contentWidth + 2), accent)}${style(BOTTOM_RIGHT, accent)}`,
  );
  return new SafeString(out.join("\n"));
}

/**
 * Render an indented step list — used where a child process writes straight
 * to the terminal, so a box would be torn apart by interleaved output.
 *
 *   ▸ opencode (opencode)
 *     → npx skills add tikalk/adlc-team-skills -a opencode
 *     ✓ Found 12 skill(s) in .agents/skills
 *
 * @param {string} headingText
 * @param {Array<{text: string, color?: string, glyph?: string}>} items
 * @returns {string}
 */
export function stepList(headingText, items = []) {
  const lines = [];
  if (headingText) lines.push(`${style("▸", ACCENT)} ${style(headingText, "bold")}`);
  for (const item of items) {
    const glyph = item.glyph ? `${style(item.glyph, item.color ?? "gray")} ` : "";
    lines.push(`  ${glyph}${asText(item.text)}`);
  }
  return lines.join("\n");
}
