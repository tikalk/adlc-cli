// Workflow-grade YAML subset parser for factory workflow/definition files.
// Ported from PyYAML's feature surface as used by upstream spec-kit workflows:
// block mappings, block sequences (incl. "- key: value" inline starts),
// flow sequences [a, b], flow mappings {k: v}, quoted scalars (with escapes),
// plain scalars (bool/number/null/string), block scalars (|, |-, >, >-),
// comments, and an optional leading "---" document marker.
// Zero dependencies (same constraint as the rest of adlc-cli).

// ── Flow-style (inline) parsing ─────────────────────────────────────────

function parseFlow(text) {
  const parser = new FlowParser(text);
  const value = parser.parseValue();
  parser.skipWs();
  if (parser.pos < parser.text.length) {
    throw new Error(`YAML flow parse error: unexpected trailing content at '${parser.text.slice(parser.pos)}'`);
  }
  return value;
}

class FlowParser {
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  skipWs() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  parseValue() {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === undefined) return null;
    if (ch === "[") return this.parseFlowSeq();
    if (ch === "{") return this.parseFlowMap();
    if (ch === '"' || ch === "'") return this.parseQuoted();
    return this.parseFlowScalar();
  }

  parseFlowSeq() {
    this.pos++; // consume [
    const items = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return items;
    }
    while (true) {
      items.push(this.parseValue());
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === ",") {
        this.pos++;
        continue;
      }
      if (ch === "]") {
        this.pos++;
        return items;
      }
      throw new Error(`YAML flow sequence parse error: expected ',' or ']' at position ${this.pos}`);
    }
  }

  parseFlowMap() {
    this.pos++; // consume {
    const map = {};
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return map;
    }
    while (true) {
      this.skipWs();
      // Key: quoted or plain scalar terminated by ':'
      let key;
      const ch = this.text[this.pos];
      if (ch === '"' || ch === "'") {
        key = this.parseQuoted();
      } else {
        const start = this.pos;
        while (this.pos < this.text.length && this.text[this.pos] !== ":" && !/[\],}]/.test(this.text[this.pos])) this.pos++;
        key = this.text.slice(start, this.pos).trim();
      }
      this.skipWs();
      if (this.text[this.pos] !== ":") {
        throw new Error(`YAML flow mapping parse error: expected ':' at position ${this.pos}`);
      }
      this.pos++; // consume :
      const value = this.parseValue();
      map[key] = value;
      this.skipWs();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos++;
        continue;
      }
      if (next === "}") {
        this.pos++;
        return map;
      }
      throw new Error(`YAML flow mapping parse error: expected ',' or '}' at position ${this.pos}`);
    }
  }

  parseQuoted() {
    const quote = this.text[this.pos];
    this.pos++;
    let out = "";
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (quote === '"' && ch === "\\") {
        this.pos++;
        const esc = this.text[this.pos];
        const escapes = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "0": "\0" };
        out += escapes[esc] !== undefined ? escapes[esc] : esc;
        this.pos++;
        continue;
      }
      if (quote === "'" && ch === "'" && this.text[this.pos + 1] === "'") {
        out += "'";
        this.pos += 2;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return out;
      }
      out += ch;
      this.pos++;
    }
    throw new Error("YAML parse error: unterminated quoted string");
  }

  parseFlowScalar() {
    const start = this.pos;
    while (this.pos < this.text.length && !/[\],}]/.test(this.text[this.pos])) this.pos++;
    const raw = this.text.slice(start, this.pos).trim();
    // Allow a trailing comment inside flow style after whitespace
    const hashIdx = findCommentIndex(raw);
    const text = hashIdx === -1 ? raw : raw.slice(0, hashIdx).trim();
    return parseScalarToken(text);
  }
}

// ── Scalar interpretation ───────────────────────────────────────────────

function findCommentIndex(value) {
  // A "#" starts a comment only when preceded by whitespace or at the start.
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "#" && (i === 0 || /\s/.test(value[i - 1]))) return i;
  }
  return -1;
}

function parseScalarToken(value) {
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(value) && /[.eE]/.test(value)) {
    return parseFloat(value);
  }
  if (/^[+-]?(\.inf|\.Inf|\.INF)$/.test(value)) return value.endsWith("-") || value.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?(\.nan|\.NaN|\.NAN)$/.test(value)) return NaN;
  return value;
}

function stripInlineComment(value) {
  const hashIdx = findCommentIndex(value);
  return hashIdx === -1 ? value : value.slice(0, hashIdx).trimEnd();
}

// ── Block-style parsing ─────────────────────────────────────────────────

