// Pure translation from a .mcp.json server spec to a target agent's MCP
// entry shape. No I/O, and ${VAR} is never resolved from the machine's
// environment — variables are rewritten into the target's syntax or the
// entry is refused when the target cannot express it.
//
// ── VarSyntax rendering (the label is not the contract; this is) ──────
//   "passthrough" — unchanged (claude-code: ${VAR} and ${VAR:-default}
//                   stay as written; the standard IS its file)
//   "env-braces"  — {env:NAME} (opencode)
//   "env-prefix"  — ${env:NAME} (cursor)
//   "env-vars"    — no string substitution at all (codex): a whole-value
//                   ${NAME} in env becomes an inherited name
//                   (env_vars = ["NAME"]), and a ${VAR} anywhere the
//                   target cannot inherit — url, args, command — is
//                   inexpressible and therefore refused.
//
// Refusal contract: describeRefusal(spec, row) is the single source of
// truth for "can this entry be fully expressed here"; translateEntry calls
// it first and returns null whenever it reports a reason. An entry is
// never half-written: what cannot be expressed is refused and explained.

const STDIO_FIELDS = ["command", "args", "env", "type", "disabled"];
const URL_FIELDS = ["type", "url", "disabled"];
const SPEC_FIELDS = ["command", "args", "env", "type", "url", "disabled"];

function varPattern() {
  return /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
}

// Every ${VAR} / ${VAR:-default} reference in one string, in order.
function findVars(value) {
  const out = [];
  for (const m of value.matchAll(varPattern())) {
    out.push({ name: m[1], hadDefault: m[2] !== undefined, ref: m[0] });
  }
  return out;
}

// The whole value is exactly one ${VAR} / ${VAR:-default}, or null.
function wholeVar(value) {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}$/.exec(value);
  return m ? { name: m[1], hadDefault: m[2] !== undefined } : null;
}

// Rewrites ${VAR} and ${VAR:-default} in one string. Internal: the entry
// builders below are its only callers. "env-vars" has no string
// substitution at all (the builders refuse vars there before reaching
// this point) and "passthrough" is a no-op.
function translateValue(value, varSyntax) {
  if (varSyntax !== "env-braces" && varSyntax !== "env-prefix") return value;
  const open = varSyntax === "env-braces" ? "{env:" : "${env:";
  return value.replace(varPattern(), (_m, name) => `${open}${name}}`);
}

function hasCommand(spec) {
  return typeof spec.command === "string" && spec.command !== "";
}

function hasUrl(spec) {
  return typeof spec.url === "string" && spec.url !== "";
}

/**
 * Human explanation for a spec the target cannot fully express, or null
 * when the spec is expressible. The reason names the first inexpressible
 * construct — the same one translateEntry refuses on.
 */
export function describeRefusal(spec, row) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return "entry is not a JSON object";
  }
  if (!row || !["claude", "opencode", "codex", "cursor"].includes(row.format)) {
    return `unknown target format "${row && row.format}"`;
  }
  if (!hasCommand(spec) && !hasUrl(spec)) {
    return "entry has neither command nor url";
  }
  // claude-code is a no-op: the standard IS its file, so whatever it
  // carries is already in the target's own vocabulary.
  if (row.format === "claude") return null;

  const isStdio = hasCommand(spec);
  if (isStdio && hasUrl(spec)) {
    return "entry has both command and url";
  }
  if (spec.args !== undefined
      && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string"))) {
    return "args must be an array of strings";
  }
  if (spec.env != null
      && (typeof spec.env !== "object" || Array.isArray(spec.env)
          || Object.values(spec.env).some((v) => typeof v !== "string"))) {
    return "env must be a map of string values";
  }

  if (isStdio) {
    if (spec.type !== undefined && spec.type !== "stdio") {
      return `type "${spec.type}" conflicts with command`;
    }
  } else {
    if (spec.type === undefined) {
      return `url entries need type "http" or "sse"`;
    }
    if (spec.type !== "http" && spec.type !== "sse") {
      return `type "${spec.type}" conflicts with url`;
    }
    // Codex url entries are streamable http; an sse server has no home.
    if (row.format === "codex" && spec.type === "sse") {
      return `sse is not expressible in ${row.format} entries`;
    }
  }

  const allowed = isStdio ? STDIO_FIELDS : URL_FIELDS;
  for (const key of Object.keys(spec)) {
    if (allowed.includes(key)) continue;
    if (SPEC_FIELDS.includes(key)) {
      return `field "${key}" does not belong in a ${isStdio ? "command-based" : "url-based"} entry`;
    }
    return `field "${key}" has no equivalent in ${row.format} entries`;
  }

  // disabled is expressible only where an off switch exists. claude-code
  // has none either, but its no-op path already returned above.
  if (spec.disabled && !row.has_off_switch) {
    return `${row.format} has no way to disable a server (no off switch)`;
  }

  // env-vars targets do no substitution: a var anywhere outside a
  // whole-value env entry cannot be delivered.
  if (row.var_syntax === "env-vars") {
    const strings = [["command", spec.command], ["url", spec.url]];
    if (Array.isArray(spec.args)) {
      for (const arg of spec.args) strings.push(["args", arg]);
    }
    for (const [field, value] of strings) {
      if (typeof value !== "string") continue;
      const found = findVars(value);
      if (found.length > 0) {
        return `${found[0].ref} in ${field} cannot be expressed: ${row.format} does no variable substitution`;
      }
    }
    if (spec.env != null) {
      for (const [key, value] of Object.entries(spec.env)) {
        if (typeof value !== "string") continue;
        if (findVars(value).length > 0 && wholeVar(value) === null) {
          return `${key} in env is not one whole \${VAR}: ${row.format} inherits whole variable names only`;
        }
      }
    }
  }

  return null;
}

