// Factory board — pane of glass v1 (ADR-476) over local run dirs and remote
// refs/factory-runs/* (ADR-475/490). The index is derived and disposable:
// computed fresh on every invocation, nothing persisted (ADR-325 stateless
// aggregation; ADR-490 keeps refs authoritative and the index replaceable).
//
// Remote reads fetch into refs/remotes/<remote>/factory-runs/* — never the
// local refs/factory-runs/* a live machine may be pushing. Depth-1 + prune
// keeps the fetch light and drops refs deleted on the remote.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkRemote } from "./refs.mjs";

const RUNS_DIR = ".adlc/workflows/runs";
const RUN_REF_PREFIX = "refs/factory-runs/";
const REMOTE_REF_PREFIX = "refs/remotes/";

function git(projectRoot, args) {
  return spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitText(projectRoot, args) {
  const r = git(projectRoot, args);
  if (r.error || r.status !== 0) return null;
  return String(r.stdout ?? "");
}

// ── local source ──────────────────────────────────────────────────────────

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function localRuns(projectRoot) {
  const runsDir = join(projectRoot, RUNS_DIR);
  const rows = [];
  if (!existsSync(runsDir)) return rows;
  for (const entry of readdirSync(runsDir).sort()) {
    const runDir = join(runsDir, entry);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const state = readJsonIfPresent(join(runDir, "state.json"));
    if (!state || typeof state.run_id !== "string") continue;
    const manifest = readJsonIfPresent(join(runDir, "trace", "manifest.json"));
    rows.push({ state, manifest });
  }
  return rows;
}

// ── remote source ─────────────────────────────────────────────────────────

// Fetch every remote run ref into the namespaced remotes area. Returns
// { error } on failure — the board degrades to local-only (ADR-325).
function fetchRemoteRefs(projectRoot, remote) {
  const refspec = `+${RUN_REF_PREFIX}*:${REMOTE_REF_PREFIX}${remote}/factory-runs/*`;
  const r = git(projectRoot, ["fetch", "--quiet", "--prune", "--depth", "1", remote, refspec]);
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : String(r.stderr ?? "").trim();
    return { error: detail || "fetch failed" };
  }
  return { error: null };
}

function remoteRunIds(projectRoot, remote) {
  const listing = gitText(projectRoot, [
    "for-each-ref", "--format=%(refname)", `${REMOTE_REF_PREFIX}${remote}/factory-runs/`,
  ]);
  if (listing === null) return [];
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((refname) => refname.slice(`${REMOTE_REF_PREFIX}${remote}/factory-runs/`.length))
    .filter((id) => id.length > 0);
}

function remoteRunRow(projectRoot, remote, runId) {
  const ref = `${REMOTE_REF_PREFIX}${remote}/factory-runs/${runId}`;
  const sha = gitText(projectRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const stateText = gitText(projectRoot, ["show", `${ref}:state.json`]);
  if (stateText === null) return null; // legacy/garbage ref — skipped, counted
  let state;
  try {
    state = JSON.parse(stateText);
  } catch {
    return null;
  }
  if (!state || typeof state.run_id !== "string") return null;
  const manifestText = gitText(projectRoot, ["show", `${ref}:trace/manifest.json`]);
  let manifest = null;
  if (manifestText !== null) {
    try {
      manifest = JSON.parse(manifestText);
    } catch {}
  }
  return { state, manifest, remoteSha: sha ? sha.trim() : null };
}

// ── index ─────────────────────────────────────────────────────────────────

function rowFrom({ state, manifest, remoteSha, source }) {
  return {
    run_id: state.run_id,
    source,
    workflow_id: state.workflow_id ?? manifest?.workflow_id ?? null,
    status: state.status ?? manifest?.outcome ?? null,
    current_step_id: state.current_step_id ?? null,
    outcome: manifest?.outcome ?? state.status ?? null,
    retention_class: manifest?.retention_class ?? null,
    issue_ref: manifest?.issue_ref ?? state.inputs?.issue_ref ?? null,
    updated_at: manifest?.updated_at ?? state.updated_at ?? null,
    remote_sha: remoteSha ?? null,
  };
}

// Build the pane-of-glass index. Degrades per source: a failed remote fetch
// sets remoteError and the board shows local runs only; refs that do not
// parse are skipped and counted in skippedRemote.
export function buildBoardIndex({ projectRoot = process.cwd(), remote = "origin" } = {}) {
  // A remote is a name or URL, never a git option (refs.mjs checkRemote —
  // same guard park/restore use): a value like `--upload-pack=<cmd>` would
  // be parsed by git fetch as an option and run <cmd>. Validated here, at
  // the single entry point before any git call, so both flag forms
  // (`--remote x`, `--remote=x`) are covered.
  checkRemote(remote);
  const local = new Map(localRuns(projectRoot).map((r) => [r.state.run_id, r]));

  let remoteError = null;
  let skippedRemote = 0;
  const remoteMap = new Map();
  const fetch = fetchRemoteRefs(projectRoot, remote);
  if (fetch.error !== null) {
    remoteError = fetch.error;
  } else {
    for (const runId of remoteRunIds(projectRoot, remote)) {
      const row = remoteRunRow(projectRoot, remote, runId);
      if (row === null) {
        skippedRemote += 1;
        continue;
      }
      remoteMap.set(runId, row);
    }
  }

  const rows = [];
  for (const [runId, entry] of local) {
    const remoteEntry = remoteMap.get(runId);
    rows.push(
      rowFrom({
        state: entry.state,
        manifest: entry.manifest,
        remoteSha: remoteEntry?.remoteSha ?? null,
        source: remoteEntry ? "both" : "local",
      }),
    );
  }
  for (const [runId, entry] of remoteMap) {
    if (local.has(runId)) continue;
    rows.push(
      rowFrom({
        state: entry.state,
        manifest: entry.manifest,
        remoteSha: entry.remoteSha,
        source: "remote",
      }),
    );
  }

  rows.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  return { runs: rows, remoteError, skippedRemote };
}
