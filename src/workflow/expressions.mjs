// Sandboxed expression evaluator for factory workflow templates.
// Full port of upstream spec-kit src/specify_cli/workflows/expressions.py @ adbd62a.
// Templates cannot perform file I/O, import modules, or run arbitrary code —
// the evaluator only walks the namespace and applies a fixed set of filters.

const REGISTERED_FILTERS = ["default", "join", "map", "contains", "from_json"];

// ── Custom filters ──────────────────────────────────────────────────────

function filterDefault(value, defaultValue = "") {
  if (value === null || value === "") return defaultValue;
  return value;
}

function filterJoin(value, separator = ", ") {
  if (typeof separator !== "string") {
    throw new Error(`join: expected a string separator, got ${typeNameForError(separator)}`);
  }
  if (Array.isArray(value)) return value.map((v) => String(v)).join(separator);
  return String(value);
}

function filterMap(value, attr) {
  if (typeof attr !== "string") {
    throw new Error(`map: expected a string attribute name, got ${typeNameForError(attr)}`);
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        // Support dot notation: "result.status" → item.result.status
        const parts = attr.split(".");
        let v = item;
        for (const part of parts) {
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            v = part in v ? v[part] : undefined;
          } else {
            v = null;
            break;
          }
          if (v === undefined) v = null;
        }
        result.push(v);
      } else {
        result.push(item);
      }
    }
    return result;
  }
  return [];
}

function filterContains(value, substring) {
  if (typeof value === "string") {
    if (typeof substring !== "string") {
      throw new Error(
        `contains: expected a string argument when the value is a string, got ${typeNameForError(substring)}`,
      );
    }
    return value.includes(substring);
  }
  if (Array.isArray(value)) return value.includes(substring);
  return false;
}

function filterFromJson(value) {
  if (typeof value !== "string") {
    throw new Error(`from_json: expected a JSON string, got ${typeNameForError(value)}`);
  }
  try {
    return JSON.parse(value);
  } catch (exc) {
    throw new Error(`from_json: invalid JSON: ${exc.message}`);
  }
}

function typeNameForError(value) {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  const t = typeof value;
  if (t === "object") return "dict";
  if (t === "boolean") return "bool";
  if (t === "number") return Number.isInteger(value) ? "int" : "float";
  return t;
}

// ── Expression resolution ───────────────────────────────────────────────

// The one definition of an indexed path segment. _resolveDotPath matches
// against it, and the condition gate below reuses it.
const INDEXED_SEGMENT = /^([\w-]+)\[(\d+)\]$/;
const PLAIN_SEGMENT = /^[\w-]+$/;

function resolveDotPath(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    const idxMatch = part.match(INDEXED_SEGMENT);
    if (idxMatch) {
      const key = idxMatch[1];
      const idx = parseInt(idxMatch[2], 10);
      if (current !== null && typeof current === "object" && !Array.isArray(current)) {
        current = key in current ? current[key] : undefined;
      } else {
        return null;
      }
      if (Array.isArray(current) && 0 <= idx && idx < current.length) {
        current = current[idx];
      } else {
        return null;
      }
    } else if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      current = part in current ? current[part] : undefined;
    } else {
      return null;
    }
    if (current === undefined || current === null) {
      return null === current ? null : null;
    }
  }
  return current === undefined ? null : current;
}

function buildNamespace(context) {
  const ns = {};
  if ("inputs" in (context ?? {})) ns.inputs = context.inputs ?? {};
  if ("steps" in (context ?? {})) ns.steps = context.steps ?? {};
  if ("item" in (context ?? {})) ns.item = context.item;
  if ("fanIn" in (context ?? {})) ns.fan_in = context.fanIn ?? {};
  // Engine-managed runtime metadata. Always present (even outside a run)
  // so templates referencing it never error.
  const runId = context?.runId ?? "";
  const workflowDir = context?.workflowDir ?? "";
  ns.context = { run_id: runId, workflow_dir: workflowDir };
  return ns;
}

function isSingleExpression(stripped) {
  // True when stripped is exactly one top-level {{ ... }} block. Scans the
  // block body for a }} that would close it early, ignoring braces inside
  // string literals — a regex span check cannot decide this (issue #3208).
  if (!(stripped.startsWith("{{") && stripped.endsWith("}}"))) return false;
  const inner = stripped.slice(2, -2);
  if (inner.trim() === "") return false;
  let quote = null;
  let i = 0;
  const n = inner.length;
  while (i < n) {
    const ch = inner[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "}" && i + 1 < n && inner[i + 1] === "}") {
      return false;
    }
    i++;
  }
  return true;
}

