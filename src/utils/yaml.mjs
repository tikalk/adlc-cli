// Minimal YAML parser for workspace files (.adlc/workspace.yml).
// Supports: nested mappings, lists (scalar + mapping items), quoted strings,
// booleans, numbers, null, folded block scalars ("|" / ">").
// Zero dependencies — same constraint as frontmatter.mjs.

const MAPPING_LINE_RE = /^([^:#]+?)\s*:\s*(.*)$/;
const KEY_FIRST_RE = /^[\w.-]+:(\s|$)/;

export function parseYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw) => {
      const indent = raw.match(/^ */)[0].length;
      return { indent, content: raw.trim() };
    })
    .filter((l) => l.content !== "" && !l.content.startsWith("#"));

  let pos = 0;

  function parseBlock(indent) {
    const line = lines[pos];
    if (!line) return null;
    if (line.content === "-" || line.content.startsWith("- ")) {
      return parseList(indent);
    }
    return parseMapping(indent);
  }

  function parseMapping(indent) {
    const result = {};
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.indent < indent) break;
      if (line.indent > indent) break;
      if (line.content === "-" || line.content.startsWith("- ")) break;

      const match = line.content.match(MAPPING_LINE_RE);
      if (!match) {
        pos++;
        continue;
      }

      const key = match[1].trim();
      const value = match[2].trim();
      pos++;

      // Block-scalar header ("|" / ">") with optional chomping flag and
      // optional trailing comment ("goal: | # keep newlines").
      const blockHeader = value.match(/^([|>])([+-]?)\s*(#.*)?$/);
      // A value that is only a comment ("workspace: # block") behaves like an
      // empty value: nested block below, or null when nothing follows.
      const isEmpty = value === "" || /^#.*$/.test(value);
      if (isEmpty || blockHeader) {
        const folded = !!blockHeader;
        if (pos < lines.length && lines[pos].indent > indent) {
          // An explicit "|" / ">" header is always a scalar — even when the
          // content looks like a mapping ("key: value" inside a goal).
          if (folded) {
            result[key] = parseFolded(indent, blockHeader[1] === "|");
          } else {
            result[key] = parseBlock(lines[pos].indent);
          }
        } else {
          result[key] = folded ? "" : null;
        }
      } else {
        result[key] = parseScalar(value);
      }
    }
    return result;
  }

  function parseFolded(indent, keepNewlines) {
    const parts = [];
    while (pos < lines.length && lines[pos].indent > indent) {
      parts.push(lines[pos].content);
      pos++;
    }
    return parts.join(keepNewlines ? "\n" : " ").trim();
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

      if (KEY_FIRST_RE.test(rest)) {
        // Inline mapping item: "- key: value" — reparse as mapping at item indent.
        const itemIndent =
          pos + 1 < lines.length && lines[pos + 1].indent > indent && !lines[pos + 1].content.startsWith("- ")
            ? lines[pos + 1].indent
            : indent + 2;
        lines[pos] = { indent: itemIndent, content: rest };
        result.push(parseMapping(itemIndent));
        continue;
      }

      result.push(parseScalar(rest));
      pos++;
    }
    return result;
  }

  function parseScalar(value) {
    // Quoted value with an optional trailing comment ('"1.0" # version'):
    // the comment is outside the quotes, so return the inner string.
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const close = value.indexOf(quote, 1);
      if (close !== -1) {
        const rest = value.slice(close + 1);
        if (rest.trim() === "" || /^\s+#/.test(rest)) {
          return value.slice(1, close);
        }
      }
    }
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    // Strip trailing comments (" # ...") only when the value is not quoted.
    // A "#" without preceding whitespace (e.g. git+https://...#v6.4.1) is kept.
    if (!isQuoted) value = value.replace(/\s+#.*$/, "");
    if (isQuoted) {
      return value.slice(1, -1);
    }
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null" || value === "~") return null;
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
    return value;
  }

  if (lines.length === 0) return null;
  const result = parseBlock(lines[0].indent);
  return result;
}