export function parseYaml(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (const raw of rawLines) {
    // Skip document markers
    if (/^---\s*$/.test(raw)) continue;
    if (/^\.\.\.\s*$/.test(raw)) break;
    const indentMatch = raw.match(/^ */);
    const indent = indentMatch[0].length;
    const content = raw.trim();
    if (content === "" || content.startsWith("#")) continue;
    lines.push({ indent, content });
  }
  if (lines.length === 0) return null;
  let pos = 0;
  const result = parseBlock(lines[0].indent);
  return result;

  function parseBlock(indent) {
    const line = lines[pos];
    if (!line) return null;
    if (line.content === "-" || line.content.startsWith("- ")) return parseList(indent);
    return parseMapping(indent);
  }

  function parseMapping(indent) {
    const result = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent !== indent) break;
      if (line.content === "-" || line.content.startsWith("- ")) break;

      const { key, value } = splitMapEntry(line.content);
      if (key === null) {
        pos++;
        continue;
      }
      pos++;

      if (value === "" || /^\|[-+]?$/.test(value) || /^>[-+]?$/.test(value)) {
        const blockScalar = /^\|/.test(value) ? "|" : value === "" ? null : ">";
        const chomp = value.includes("-") ? "-" : "";
        if (blockScalar) {
          result[key] = parseBlockScalar(indent, blockScalar, chomp);
        } else if (pos < lines.length && lines[pos].indent > indent) {
          result[key] = parseBlock(lines[pos].indent);
        } else {
          result[key] = null;
        }
      } else if (value === "[]" ) {
        result[key] = [];
      } else if (value === "{}") {
        result[key] = {};
      } else if (value.startsWith("[") || value.startsWith("{")) {
        result[key] = parseFlow(value);
      } else if ((value.startsWith('"') || value.startsWith("'")) && isFullyQuoted(value)) {
        result[key] = unquoteBlockScalarString(value);
      } else {
        result[key] = parseScalarToken(stripInlineComment(value));
      }
    }
    return result;
  }

  function parseList(indent) {
    const result = [];
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent !== indent) break;
      if (line.content !== "-" && !line.content.startsWith("- ")) break;

      const rest = line.content.replace(/^-\s?/, "");
      if (rest === "") {
        pos++;
        if (pos < lines.length && lines[pos].indent > indent) {
          result.push(parseBlock(lines[pos].indent));
        } else {
          result.push(null);
        }
        continue;
      }

      // Inline mapping item: "- key: value" — reparse continuation lines as mapping.
      const entry = splitMapEntry(rest);
      if (entry.key !== null) {
        const itemIndent = indent + 2;
        lines[pos] = { indent: itemIndent, content: rest };
        const item = parseMapping(itemIndent);
        result.push(item);
        continue;
      }

      if (rest.startsWith("[") || rest.startsWith("{")) {
        result.push(parseFlow(rest));
        pos++;
        continue;
      }
      if ((rest.startsWith('"') || rest.startsWith("'")) && isFullyQuoted(rest)) {
        result.push(unquoteBlockScalarString(rest));
        pos++;
        continue;
      }
      result.push(parseScalarToken(stripInlineComment(rest)));
      pos++;
    }
    return result;
  }

  function parseBlockScalar(indent, style, chomp) {
    const parts = [];
    while (pos < lines.length && lines[pos].indent > indent) {
      parts.push(lines[pos].content);
      pos++;
    }
    if (chomp === "-") return parts.join(style === "|" ? "\n" : " ");
    const joined = parts.join(style === "|" ? "\n" : " ");
    return parts.length === 0 ? "" : joined + "\n";
  }

  function splitMapEntry(content) {
    // Find the ':' that terminates the key, respecting quotes.
    let quote = null;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ":") {
        // Key terminator: ':' at end-of-line or followed by whitespace.
        if (i === content.length - 1 || /\s/.test(content[i + 1])) {
          let key = content.slice(0, i).trim();
          const value = content.slice(i + 1).trim();
          if ((key.startsWith('"') && key.endsWith('"') && key.length >= 2) ||
              (key.startsWith("'") && key.endsWith("'") && key.length >= 2)) {
            key = key.slice(1, -1);
          }
          return { key, value };
        }
      }
    }
    return { key: null, value: null };
  }
}

function isFullyQuoted(value) {
  const q = value[0];
  // Cheap check: starts and ends with the same quote char. Escapes are handled
  // by unquoteBlockScalarString; a raw parse fails loudly there if unbalanced.
  return (q === '"' || q === "'") && value[value.length - 1] === q && value.length >= 2;
}

function unquoteBlockScalarString(value) {
  const parser = new FlowParser(value);
  return parser.parseQuoted();
}
