// Gate Decision Manifest Builder (ADR-391-amendment-gate-decision-context).
// A `gate` step with `context: { records: [<glob>...], since: last_approved }`
// lists the decision records the approver is asked to approve, so the
// approve/reject call can be made from the HITL message alone
// (agentic-container#19). The runtime, Gate→HITL Bridge and Slack relay only
// forward the result — all git and record parsing lives here (ADR-414/416).
//
// What counts as a change is `git diff <since>..HEAD` restricted to the
// record globs; file timestamps and a step's own claims never count. Every
// git failure degrades to "manifest unavailable" — a gate never fails or
// skips because of its context (ADR-422: gates halt, never degrade).

import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

// Control characters except tab: C0 (incl. LF), DEL, C1 (incl. CSI). Stripped
// from anything read out of a file before it is shown — a gate's show_file
// lines and every decision-record field — so file contents cannot inject
// ANSI/terminal escapes into the TTY chooser or the HITL message. Lives here
// (not gate.mjs) so both modules share it without an import cycle.
export const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

export const CONTEXT_KEYS = Object.freeze(["records", "since"]);
export const SINCE_MODES = Object.freeze(["last_approved"]);

// At most this many decisions are listed; the rest collapse into "…and N more".
export const MAX_DECISIONS = 10;

// Longest rendered field; a runaway first "sentence" must not flood Slack.
const MAX_FIELD_CHARS = 300;

// Target branches tried, in order, for the merge-base fallback of `since`.
const TARGET_BRANCHES = ["main", "origin/main", "master", "origin/master"];

const GIT_TIMEOUT_MS = 15_000;

// Validation errors for a gate's `context` block (empty when valid or absent).
export function validateGateContext(config, rid) {
  if (!("context" in config)) return [];
  const ctx = config.context;
  const errors = [];
  if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) {
    return [`Gate step ${rid}: 'context' must be a mapping with 'records' (and optional 'since').`];
  }
  for (const key of Object.keys(ctx)) {
    if (!CONTEXT_KEYS.includes(key)) {
      errors.push(`Gate step ${rid}: unknown 'context' key '${key}'. Recognized keys: ${CONTEXT_KEYS.join(", ")}.`);
    }
  }
  const records = ctx.records;
  if (!Array.isArray(records) || records.length === 0 || !records.every((r) => typeof r === "string" && r !== "")) {
    errors.push(`Gate step ${rid}: 'context.records' must be a non-empty list of glob strings.`);
  }
  if ("since" in ctx && !SINCE_MODES.includes(ctx.since)) {
    errors.push(`Gate step ${rid}: 'context.since' must be one of ${SINCE_MODES.join(", ")}, got ${JSON.stringify(ctx.since)}.`);
  }
  return errors;
}

// Build the manifest for a context gate. Never throws.
// Returns { decisions, since_sha, head_sha, no_changes, truncated_count, total, unavailable }.
export function buildGateManifest({ records, projectRoot, stepId, steps }) {
  const empty = (reason) => ({
    decisions: [],
    since_sha: null,
    head_sha: null,
    no_changes: false,
    truncated_count: 0,
    total: 0,
    unavailable: reason,
    more_link: null,
  });
  try {
    const cwd = projectRoot || ".";
    const git = (args) => runGit(cwd, args);

    const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (head === null) return empty("no git history in the project root");

    const since = resolveSince(git, stepId, steps);
    if (since === null) return empty("no base commit to compare against");

    // `:(glob)` pathspecs keep `*` within one directory level, so only
    // records matching the declared globs are ever considered. --relative
    // reports paths relative to the project root, matching the globs.
    const pathspecs = records.map((g) => `:(glob)${g}`);
    const diff = git(["diff", "--name-status", "--no-renames", "--relative", "-z", since, head, "--", ...pathspecs]);
    if (diff === null) return empty("git diff failed");

    const changed = parseNameStatus(diff);
    const linkFor = makeLinker(git);
    const all = changed.map(({ path, change }) => {
      // Content comes from the commit the diff ends at, not the working tree.
      const text = git(["show", `${head}:./${path}`]);
      return { ...parseRecord(path, text), change, path, link: linkFor(path) };
    });
    all.sort((a, b) => a.path.localeCompare(b.path));

    const decisions = all.slice(0, MAX_DECISIONS);
    return {
      decisions,
      since_sha: since,
      head_sha: head,
      no_changes: all.length === 0,
      truncated_count: all.length - decisions.length,
      total: all.length,
      unavailable: null,
      more_link: linkFor(globDir(records[0]), "tree"),
    };
  } catch {
    return empty("manifest could not be built");
  }
}

// Render the static gate message followed by the manifest. Every record
// field was sanitised at parse time; only id/title/decision/status/link
// are ever rendered.
export function renderGateMessage(message, manifest) {
  const lines = [String(message), ""];
  if (manifest.unavailable) {
    lines.push(`Decision list unavailable: ${manifest.unavailable}.`);
    return lines.join("\n");
  }
  const short = manifest.since_sha.slice(0, 7);
  if (manifest.no_changes) {
    lines.push(`No new or changed decision records since ${short}.`);
    return lines.join("\n");
  }
  const n = manifest.total;
  lines.push(`${n} ${n === 1 ? "decision" : "decisions"} to approve (new or changed since ${short}):`);
  for (const d of manifest.decisions) {
    const title = d.title && d.title !== d.id ? ` ${d.title}` : "";
    lines.push(`• ${d.id} (${d.change})${title}`);
    if (d.decision_line) lines.push(`  ${d.decision_line}`);
    lines.push(`  Status: ${d.status ?? "unknown"} · ${d.link}`);
  }
  if (manifest.truncated_count > 0) {
    lines.push(`…and ${manifest.truncated_count} more: ${manifest.more_link}`);
  }
  return lines.join("\n");
}

