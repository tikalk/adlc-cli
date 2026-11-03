// Minimal YAML frontmatter reader for SKILL.md files.
// Extracts key-value pairs from the --- delimited frontmatter block.
// Handles simple scalars, quoted strings, and multi-line folded scalars.

export function parseFrontmatter(content) {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };

  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter: null, body: content };

  const raw = content.slice(3, endIndex).trim();
  const bodyStart = endIndex + 4;
  const body = content.slice(bodyStart).replace(/^[\n\r]+/, "");

  const frontmatter = parseSimpleYaml(raw);
  return { frontmatter, body };
}

function parseSimpleYaml(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    // Folded scalar: value is empty or "|", content on subsequent indented lines
    if (value === "" || value === "|" || value === ">") {
      const folded = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].startsWith("\t") || lines[i].trim() === "")) {
        folded.push(lines[i].trim());
        i++;
      }
      result[key] = folded.join(" ").trim();
      continue;
    }

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    result[key] = value;
    i++;
  }

  return result;
}