function findBlockClose(text, start) {
  // Index of the }} closing the block opened by the {{ at start, or -1.
  // Quote-aware, so a literal }} inside a string argument does not close
  // the block early.
  let quote = null;
  let i = start + 2;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "}" && i + 1 < n && text[i + 1] === "}") {
      return i;
    }
    i++;
  }
  return -1;
}

function firstUnclosableBlock(text) {
  // How interpolateExpressions will fail on the first block it cannot close
  // with the quote-aware scan, or null when every block closes.
  // "evaluated" = a raw }} still follows the opener (truncated evaluation);
  // "verbatim" = no }} follows at all (tail emitted unchanged).
  let i = 0;
  while (true) {
    const start = text.indexOf("{{", i);
    if (start === -1) return null;
    const close = findBlockClose(text, start);
    if (close === -1) {
      return text.indexOf("}}", start + 2) !== -1 ? "evaluated" : "verbatim";
    }
    i = close + 2;
  }
}

function interpolateExpressions(template, namespace) {
  // Substitute every top-level {{ ... }} block, quote-aware.
  const out = [];
  let i = 0;
  const n = template.length;
  while (i < n) {
    const start = template.indexOf("{{", i);
    if (start === -1) {
      out.push(template.slice(i));
      break;
    }
    out.push(template.slice(i, start));
    let close = findBlockClose(template, start);
    if (close === -1) {
      const rawClose = template.indexOf("}}", start + 2);
      if (rawClose === -1) {
        out.push(template.slice(start));
        break;
      }
      close = rawClose;
    }
    const val = evaluateSimpleExpression(template.slice(start + 2, close).trim(), namespace);
    out.push(val !== null && val !== undefined ? String(val) : "");
    i = close + 2;
  }
  return out.join("");
}

function splitTopLevel(text, sep) {
  // Split on each occurrence of sep that lies outside any quoted string or
  // nested brackets.
  const parts = [];
  let start = 0;
  while (true) {
    const idx = findTopLevel(text.slice(start), sep);
    if (idx === -1) {
      parts.push(text.slice(start));
      return parts;
    }
    parts.push(text.slice(start, start + idx));
    start += idx + sep.length;
  }
}

function splitTopLevelCommas(text) {
  // Split on commas that are not inside quotes or nested brackets.
  const parts = [];
  let buf = [];
  let quote = null;
  let depth = 0;
  for (const ch of text) {
    if (quote !== null) {
      buf.push(ch);
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      buf.push(ch);
    } else if ("([{".includes(ch)) {
      depth += 1;
      buf.push(ch);
    } else if (")]}".includes(ch)) {
      depth = Math.max(0, depth - 1);
      buf.push(ch);
    } else if (ch === "," && depth === 0) {
      parts.push(buf.join(""));
      buf = [];
    } else {
      buf.push(ch);
    }
  }
  parts.push(buf.join(""));
  return parts;
}

function findTopLevel(text, token) {
  // Index of the first occurrence of token outside any quoted string or
  // nested bracket, or -1.
  let quote = null;
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth += 1;
    } else if (")]}".includes(ch)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && text.startsWith(token, i)) {
      return i;
    }
    i++;
  }
  return -1;
}

