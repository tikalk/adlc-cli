// Shared secret redaction for text bound for logs, notifiers, persisted run
// state, or the pushed run ref (ADR-478). Extracted from steps/shell.mjs so
// the refs transport can redact without importing a step implementation.

// Secret-shaped env var names whose values never appear in outbound text.
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|JWT/i;
// Well-known token formats (GitLab, GitHub, Slack, Anthropic/OpenAI-style keys, JWTs).
const TOKEN_PATTERNS = [
  /\bglpat-[A-Za-z0-9_-]{10,}/g,
  /\bgl(?:dt|rt|cbt|ptt|ft|ffct|imt|oas|agent|soat)-[A-Za-z0-9_-]{10,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/** Mask credentials in text bound for logs, notifiers or persisted run state. */
export function redactSecrets(text, env = process.env) {
  let out = text
    // userinfo in URLs: https://user:token@host → https://***@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    // Authorization-style headers and key=value pairs: everything after the
    // separator to the end of the line is masked, keeping only a known auth
    // scheme. Multi-parameter schemes (AWS SigV4, Digest) carry credentials
    // past the first word, and over-masking an error message costs nothing.
    // A value on the next line (YAML, folded header) is masked too.
    .replace(/\b(authorization|private-token|x-api-key)([ \t]*[:=](?:[ \t]*\r?\n)?[ \t]*)((?:bearer|basic|token|bot|digest|negotiate|apikey|key)[ \t]+)?[^\s][^\r\n]*/gi, "$1$2$3***");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "***");
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    out = out.split(value).join("***");
  }
  return out;
}