/**
 * The target-shaped entry for a .mcp.json server spec, or null when the
 * entry cannot be fully expressed in the target (see describeRefusal).
 */
export function translateEntry(spec, row) {
  if (describeRefusal(spec, row) !== null) return null;
  if (row.format === "claude") return structuredClone(spec);
  const enabled = !spec.disabled;
  if (row.format === "opencode") return toOpenCode(spec, enabled);
  if (row.format === "cursor") return toCursor(spec);
  return toCodex(spec, enabled);
}

// opencode: command+args become one array, env becomes environment.
function toOpenCode(spec, enabled) {
  if (!hasCommand(spec)) {
    return { type: "remote", enabled, url: translateValue(spec.url, "env-braces") };
  }
  const command = [spec.command, ...(spec.args ?? [])]
    .map((v) => translateValue(v, "env-braces"));
  const entry = { type: "local", enabled, command };
  if (spec.env != null) entry.environment = mapEnv(spec.env, "env-braces");
  return entry;
}

// cursor: command and args stay separate, stdio entries get type:"stdio".
function toCursor(spec) {
  if (!hasCommand(spec)) {
    return { type: spec.type, url: translateValue(spec.url, "env-prefix") };
  }
  const entry = { type: "stdio", command: translateValue(spec.command, "env-prefix") };
  if (spec.args !== undefined) entry.args = spec.args.map((a) => translateValue(a, "env-prefix"));
  if (spec.env != null) entry.env = mapEnv(spec.env, "env-prefix");
  return entry;
}

// codex: no substitution at all. Plain strings pass through; a whole-value
// ${NAME} in env becomes an inherited name; anything else with a var was
// refused by describeRefusal.
function toCodex(spec, enabled) {
  if (!hasCommand(spec)) {
    return { url: spec.url, enabled };
  }
  const entry = { command: spec.command, enabled };
  if (spec.args !== undefined) entry.args = [...spec.args];
  if (spec.env != null) {
    const env = {};
    const env_vars = [];
    for (const [key, value] of Object.entries(spec.env)) {
      const whole = wholeVar(value);
      if (whole) env_vars.push(whole.name);
      else env[key] = value;
    }
    if (Object.keys(env).length > 0) entry.env = env;
    if (env_vars.length > 0) entry.env_vars = env_vars;
  }
  return entry;
}

function mapEnv(env, varSyntax) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = translateValue(value, varSyntax);
  }
  return out;
}

/**
 * The format-agnostic field map that disables a server in this target,
 * or null when the target has no off switch. The caller serialises it per
 * target (JSON object or TOML fragment).
 */
export function offSwitchEntry(row) {
  return row.has_off_switch ? { enabled: false } : null;
}

/**
 * The variables a spec references — the "set these env vars" report.
 * Names appear in first-reference order across command, args, url and
 * env values. droppedDefaults lists those whose ${VAR:-default} fallback
 * cannot survive translation into targets without default support, so
 * they must be set explicitly.
 */
export function expressibleVars(spec) {
  const needed = [];
  const droppedDefaults = [];
  const seen = new Set();
  const scan = (value) => {
    if (typeof value !== "string") return;
    for (const v of findVars(value)) {
      if (!seen.has(v.name)) {
        seen.add(v.name);
        needed.push(v.name);
      }
      if (v.hadDefault && !droppedDefaults.includes(v.name)) {
        droppedDefaults.push(v.name);
      }
    }
  };
  if (spec && typeof spec === "object") {
    for (const value of Object.values(spec)) {
      if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === "object") Object.values(value).forEach(scan);
      else scan(value);
    }
  }
  return { needed, droppedDefaults };
}