function isSingleListLiteral(expr) {
  // True only when expr is exactly one bracketed list literal — the opening
  // [ closes at the FINAL character, not partway through.
  if (!(expr.startsWith("[") && expr.endsWith("]"))) return false;
  let quote = null;
  let depth = 0;
  const n = expr.length;
  for (let i = 0; i < n; i++) {
    const ch = expr[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if ("([{".includes(ch)) {
      depth += 1;
    } else if (")]}".includes(ch)) {
      depth -= 1;
      if (depth === 0) return i === n - 1;
    }
  }
  return false;
}

function applyFilter(value, filterExpr, namespace) {
  // Apply a single pipe filter segment to value; fail loudly on any
  // mis-wired or unknown filter.
  const leading = filterExpr.match(/^\w+/);
  if (leading && leading[0] === "from_json") {
    if (filterExpr !== "from_json") {
      throw new Error(
        `from_json: expected '| from_json' with no arguments or trailing tokens, got '| ${filterExpr}'`,
      );
    }
    return filterFromJson(value);
  }

  const filterMatch = filterExpr.match(/^(\w+)\((.+)\)$/s);
  if (filterMatch) {
    const fname = filterMatch[1];
    const farg = evaluateSimpleExpression(filterMatch[2].trim(), namespace);
    if (fname === "default") return filterDefault(value, farg);
    if (fname === "join") return filterJoin(value, farg);
    if (fname === "map") return filterMap(value, farg);
    if (fname === "contains") return filterContains(value, farg);
  }
  if (filterExpr === "default") return filterDefault(value);
  const name = leading ? leading[0] : filterExpr;
  const expected =
    "expected one of default or default('x'), join('sep'), map('attr'), contains('s'), or from_json";
  if (REGISTERED_FILTERS.includes(name)) {
    throw new Error(
      `filter '${name}' used in an unsupported form (got '| ${filterExpr}'): ${expected}`,
    );
  }
  throw new Error(`unknown filter '${name}': ${expected} (got '| ${filterExpr}')`);
}

// Order matters — multi-char operators first, so "!=" is not split as "!" + "=".
const COMPARISON_OPERATORS = ["!=", "==", ">=", "<=", ">", "<", " not in ", " in "];

function evaluateSimpleExpression(expr, namespace) {
  expr = expr.trim();

  // String literal — only when the WHOLE expression is one quoted string.
  if ((expr[0] === "'" || expr[0] === '"') && expr.indexOf(expr[0], 1) === expr.length - 1) {
    return expr.slice(1, -1);
  }

  // Pipe filters — top-level only, chain left-to-right.
  const pipeIdx = findTopLevel(expr, "|");
  if (pipeIdx !== -1) {
    const segments = splitTopLevel(expr, "|");
    const head = segments[0].trim();
    // Reject ambiguous filter-vs-operator precedence rather than guessing.
    let ambiguousOp = head.startsWith("not ") ? "not" : null;
    if (ambiguousOp === null) {
      for (const op of ["!=", "==", ">=", "<=", ">", "<", " not in ", " in ", " or ", " and "]) {
        if (findTopLevel(head, op) !== -1) {
          ambiguousOp = op.trim();
          break;
        }
      }
    }
    if (ambiguousOp !== null) {
      throw new Error(
        `ambiguous filter precedence in '${expr}': '| ${segments[1].trim()}' would apply to the ` +
        `result of '${head}', not to an operand of '${ambiguousOp}'. Filter the operand in its ` +
        `own expression instead.`,
      );
    }
    let value = evaluateSimpleExpression(head, namespace);
    for (let i = 1; i < segments.length; i++) {
      value = applyFilter(value, segments[i].trim(), namespace);
    }
    return value;
  }

  // Boolean operators — parse 'or' first (lower precedence) so that
  // 'a or b and c' is evaluated as 'a or (b and c)'.
  const orIdx = findTopLevel(expr, " or ");
  if (orIdx !== -1) {
    const left = evaluateSimpleExpression(expr.slice(0, orIdx).trim(), namespace);
    const right = evaluateSimpleExpression(expr.slice(orIdx + 4).trim(), namespace);
    return Boolean(left) || Boolean(right);
  }

  const andIdx = findTopLevel(expr, " and ");
  if (andIdx !== -1) {
    const left = evaluateSimpleExpression(expr.slice(0, andIdx).trim(), namespace);
    const right = evaluateSimpleExpression(expr.slice(andIdx + 5).trim(), namespace);
    return Boolean(left) && Boolean(right);
  }

  if (expr.startsWith("not ")) {
    const inner = evaluateSimpleExpression(expr.slice(4).trim(), namespace);
    return !Boolean(inner);
  }

  // Comparison operators (multi-char first).
  for (const op of COMPARISON_OPERATORS) {
    const opIdx = findTopLevel(expr, op);
    if (opIdx !== -1) {
      const left = evaluateSimpleExpression(expr.slice(0, opIdx).trim(), namespace);
      const right = evaluateSimpleExpression(expr.slice(opIdx + op.length).trim(), namespace);
      if (op === "==") return looseEq(left, right);
      if (op === "!=") return !looseEq(left, right);
      if (op === ">") return safeCompare(left, right, ">");
      if (op === "<") return safeCompare(left, right, "<");
      if (op === ">=") return safeCompare(left, right, ">=");
      if (op === "<=") return safeCompare(left, right, "<=");
      if (op === " in ") return safeMembership(left, right, false);
      if (op === " not in ") return safeMembership(left, right, true);
    }
  }

  // Numeric literal
  if (/^[+-]?\d+$/.test(expr)) return parseInt(expr, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+[eE][+-]?\d+)$/.test(expr)) return parseFloat(expr);

  // Boolean literal
  const lower = expr.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;

  // Null
  if (lower === "none" || lower === "null") return null;

  // List literal (simple)
  if (isSingleListLiteral(expr)) {
    const inner = expr.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner)
      .map((i) => i.trim())
      .filter((i) => i !== "")
      .map((i) => evaluateSimpleExpression(i, namespace));
  }

  // Variable reference (dot-path)
  return resolveDotPath(namespace, expr);
}

