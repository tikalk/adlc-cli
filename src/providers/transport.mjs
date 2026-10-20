// Provider transport interface: workspace validation, var expansion, events, hop guard.
export const MAX_HOPS = 2;

export function validateWorkspaceConfig(config) {
  if (config && typeof config === "object" && "provider" in config) {
    throw new Error(
      'workspace config "provider" key is not allowed: workspace files are location-free; select the provider via --provider flag'
    );
  }
  return config;
}

export function expandWorkspaceVars(value, env = {}) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      const v = env[name] ?? process.env[name];
      if (v === undefined) {
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
  if (typeof depth !== "number" || depth > MAX_HOPS) {
    throw new Error(`hop depth ${depth} exceeds maximum of ${MAX_HOPS} hops`);
  }
}

const SECRET_KEY_PATTERN = /token|secret|passwd|password|pwd|api[_-]?key|private[_-]?key|auth[_-]?token|bearer|credential/i;

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

export async function resumeRun(transport, handle, input, opts = {}) {
  const fromOffset = opts.fromOffset ?? opts.offset ?? 0;
  try {
    return await transport.exec(handle, input, { offset: fromOffset });
  } catch (err) {
    return await transport.exec(handle, input, { offset: err?.offset ?? fromOffset });
  }
}

export const replayStream = resumeRun;