// ── git helpers ──────────────────────────────────────────────────────────

// Argument-array git invocation (never a shell string); stdout or null.
function runGit(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

// `since`: approved_sha of the most recently approved gate in this run (the
// current gate excluded — its own earlier pause is not an approval), else the
// merge-base of HEAD with the target branch.
function resolveSince(git, stepId, steps) {
  let approved = null;
  for (const [id, data] of Object.entries(steps ?? {})) {
    if (id === stepId) continue;
    const sha = data?.output?.approved_sha;
    if (data?.type === "gate" && typeof sha === "string" && /^[0-9a-f]{7,64}$/i.test(sha)) {
      approved = sha;
    }
  }
  if (approved !== null) {
    const resolved = git(["rev-parse", "--verify", "--quiet", `${approved}^{commit}`]);
    if (resolved !== null) return resolved;
  }
  for (const branch of TARGET_BRANCHES) {
    if (git(["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]) === null) continue;
    const base = git(["merge-base", "HEAD", branch]);
    if (base) return base;
  }
  return null;
}

function parseNameStatus(out) {
  const parts = out.split("\0").filter((p) => p !== "");
  const changed = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    const path = parts[i + 1];
    // Deleted records have nothing left to approve; renames are disabled.
    if (status === "A") changed.push({ path, change: "new" });
    else if (status === "M" || status === "T") changed.push({ path, change: "changed" });
  }
  return changed;
}

// Link to a record: the file on the pushed branch's web page when the branch
// tracks an https/ssh GitHub or GitLab remote, else the repo-relative path.
function makeLinker(git) {
  let web = null;
  const upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream && upstream.includes("/")) {
    const remote = upstream.slice(0, upstream.indexOf("/"));
    const branch = upstream.slice(upstream.indexOf("/") + 1);
    const base = webBase(git(["remote", "get-url", remote]));
    if (base) web = { base, branch, gitlab: /gitlab/i.test(base) };
  }
  return (path, kind = "blob") => {
    if (!web) return path;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const sep = web.gitlab ? "/-/" : "/";
    return `${web.base}${sep}${kind}/${encodeURIComponent(web.branch).replace(/%2F/g, "/")}/${encoded}`;
  };
}

function webBase(url) {
  if (!url) return null;
  let m = url.match(/^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) m = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `https://${m[1]}/${m[2]}`.replace(/\s+/g, "").replace(CONTROL_CHARS, "");
}

function globDir(glob) {
  const wild = glob.search(/[*?[]/);
  const prefix = wild >= 0 ? glob.slice(0, wild) : glob;
  return prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix);
}

// ── record parsing (tolerant: falls back to title + link) ─────────────────

export function parseRecord(path, text) {
  const file = basename(path);
  const stem = file.replace(/\.md$/i, "");
  const fallback = {
    id: clean(stem),
    title: clean(file),
    decision_line: null,
    status: null,
  };
  if (typeof text !== "string") return fallback;
  try {
    const { fields, body } = splitFrontmatter(text);
    const id = clean(fields.id) || fallback.id;
    const h1 = body.match(/^#[ \t]+(.+?)[ \t#]*$/m);
    const title = clean(fields.title) || clean(h1?.[1]) || fallback.title;
    const section = sectionBody(body, /^##[ \t]+Decision Outcome[ \t]*$/im) ?? sectionBody(body, /^##[ \t]+Decision[ \t]*$/im);
    return {
      id,
      title,
      decision_line: section ? clean(firstSentence(section)) || null : null,
      status: clean(fields.status) || null,
    };
  } catch {
    return fallback;
  }
}

// Minimal `key: value` frontmatter reader; an unterminated fence means there
// is no frontmatter at all.
function splitFrontmatter(text) {
  const fields = {};
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fields, body: text };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    fields[kv[1].toLowerCase()] = v;
  }
  return { fields, body: text.slice(m[0].length) };
}

// First paragraph under the heading, up to the next heading.
function sectionBody(body, headingRe) {
  const m = headingRe.exec(body);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/^#{1,6}[ \t]/m);
  const section = (next >= 0 ? rest.slice(0, next) : rest).trim();
  if (!section) return null;
  return section.split(/\r?\n[ \t]*\r?\n/)[0];
}

function firstSentence(paragraph) {
  const flat = paragraph.replace(/\s+/g, " ").trim();
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : flat;
}

function clean(value) {
  if (typeof value !== "string") return "";
  // Record fields are single-line: fold whitespace (incl. tab/LF) first, then
  // strip whatever control characters remain.
  const s = value.replace(/\s+/g, " ").replace(CONTROL_CHARS, "").trim();
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS - 1)}…` : s;
}
