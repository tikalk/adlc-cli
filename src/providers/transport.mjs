import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Provider transport interface: workspace validation, var expansion, events, hop guard.
export const MAX_HOPS = 2;

// Workspace names become remote resource names and local handle filenames.
// Normalize to a safe charset so a name can never escape the workspaces dir
// and always satisfies provider naming rules (lowercase, digits, dashes).
export function normalizeWorkspaceName(name) {
  const raw = String(name ?? "").trim();
  if (!raw) throw new Error("workspace name is required");
  if (raw.includes("${")) {
    // An unresolved placeholder is never a name: normalizing it would
    // silently produce a different workspace than the operator asked for.
    throw new Error(
      `workspace name ${JSON.stringify(raw)} still contains an unresolved variable — ` +
        "set it in the environment (a secret-sourced variable cannot name a workspace)"
    );
  }
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error(`workspace name ${JSON.stringify(raw)} has no usable characters`);
  }
  return normalized;
}

export function validateWorkspaceConfig(config) {
  // The rule is "no provider key anywhere": a nested `provider:` would be
  // read as a location by some consumers and silently ignored by others.
  const findProviderKey = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (findProviderKey(item)) return true;
      }
      return false;
    }
    if (value && typeof value === "object") {
      if ("provider" in value) return true;
      return Object.values(value).some((v) => findProviderKey(v));
    }
    return false;
  };
  if (config && typeof config === "object" && findProviderKey(config)) {
    throw new Error(
      'workspace config "provider" key is not allowed: workspace files are location-free; select the provider via --provider flag'
    );
  }
  return config;
}

// Expand ${VAR} in the RAW workspace file text. Used when the file must be
// materialized on a remote host: the remote receives text, not a parsed
// object, so the substitution happens here — with the same fail-fast rules
// and the same "a secret-sourced var keeps its placeholder" rule.
export function expandWorkspaceText(text, env = {}) {
  return String(text ?? "").replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    const v = env[name] ?? process.env[name];
    if (v === undefined || v === "") {
      throw new Error(`Missing required workspace variable: ${name}`);
    }
    return v;
  });
}

export function expandWorkspaceVars(value, env = {}) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      const v = env[name] ?? process.env[name];
      // An unset OR empty value is missing: silently substituting "" would
      // turn a typo into a broken workspace instead of a named failure.
      if (v === undefined || v === "") {
        throw new Error(`Missing required workspace variable: ${name}`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandWorkspaceVars(v, env));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandWorkspaceVars(v, env);
    }
    return out;
  }
  return value;
}

export function normalizeEvent(event) {
  if (!event || typeof event !== "object") return event;
  const { ts, timestamp, time, ...rest } = event;
  return rest;
}

export function checkHopDepth(depth) {
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth < 0) {
    throw new Error(`hop depth ${depth} is invalid (must be a non-negative number)`);
  }
  if (depth > MAX_HOPS) {
    throw new Error(`hop depth ${depth} exceeds maximum of ${MAX_HOPS} hops`);
  }
}

const SECRET_KEY_PATTERN = /token|secret|passwd|password|pwd|api[_-]?key|private[_-]?key|auth[_-]?token|bearer|credential|(^|[^a-z])tok([^a-z]|$)/i;

export const REDACTED = "[REDACTED]";

export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redactSecrets(v);
    }
    return out;
  }
  return value;
}

const VAR_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function collectReferencedVars(value) {
  const refs = [];
  const seen = new Set();
  const visit = (v) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(VAR_REF_PATTERN)) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          refs.push(m[1]);
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return refs;
}

export function expandWorkspaceVarsWithRefs(value, env = {}) {
  return { expanded: expandWorkspaceVars(value, env), referenced: collectReferencedVars(value) };
}

export function currentHopDepth() {
  const raw = process.env.ADLC_HOP_DEPTH;
  if (raw === undefined || raw === "") return 0;
  if (raw.trim() === "") {
    throw new Error(`invalid ADLC_HOP_DEPTH ${JSON.stringify(raw)}: must be numeric (fail-closed)`);
  }
  const depth = Number(raw.trim());
  if (!Number.isFinite(depth)) {
    throw new Error(`invalid ADLC_HOP_DEPTH ${JSON.stringify(raw)}: must be numeric (fail-closed)`);
  }
  if (depth < 0) {
    throw new Error(`invalid ADLC_HOP_DEPTH ${JSON.stringify(raw)}: must be non-negative (fail-closed)`);
  }
  return depth;
}

export function hopGuard() {
  checkHopDepth(currentHopDepth() + 1);
}

export function remoteInputs(inputs = {}) {
  return { ...inputs, ADLC_HOP_DEPTH: String(currentHopDepth() + 1) };
}

function parseSecretsEnv(content) {
  const out = {};
  for (const line of String(content ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadSecretsEnv(projectRoot = process.cwd()) {
  const fileSecrets = {};
  try {
    const file = join(projectRoot, "secrets.env");
    if (existsSync(file)) Object.assign(fileSecrets, parseSecretsEnv(readFileSync(file, "utf-8")));
  } catch {
  }
  const dockerSecrets = {};
  try {
    const dir = "/run/secrets";
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        try {
          dockerSecrets[name] = readFileSync(join(dir, name), "utf-8").trim();
        } catch {
        }
      }
    }
  } catch {
  }
  return { ...fileSecrets, ...dockerSecrets };
}

export function referencedSecretsEnv(referenced = [], projectRoot = process.cwd(), env = process.env) {
  const merged = { ...env, ...loadSecretsEnv(projectRoot) };
  const out = {};
  for (const k of referenced ?? []) if (merged[k] !== undefined) out[k] = merged[k];
  return out;
}

// The expansion environment for a workspace file. Values sourced from a
// secrets file (secrets.env / docker secrets) are secret by definition: they
// are NOT substituted into the config — the placeholder is kept so the value
// travels only in the transport's vars channel, never inlined into a
// non-secret field. Process-env values are not secret-sourced and expand in
// place (e.g. name: ${WORKSPACE_NAME}).
export function expansionEnv(projectRoot = process.cwd(), env = process.env) {
  const secretSourced = loadSecretsEnv(projectRoot);
  const out = { ...env };
  for (const key of Object.keys(secretSourced)) out[key] = `\${${key}}`;
  // A secret-SHAPED name is a secret wherever it came from: a token in the
  // process env is as secret as one in secrets.env, and it must not be
  // inlined into the config that travels to the remote.
  for (const key of Object.keys(env)) {
    if (SECRET_KEY_PATTERN.test(key)) out[key] = `\${${key}}`;
  }
  return out;
}

export function scrubSecretValues(value, secrets = {}) {
  const raw = Array.isArray(secrets) ? secrets : Object.values(secrets ?? {});
  const needles = [...new Set(raw)].filter((s) => typeof s === "string" && s.length >= 3);
  if (needles.length === 0) return value;
  const scrubStr = (s) => needles.reduce((acc, n) => acc.split(n).join(REDACTED), s);
  if (typeof value === "string") return scrubStr(value);
  if (Array.isArray(value)) return value.map((v) => scrubSecretValues(v, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecretValues(v, secrets);
    return out;
  }
  return value;
}

export async function resumeRun(transport, handle, input, opts = {}) {
  const fromOffset = opts.fromOffset ?? opts.offset ?? 0;
  try {
    return await transport.exec(handle, input, { offset: fromOffset });
  } catch (err) {
    return await transport.exec(handle, input, { offset: err?.offset ?? fromOffset });
  }
}

export const replayStream = resumeRun;
