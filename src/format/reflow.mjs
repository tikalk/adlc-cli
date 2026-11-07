// Deterministic reflow for collapsed Markdown (format-guard).
//
// Repairs a zero-newline Markdown text by re-inserting line breaks at known
// structural markers (headings, scope line, bullets) and by regrouping
// consecutive GFM table cells into rows. Pure function: never guesses.
// Any ambiguity returns the original text with `ambiguous: true`.

export const REFLOW_DEFAULTS = { maxTableColumns: 12 };

const SEPARATOR_ROW_RE = /\|\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|/;

// A line that is exactly a separator row, e.g. `|--|--|`.
const PURE_SEPARATOR_RE = /^\|\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|$/;

function maskSpans(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if ((normalized.match(/```/g) ?? []).length % 2 !== 0) {
    return { masked: normalized, spans: [], ambiguous: true };
  }
  const spans = [];
  const masked = normalized
    .replace(/```[\s\S]*?```/g, (match) => {
      spans.push(match);
      return `\u0000F${spans.length - 1}\u0000`;
    })
    .replace(/`[^`\n]+`/g, (match) => {
      spans.push(match);
      return `\u0000F${spans.length - 1}\u0000`;
    });
  return { masked, spans, ambiguous: false };
}

function restoreSpans(text, spans) {
  return spans.length === 0
    ? text
    : text.replace(/\u0000F(\d+)\u0000/g, (_, n) => spans[Number(n)]);
}

// Split at the given lookahead markers, joining segments with `glue`.
// Empty segments are dropped so a leading marker leaves no blank prefix.
function rejoinAt(text, markerRe, glue) {
  const parts = text.split(markerRe);
  if (parts.length === 1) return { text, changed: false };
  const cleaned = parts
    .map((p) => p.replace(/^\s+|\s+$/g, ""))
    .filter((p) => p !== "");
  return { text: cleaned.join(glue), changed: true };
}

function breakHeadings(masked) {
  return rejoinAt(masked, /(?=## )/, "\n\n");
}

function breakScope(masked) {
  return rejoinAt(masked, /(?=_Scope:)/, "\n\n");
}

function breakBullets(masked) {
  const first = rejoinAt(masked, /(?=- \*\*)/, "\n");
  if (!first.changed) return rejoinAt(masked, /(?=\d+\. \*\*)/, "\n");
  return first;
}

function repairTables(text, { maxTableColumns }) {
  const applied = [];
  const lines = text.split("\n");
  const separatorCount = (s) => (s.match(new RegExp(SEPARATOR_ROW_RE.source, "g")) ?? []).length;

  let i = 0;
  while (i < lines.length) {
    if (!SEPARATOR_ROW_RE.test(lines[i])) {
      i += 1;
      continue;
    }
    let rs = i;
    while (rs > 0 && lines[rs - 1].includes("|")) rs -= 1;
    let re = i;
    while (re + 1 < lines.length && lines[re + 1].includes("|")) re += 1;

    const block = lines.slice(rs, re + 1);
    if (block.some((l) => PURE_SEPARATOR_RE.test(l.trim()))) {
      i = re + 1;
      continue;
    }

    const joined = block.join(" ");
    if (separatorCount(joined) !== 1) {
      return { text: lines.join("\n"), applied, ambiguous: true, reason: "multi-separator" };
    }
    const separator = SEPARATOR_ROW_RE.exec(joined);
    const headerStart = joined.indexOf("|");
    if (headerStart === -1 || headerStart >= separator.index) {
      return { text: lines.join("\n"), applied, ambiguous: true, reason: "no-header" };
    }

    const headerCells = joined
      .slice(headerStart, separator.index)
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    const columns = headerCells.length;
    if (columns < 2 || columns > maxTableColumns) {
      return { text: lines.join("\n"), applied, ambiguous: true, reason: "column-count" };
    }

    const afterSep = joined.slice(separator.index + separator[0].length);
    const lastPipe = afterSep.lastIndexOf("|");
    const trailer = lastPipe === -1 ? afterSep.trim() : afterSep.slice(lastPipe + 1).trim();
    const tablePart = lastPipe === -1 ? "" : afterSep.slice(0, lastPipe + 1);
    const suffixCells = tablePart
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    const cells = [...headerCells, ...suffixCells];
    if (cells.length === 0 || cells.length % columns !== 0) {
      return { text: lines.join("\n"), applied, ambiguous: true, reason: "cell-count" };
    }

    const rows = [];
    for (let k = 0; k < cells.length; k += columns) {
      rows.push(`| ${cells.slice(k, k + columns).join(" | ")} |`);
    }
    const prefix = joined.slice(0, headerStart).trim();
    const rebuilt = [...(prefix ? [prefix, ""] : []), rows[0], `|${"--|".repeat(columns)}`, ...rows.slice(1)];
    if (trailer) rebuilt.push("", trailer);

    lines.splice(rs, re - rs + 1, ...rebuilt);
    applied.push("tables");
    if (applied.length > 50) {
      return { text: lines.join("\n"), applied, ambiguous: true, reason: "too-many-tables" };
    }
    i = rs + rebuilt.length;
  }
  return { text: lines.join("\n"), applied, ambiguous: false };
}

export function reflowMarkdown(text, options = {}) {
  const { maxTableColumns } = { ...REFLOW_DEFAULTS, ...options };
  const original = String(text ?? "");
  if (!original.trim()) return { text: original, applied: [], ambiguous: false };

  const { masked, spans, ambiguous } = maskSpans(original);
  if (ambiguous) return { text: original, applied: [], ambiguous: true, reason: "unbalanced-fence" };

  let working = masked;
  const applied = [];
  const headings = breakHeadings(working);
  if (headings.changed) {
    working = headings.text;
    applied.push("headings");
  }
  const scope = breakScope(working);
  if (scope.changed) {
    working = scope.text;
    applied.push("scope");
  }
  const bullets = breakBullets(working);
  if (bullets.changed) {
    working = bullets.text;
    applied.push("bullets");
  }

  const tables = repairTables(working, { maxTableColumns });
  if (tables.ambiguous) {
    return { text: original, applied: [], ambiguous: true, reason: tables.reason };
  }
  working = tables.text;
  applied.push(...tables.applied);

  working = working.replace(/\n{3,}/g, "\n\n");
  const result = restoreSpans(working, spans);

  const nonWs = (s) => s.replace(/\s/g, "").length;
  const pipes = (s) => (s.match(/\|/g) ?? []).length;
  if (nonWs(result) !== nonWs(original) || pipes(result) !== pipes(original)) {
    return { text: original, applied: [], ambiguous: true, reason: "content-drift" };
  }
  return { text: result, applied, ambiguous: false };
}
