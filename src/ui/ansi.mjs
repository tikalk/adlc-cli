// ANSI primitives: color detection, SGR styling, width math, sanitization.
//
// Zero dependencies by design (ADR-409 keeps a Rust rewrite in backlog —
// this module is the narrow, portable seam that ports across unchanged).
// `util.styleText` is deliberately not used: it landed in Node 20.12 and
// package.json declares `node >= 18`.

// SGR codes. `gray` is Rich's `bright_black` (SGR 90).
const SGR = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};

// Every CSI sequence, not just SGR — we strip what we emit and anything a
// subprocess may have leaked into a captured buffer.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

// C0 (minus tab/LF/CR) and C1 control characters. ESC (0x1b) is inside
// \x0a-\x1f, so a hostile string cannot smuggle an ANSI sequence through.
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

// East Asian Wide / Fullwidth ranges — these occupy two terminal cells.
const WIDE_CHARS =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

let colorOverride = null; // "always" | "never" | null (auto)

/**
 * Force color on or off, overriding TTY detection.
 * @param {"auto"|"always"|"never"} mode
 */
export function setColorMode(mode) {
  if (mode === "always" || mode === "never") {
    colorOverride = mode;
  } else {
    colorOverride = null;
  }
}

/** Whether ANSI styling is currently emitted. */
export function colorEnabled() {
  if (colorOverride === "always") return true;
  if (colorOverride === "never") return false;
  return detectColorSupport();
}

function detectColorSupport() {
  // https://no-color.org — presence alone disables, regardless of value.
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) {
    const value = String(process.env.FORCE_COLOR).toLowerCase();
    return !(value === "0" || value === "false" || value === "no");
  }
  if (process.env.TERM === "dumb") return false;
  // Either stream may be a terminal: a human may be watching stderr while
  // stdout is piped, or the reverse.
  return Boolean((process.stdout && process.stdout.isTTY) || (process.stderr && process.stderr.isTTY));
}

/**
 * A string that is already safe to print.
 *
 * The renderers sanitize anything they are handed, so a value that carries
 * intentional styling must be marked — otherwise the renderer would eat the
 * ESC byte of our own SGR codes. `style()` and `tint()` return this type.
 */
export class SafeString extends String {}

/**
 * Style text and mark the result safe to print.
 * @param {unknown} text
 * @param {...string} names style names from the SGR table
 */
export function style(text, ...names) {
  const value = asText(text);
  if (!colorEnabled()) return new SafeString(value);
  const codes = [];
  for (const name of names) {
    const code = SGR[name];
    if (code !== undefined) codes.push(code);
  }
  if (codes.length === 0) return new SafeString(value);
  return new SafeString(`\x1b[${codes.join(";")}m${value}\x1b[0m`);
}

/**
 * Reduce a value to safe printable text.
 *
 * A `SafeString` is passed through untouched (it was sanitized when it was
 * styled); anything else is sanitized here, so untrusted content can never
 * reach the terminal with an escape sequence intact.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function asText(value) {
  if (value instanceof SafeString) return String(value);
  return sanitize(value);
}

/**
 * Concatenate parts, sanitizing the plain ones and preserving styled ones.
 * Use instead of `+` when a styled fragment is combined with untrusted text.
 * @param {...unknown} parts
 * @returns {SafeString}
 */
export function combine(...parts) {
  return new SafeString(parts.map((part) => asText(part)).join(""));
}

/** Remove ANSI escape sequences from a string. */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

/**
 * Visible width in terminal cells, ignoring ANSI sequences.
 * Wide (CJK) characters count as two.
 */
export function visibleWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) {
    if (ch === "\t") {
      width += 4;
      continue;
    }
    width += WIDE_CHARS.test(ch) ? 2 : 1;
  }
  return width;
}

/**
 * Strip control characters so untrusted content (repo URLs, step labels,
 * agent output) cannot inject ANSI sequences or rewrite the terminal.
 * Mirrors the regex already used by the workflow gate.
 */
export function sanitize(text) {
  return String(text ?? "").replace(CONTROL_CHARS, "");
}

