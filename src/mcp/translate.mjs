// Pure translation from a .mcp.json server spec to a target agent's MCP
// entry shape. No I/O, and ${VAR} is never resolved from the machine's
// environment — variables are rewritten into the target's syntax or the
// entry is refused when the target cannot express it.
//
// ── Two independent axes ──────────────────────────────────────────────
// Variable substitution is driven by row.var_syntax (what the target
// understands); entry shape is driven by row.format (how the target writes
// entries). The registry pairs them today, but nothing here assumes a
// pair: a codex-shaped row that understands {env:NAME} renders it, an
// opencode-shaped row with no substitution refuses what it cannot inherit.
//
// ── VarSyntax rendering (the label is not the contract; this is) ──────
//   "passthrough" — unchanged (claude-code: ${VAR} and ${VAR:-default}
//                   stay as written; the standard IS its file)
//   "env-braces"  — {env:NAME} (opencode)
//   "env-prefix"  — ${env:NAME} (cursor)
//   "env-vars"    — no string substitution at all (codex): a whole-value
//                   ${NAME} in env under its own name becomes an inherited
//                   name (env_vars = ["NAME"]); a header value may inherit
//                   under any name, and an Authorization of exactly
//                   "Bearer ${NAME}" becomes bearer_token_env_var; a var
//                   anywhere else — or carrying a default — is
//                   inexpressible and therefore refused.
//
// Refusal contract: describeRefusal(spec, row) is the single source of
// truth for "can this entry be fully expressed here"; translateEntry calls
// it first and returns null whenever it reports a reason. An entry is
// never half-written: what cannot be expressed is refused and explained.

const STDIO_FIELDS = ["command", "args", "env", "type", "disabled"];
const URL_FIELDS = ["type", "url", "headers", "disabled"];
const SPEC_FIELDS = ["command", "args", "env", "type", "url", "headers", "disabled"];

// Entry shapes, keyed on row.format. `inherit` names the fields that carry
// inherited variable names under the "env-vars" syntax — the syntax
// decides that a name is inherited, the shape decides where it goes.
const SHAPES = {
  claude: { build: buildClaude, inherit: null },
  opencode: { build: buildOpenCode, inherit: null },
  cursor: { build: buildCursor, inherit: null },
  codex: {
    build: buildCodex,
    inherit: { env: "env_vars", headers: "env_http_headers", bearer: "bearer_token_env_var" },
  },
};

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
  return m ? { name: m[1], hadDefault: m[2] !== undefined, ref: m[0] } : null;
}

// The whole value is exactly "Bearer ${VAR}", or null.
function bearerVar(value) {
  const m = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  return m ? m[1] : null;
}

// Rewrites ${VAR} and ${VAR:-default} in one string, per the row's
// variable syntax. Internal: the builders below are its only callers.
// "passthrough" and "env-vars" rewrite nothing — passthrough because the
// target substitutes itself, env-vars because describeRefusal has already
// routed or refused every reference before rendering.
function translateValue(value, varSyntax) {
  if (varSyntax !== "env-braces" && varSyntax !== "env-prefix") return value;
  const open = varSyntax === "env-braces" ? "{env:" : "${env:";
  return value.replace(varPattern(), (_m, name) => `${open}${name}}`);
}

function mapValues(map, varSyntax) {
  const out = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = translateValue(value, varSyntax);
  }
  return out;
}