// Python ==/!= semantics: numbers compare across int/float; otherwise strict
// (no JS-style "1" == 1 coercion).
function looseEq(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => looseEq(v, b[i]));
  }
  if (a !== null && typeof a === "object" && b !== null && typeof b === "object" &&
      !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => looseEq(a[k], b[k]));
  }
  return a === b;
}

function coerceNumber(value) {
  if (typeof value === "string") {
    if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+[eE][+-]?\d+|\d+\.\d+[eE][+-]?\d+)$/.test(value)) {
      return parseFloat(value);
    }
  }
  return value;
}

function safeMembership(left, right, negate) {
  let contained;
  try {
    if (typeof right === "string" && typeof left === "string") contained = right.includes(left);
    else if (Array.isArray(right)) contained = right.some((v) => looseEq(v, left));
    else contained = false;
  } catch {
    contained = false;
  }
  return negate ? !contained : contained;
}

function safeCompare(left, right, op) {
  const cl = coerceNumber(left);
  const cr = coerceNumber(right);
  let l = left;
  let r = right;
  if (typeof cl === "number" && typeof cr === "number") {
    l = cl;
    r = cr;
  }
  try {
    if (typeof l !== typeof r) return false;
    if (op === ">") return l > r;
    if (op === "<") return l < r;
    if (op === ">=") return l >= r;
    if (op === "<=") return l <= r;
  } catch {
    return false;
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────

export function evaluateExpression(template, context) {
  // If the entire string is a single expression, return the raw typed value.
  // Otherwise substitute each expression inline and return a string.
  if (typeof template !== "string") return template;

  const namespace = buildNamespace(context);
  const stripped = template.trim();
  if (isSingleExpression(stripped)) {
    return evaluateSimpleExpression(stripped.slice(2, -2).trim(), namespace);
  }
  return interpolateExpressions(template, namespace);
}

export function evaluateCondition(condition, context) {
  const result = evaluateExpression(condition, context);
  if (typeof result === "string") {
    const lower = result.trim().toLowerCase();
    if (lower === "false") return false;
    if (lower === "true") return true;
  }
  return Boolean(result);
}

// ── Condition authoring validators (used by step validate()) ────────────

export function conditionIsNeverEvaluated(condition) {
  if (typeof condition !== "string") return false;
  if (condition === "") return false;
  const stripped = condition.trim();
  if (!stripped) return true;
  if (["true", "false"].includes(stripped.toLowerCase())) return false;
  if (!stripped.includes("{{")) return true;
  return firstUnclosableBlock(stripped) === "verbatim";
}

export function conditionHasMalformedExpressionBlock(condition) {
  if (typeof condition !== "string") return false;
  const stripped = condition.trim();
  if (!stripped || ["true", "false"].includes(stripped.toLowerCase())) return false;
  return firstUnclosableBlock(stripped) === "evaluated";
}

export function conditionIsInterpolatedToText(condition) {
  if (typeof condition !== "string") return false;
  const stripped = condition.trim();
  if (!stripped || !stripped.includes("{{")) return false;
  if (conditionIsNeverEvaluated(condition) || conditionHasMalformedExpressionBlock(condition)) {
    return false;
  }
  return !isSingleExpression(stripped);
}