/**
 * Sanitize, then style — the correct order for untrusted content.
 * Styling first would let `sanitize` eat the ESC byte of our own SGR codes.
 * @param {unknown} text
 * @param {...string} names style names from the SGR table
 */
export function tint(text, ...names) {
  return style(sanitize(text), ...names);
}
/**
 * Sanitize a multi-line string into individual safe lines.
 * @param {unknown} text
 * @returns {string[]}
 */
export function sanitizeLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => sanitize(line));
}

/** Pad a (possibly styled) string to a visible width. */
export function padEnd(text, width) {
  const value = String(text ?? "");
  const pad = width - visibleWidth(value);
  return pad > 0 ? value + " ".repeat(pad) : value;
}

/** Pad a (possibly styled) string to a visible width, from the left. */
export function padStart(text, width) {
  const value = String(text ?? "");
  const pad = width - visibleWidth(value);
  return pad > 0 ? " ".repeat(pad) + value : value;
}

/**
 * Terminal width in columns.
 * `process.stdout.columns` is undefined when stdout is not a TTY, so fall
 * back to the `COLUMNS` env var, then to 100 (Rich's non-TTY default).
 */
export function terminalWidth() {
  if (process.stdout && Number.isInteger(process.stdout.columns) && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  const fromEnv = parseInt(process.env.COLUMNS ?? "", 10);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return 100;
}

/**
 * Word-wrap plain (unstyled) text to a visible width.
 * @param {unknown} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapText(text, width) {
  const value = String(text ?? "");
  if (width <= 0) return [value];
  const out = [];
  for (const paragraph of value.split("\n")) {
    if (visibleWidth(paragraph) <= width) {
      out.push(paragraph);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current === "") {
        current = word;
        continue;
      }
      if (visibleWidth(`${current} ${word}`) <= width) {
        current = `${current} ${word}`;
      } else {
        out.push(current);
        current = word;
      }
    }
    if (current !== "") out.push(current);
  }
  return out.length > 0 ? out : [""];
}

/**
 * Word-wrap a string that may contain ANSI sequences, preserving them.
 *
 * Styles are closed at the end of each produced line and re-opened on the
 * continuation, so a wrapped coloured cell keeps its colour.
 *
 * @param {unknown} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapStyled(text, width) {
  const source = String(text ?? "");
  if (width <= 0) return [source];
  const out = [];
  for (const paragraph of source.split("\n")) {
    for (const chunk of wrapStyledLine(paragraph, width)) out.push(chunk);
  }
  return out.length > 0 ? out : [""];
}

function wrapStyledLine(source, width) {
  if (width <= 0) return [source];
  if (visibleWidth(source) <= width) return [source];

  const lines = [];
  let line = "";
  let lineWidth = 0;
  let active = null; // SGR parameters of the currently open style
  let breakAt = -1; // index into `line` of the last breakable space

  const close = (body) => (active ? `${body}\x1b[0m` : body);

  let i = 0;
  while (i < source.length) {
    if (source[i] === "\x1b") {
      const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(source.slice(i));
      if (match) {
        if (match[2] === "m") {
          const params = match[1];
          active = params === "" || params === "0" ? null : params;
        }
        line += match[0];
        i += match[0].length;
        continue;
      }
    }

    const ch = source[i];
    if (ch === "\n") {
      lines.push(close(line));
      line = "";
      lineWidth = 0;
      breakAt = -1;
      i += 1;
      continue;
    }
    if (ch === " ") breakAt = line.length;
    line += ch;
    lineWidth += 1;
    i += 1;

    if (lineWidth > width) {
      let head;
      let tail;
      if (breakAt > 0) {
        head = line.slice(0, breakAt);
        tail = line.slice(breakAt + 1);
      } else {
        head = line.slice(0, line.length - 1);
        tail = line.slice(line.length - 1);
      }
      lines.push(close(head));
      line = (active ? `\x1b[${active}m` : "") + tail;
      lineWidth = visibleWidth(tail);
      breakAt = -1;
    }
  }

  if (line !== "") lines.push(close(line));
  return lines;
}
