// Table renderer — Rich's default `HEAVY_HEAD` box, plus a borderless grid.
//
//   ┏━━━━━━━━━━━━━━┳━━━━━━━━━━━━┓
//   ┃ Key          ┃ Name       ┃
//   ┡━━━━━━━━━━━━━━╇━━━━━━━━━━━━┩
//   │ opencode     │ OpenCode   │
//   └──────────────┴────────────┘
//
// Content contract: cells are sanitized here. A cell that carries intentional
// styling is passed as a `SafeString` (produced by `style()` / `tint()`) and
// passes through untouched. Widths are measured on the visible text, so
// styled cells still align.

import {
  style,
  asText,
  combine,
  SafeString,
  visibleWidth,
  padEnd,
  padStart,
  sanitize,
  terminalWidth,
} from "./ansi.mjs";
import { ACCENT } from "./theme.mjs";

/**
 * Render a table.
 *
 * @param {object} options
 * @param {Array<string|{header: string, style?: string, optional?: boolean, justify?: "left"|"right"}>} options.columns
 * @param {Array<Array<string>>} [options.rows]
 * @param {string} [options.title]   Rendered above the table, accent + bold.
 * @param {"heavy"|"grid"} [options.box]
 * @param {number} [options.maxWidth]  Total width the table must fit in.
 * @returns {string}
 */
export function table({
  columns = [],
  rows = [],
  title = "",
  box = "heavy",
  maxWidth = terminalWidth(),
} = {}) {
  const cols = columns.map((col) => (typeof col === "string" ? { header: col } : { ...col }));

  const widths = cols.map((col, index) => {
    let width = visibleWidth(col.header ?? "");
    for (const row of rows) {
      const cell = row?.[index];
      if (cell !== undefined && cell !== null) {
        // Measure what will actually be printed: a cell carrying an escape
        // sequence is sanitized on the way out, so its printed width is
        // shorter than its raw width.
        width = Math.max(width, visibleWidth(asText(cell)));
      }
    }
    return width;
  });

  // Total width of the bordered form: 2 padding columns per cell + 1 separator
  // column between and around cells.
  const heavyWidth = widths.reduce((sum, w) => sum + w + 2, 0) + cols.length + 1;
  // The borderless form saves four columns of chrome.
  const gridWidth = widths.reduce((sum, w) => sum + w, 0) + 2 * Math.max(0, cols.length - 1);

  // Drop optional columns (right to left) until the table fits; fall back to
  // the borderless grid when even the optional-stripped table is too wide.
  const kept = rows.map((row) => [...row]);
  let changed = true;
  while (changed && cols.length > 1 && heavyWidthOf(widths, cols.length) > maxWidth) {
    changed = false;
    for (let i = cols.length - 1; i >= 0; i--) {
      if (!cols[i].optional) continue;
      cols.splice(i, 1);
      widths.splice(i, 1);
      for (const row of kept) row.splice(i, 1);
      changed = true;
      break;
    }
  }
  if (box === "heavy" && heavyWidthOf(widths, cols.length) > maxWidth) {
    box = "grid";
  }

  const out = [];
  if (title) out.push(style(sanitize(title), ACCENT, "bold"));

  if (box === "grid") {
    for (const row of kept) {
      out.push(
        cols
          .map((col, index) => {
            const cell = row?.[index];
            // asText, not String: the grid branch is what keyValue() renders,
            // and keyValue carries untrusted values (a workspace file's name,
            // a state file's current step). String(cell) would let a raw ESC
            // byte reach the terminal.
            const text = cell === undefined || cell === null ? "" : asText(cell);
            if (col.justify === "right") return padStart(text, widths[index]);
            return padEnd(text, widths[index]);
          })
          .join("  ")
          .trimEnd(),
      );
    }
    return new SafeString(out.join("\n"));
  }

  out.push(`┏${widths.map((w) => "━".repeat(w + 2)).join("┳")}┓`);
  out.push(
    `┃${cols
      .map((col, index) => {
        const header = col.header ?? "";
        const text = col.style ? style(header, col.style) : style(header, "bold");
        return ` ${padEnd(text, widths[index])} `;
      })
      .join("┃")}┃`,
  );
  out.push(`┡${widths.map((w) => "━".repeat(w + 2)).join("╇")}┩`);
  for (const row of kept) {
    out.push(
      `│${cols
        .map((col, index) => {
          const cell = row?.[index];
          const text = cell === undefined || cell === null ? "" : asText(cell);
          const padded = col.justify === "right" ? padStart(text, widths[index]) : padEnd(text, widths[index]);
          return ` ${padded} `;
        })
        .join("│")}│`,
    );
  }
  out.push(`└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`);
  return new SafeString(out.join("\n"));
}

function heavyWidthOf(widths, count) {
  let total = 0;
  for (let i = 0; i < count; i++) total += widths[i] + 2;
  return total + count + 1;
}

/**
 * Render a two-column key/value grid — the `Project: … / ADLC: …` shape.
 *
 * @param {Array<[string, string]>} entries
 * @returns {string}
 */
export function keyValue(entries) {
  const rows = entries.map(([key, value]) => [style(key, ACCENT), value ?? ""]);
  return table({ columns: [{ header: "" }, { header: "" }], rows, box: "grid" });
}