function mapStrings(value, varSyntax) {
  if (typeof value === "string") return translateValue(value, varSyntax);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, varSyntax));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = mapStrings(v, varSyntax);
    return out;
  }
  return value;
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
  if (!row || !Object.hasOwn(SHAPES, row.format)) {
    return `unknown target format "${row && row.format}"`;
  }
  if (!hasCommand(spec) && !hasUrl(spec)) {
    return "entry has neither command nor url";
  }

  // disabled is expressible only where the target has an off switch.
  // claude-code has none either: `disabled` has no effect in .mcp.json and
  // deleting the entry is the only real off switch (registry, settled
  // decision 3) — refused exactly as for cursor, and the engine omits it.
  if (spec.disabled && !row.has_off_switch) {
    return `disabled is not expressible in ${row.target_files[0]}: deleting the entry is the only real off switch`;
  }

  // The "env-vars" syntax substitutes nothing: every reference must land
  // in an inherited-name channel of the target's shape or be refused.
  // Keyed on the variable syntax — this runs for every format.
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
        const vars = findVars(value);
        if (vars.length === 0) continue;
        const defaulted = vars.find((v) => v.hadDefault);
        if (defaulted) {
          return `${key} in env carries ${defaulted.ref}: ${row.format} inherits names but has no default syntax`;
        }
        const whole = wholeVar(value);
        if (!whole) {
          return `${key} in env is not one whole \${VAR}: ${row.format} inherits whole variable names only`;
        }
        // Inherited names keep their key: env_vars is a name list, so a
        // rename would silently deliver the wrong variable.
        if (whole.name !== key) {
          return `${key} in env renames ${whole.ref}: ${row.format} inherits names unchanged and would set ${whole.name}, not ${key}`;
        }
        if (!SHAPES[row.format].inherit?.env) {
          return `${key} in env cannot be inherited: ${row.format} has no inherited-name field`;
        }
      }
    }
    if (spec.headers != null) {
      for (const [name, value] of Object.entries(spec.headers)) {
        if (typeof value !== "string") continue;
        const vars = findVars(value);
        if (vars.length === 0) continue;
        const defaulted = vars.find((v) => v.hadDefault);
        if (defaulted) {
          return `${name} in headers carries ${defaulted.ref}: ${row.format} inherits names but has no default syntax`;
        }
        const whole = wholeVar(value);
        if (whole) {
          // Header maps name -> variable, so any name may be inherited.
          if (!SHAPES[row.format].inherit?.headers) {
            return `${name} in headers cannot be inherited: ${row.format} has no inherited-header field`;
          }
          continue;
        }
        const bearer = bearerVar(value);
        if (bearer && name.toLowerCase() === "authorization") {
          if (!SHAPES[row.format].inherit?.bearer) {
            return `${name} in headers cannot be inherited: ${row.format} has no bearer-token field`;
          }
          continue;
        }
        return `${name} in headers is not one whole \${VAR}: ${row.format} inherits whole header values only`;
      }
    }
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
  if (spec.headers != null
      && (typeof spec.headers !== "object" || Array.isArray(spec.headers)
          || Object.values(spec.headers).some((v) => typeof v !== "string"))) {
    return "headers must be a map of string values";
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
  }

  const allowed = isStdio ? STDIO_FIELDS : URL_FIELDS;
  for (const key of Object.keys(spec)) {
    if (allowed.includes(key)) continue;
    if (SPEC_FIELDS.includes(key)) {
      return `field "${key}" does not belong in a ${isStdio ? "command-based" : "url-based"} entry for ${row.format}`;
    }
    return `field "${key}" has no equivalent in ${row.format} entries`;
  }

  return null;
}

/**
 * The target-shaped entry for a .mcp.json server spec, or null when the
 * entry cannot be fully expressed in the target (see describeRefusal).
 */
export function translateEntry(spec, row) {
  if (describeRefusal(spec, row) !== null) return null;
  return SHAPES[row.format].build(spec, row);
}

// claude-code: the standard IS its file — the shape is the spec itself,
// with strings rendered in the row's variable syntax (identity for the
// real row's "passthrough").
function buildClaude(spec, row) {
  return mapStrings(spec, row.var_syntax);
}

// opencode: command+args become one array, env becomes environment.
function buildOpenCode(spec, row) {
  const v = row.var_syntax;
  const enabled = !spec.disabled;
  if (!hasCommand(spec)) {
    const entry = { type: "remote", enabled, url: translateValue(spec.url, v) };
    if (spec.headers != null) entry.headers = mapValues(spec.headers, v);
    return entry;
  }
  const entry = {
    type: "local",
    enabled,
    command: [spec.command, ...(spec.args ?? [])].map((s) => translateValue(s, v)),
  };
  if (spec.env != null) entry.environment = mapValues(spec.env, v);
  return entry;
}

// cursor: command and args stay separate, stdio entries get type:"stdio".
function buildCursor(spec, row) {
  const v = row.var_syntax;
  if (!hasCommand(spec)) {
    const entry = { type: spec.type, url: translateValue(spec.url, v) };
    if (spec.headers != null) entry.headers = mapValues(spec.headers, v);
    return entry;
  }
  const entry = { type: "stdio", command: translateValue(spec.command, v) };
  if (spec.args !== undefined) entry.args = spec.args.map((a) => translateValue(a, v));
  if (spec.env != null) entry.env = mapValues(spec.env, v);
  return entry;
}

// codex: shape fields per the design's mapping table. Under "env-vars"
// nothing is substituted — whole-value vars become inherited names in the
// shape's inherit fields (env_vars, env_http_headers,
// bearer_token_env_var); describeRefusal has already refused everything
// else. Under any other syntax values are rendered like everywhere else.
function buildCodex(spec, row) {
  const v = row.var_syntax;
  const enabled = !spec.disabled;
  if (!hasCommand(spec)) {
    const entry = { url: translateValue(spec.url, v), enabled };
    if (spec.headers != null) {
      for (const [name, value] of Object.entries(spec.headers)) {
        const whole = v === "env-vars" ? wholeVar(value) : null;
        const bearer = v === "env-vars" ? bearerVar(value) : null;
        if (whole) (entry.env_http_headers ??= {})[name] = whole.name;
        else if (bearer && name.toLowerCase() === "authorization") entry.bearer_token_env_var = bearer;
        else (entry.http_headers ??= {})[name] = translateValue(value, v);
      }
    }
    return entry;
  }
  const entry = { command: translateValue(spec.command, v), enabled };
  if (spec.args !== undefined) entry.args = spec.args.map((a) => translateValue(a, v));
  if (spec.env != null) {
    for (const [key, value] of Object.entries(spec.env)) {
      const whole = v === "env-vars" ? wholeVar(value) : null;
      if (whole) (entry.env_vars ??= []).push(whole.name);
      else (entry.env ??= {})[key] = translateValue(value, v);
    }
  }
  return entry;
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
