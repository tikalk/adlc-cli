// git-refs Tier-3 (ADR-393): push the run directory as a tree under
// refs/factory-runs/<run_id> using git plumbing — no working-tree commits,
// main history stays untouched. Called at session exit points (pause and
// terminal states); best-effort: silently skipped outside a git repo.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { err } from "../ui/index.mjs";
import { redactSecrets } from "./redact.mjs";

// Machine-local run-dir files never cross machines (ADR-477):
//   lease.json  — liveness claim with hostname/pid/heartbeat
//   .push-ts    — local throttle stamp for remote run-ref sync
const EXCLUDED_RUN_FILES = new Set(["lease.json", ".push-ts"]);

// Push throttle for state transitions (ADR-475 crash-window bound). The
// stamp lives inside the run dir and is excluded from the pushed tree.
const PUSH_STAMP = ".push-ts";
const DEFAULT_PUSH_INTERVAL = 60;

function pushIntervalSeconds() {
  const raw = process.env.ADLC_WORKFLOW_PUSH_INTERVAL;
  if (raw === undefined || raw === "") return DEFAULT_PUSH_INTERVAL;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PUSH_INTERVAL;
}

export function pushRunRef(projectRoot, runId, runDir) {
  const git = (args, input) =>
    spawnSync("git", args, {
      cwd: projectRoot,
      encoding: "utf-8",
      input,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "adlc-workflow",
        GIT_AUTHOR_EMAIL: "workflow@adlc.local",
        GIT_COMMITTER_NAME: "adlc-workflow",
        GIT_COMMITTER_EMAIL: "workflow@adlc.local",
      },
    });
  const isRepo = git(["rev-parse", "--is-inside-work-tree"]);
  if (isRepo.status !== 0) return false;

  // hash-object every file, build nested trees bottom-up.
  // git mktree input format: "<mode> SP <type> SP <sha1> TAB <name>".
  const hashDir = (absDir) => {
    const entries = [];
    for (const name of readdirSync(absDir).sort()) {
      if (EXCLUDED_RUN_FILES.has(name)) continue;
      const abs = join(absDir, name);
      // lstat, never stat: a symlink (file or directory) is skipped, not
      // followed — a run dir must never ship or hash out-of-tree content,
      // and a dangling symlink must not fail the walk (ADR-478).
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        entries.push(`040000 tree ${hashDir(abs)}\t${name}`);
      } else {
        const h = git(["hash-object", "-w", abs]);
        if (h.status !== 0) throw new Error(`git hash-object failed: ${h.stderr}`);
        entries.push(`100644 blob ${h.stdout.trim()}\t${name}`);
      }
    }
    const mktree = git(["mktree"], entries.join("\n") + (entries.length ? "\n" : ""));
    if (mktree.status !== 0) throw new Error(`git mktree failed: ${mktree.stderr}`);
    return mktree.stdout.trim();
  };

  try {
    const tree = hashDir(runDir);
    const commit = git(["commit-tree", tree, "-m", `workflow run ${runId}`]);
    if (commit.status !== 0) throw new Error(`git commit-tree failed: ${commit.stderr}`);
    const ref = `refs/factory-runs/${runId}`;
    const update = git(["update-ref", ref, commit.stdout.trim()]);
    if (update.status !== 0) throw new Error(`git update-ref failed: ${update.stderr}`);
    return true;
  } catch (cause) {
    err(`[workflow] git-refs push skipped: ${cause.message}`);
    return false;
  }
}

// Redact secrets in every UTF-8 text file of the run dir, in place, before it
// is hashed into the pushed ref (ADR-478 redact-on-park). Binary/non-UTF-8
// files are left untouched. Returns the number of files rewritten.
export function redactRunDir(runDir, env = process.env) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let rewritten = 0;
  const walk = (absDir) => {
    for (const name of readdirSync(absDir)) {
      const abs = join(absDir, name);
      // lstat, never stat: redaction must not write through a symlink into
      // files outside the run dir, nor recurse into symlinked directories;
      // a dangling symlink must not fail the walk (ADR-478).
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (EXCLUDED_RUN_FILES.has(name)) continue;
      const buf = readFileSync(abs);
      let text;
      try {
        text = decoder.decode(buf);
      } catch {
        continue; // not UTF-8 text
      }
      const redacted = redactSecrets(text, env);
      if (redacted !== text) {
        writeFileSync(abs, redacted, "utf-8");
        rewritten += 1;
      }
    }
  };
  walk(runDir);
  return rewritten;
}

// syncRunRef — record the run dir as refs/factory-runs/<runId> locally, then
// force-push that ref to the remote so another machine can restore it
// (ADR-475). The remote push is throttled by ADLC_WORKFLOW_PUSH_INTERVAL
// seconds (default 60; 0 = every transition) and is fail-soft: an offline
// pod never fails the run, and the local ref stays valid for the next sync.
export function syncRunRef(projectRoot, runId, runDir, { remote = "origin", minIntervalSeconds = pushIntervalSeconds() } = {}) {
  // Every sync is redacted, not just park: the remote sees the run dir on
  // every transition, so a secret-valued input must be masked before the
  // first push lands on origin (ADR-478, ADR-497). Fail-soft: a redaction
  // hiccup must not fail the transition either.
  try {
    redactRunDir(runDir);
  } catch (exc) {
    err(`[workflow] run-ref redaction skipped for ${runId}: ${exc?.message ?? exc}`);
  }
  if (!pushRunRef(projectRoot, runId, runDir)) return false;
  const ref = `refs/factory-runs/${runId}`;
  const stamp = join(runDir, PUSH_STAMP);
  if (minIntervalSeconds > 0 && existsSync(stamp)) {
    // Unreadable stamp (EACCES, TOCTOU removal) counts as absent: proceed
    // to push, never fail the transition (ADR-497 fail-soft).
    let last = NaN;
    try {
      last = Number(readFileSync(stamp, "utf-8").trim());
    } catch {
      last = NaN;
    }
    if (Number.isFinite(last) && Date.now() - last < minIntervalSeconds * 1000) {
      return true;
    }
  }
  const pushed = spawnSync("git", ["push", "--quiet", remote, `+${ref}:${ref}`], {
    cwd: projectRoot,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (pushed.error || pushed.status !== 0) {
    const detail = pushed.error ? pushed.error.message : String(pushed.stderr ?? "").trim();
    err(`[workflow] run-ref remote sync skipped: ${detail}`);
    return true;
  }
  try {
    writeFileSync(stamp, String(Date.now()), "utf-8");
  } catch {}
  return true;
}

// Park and restore (ADR-391-amendment-3 §2–3): a run paused at a gate past
// its in-pod wait is saved — with the gate's Slack thread handle — to
// refs/factory-runs/<run_id> on a git remote, so a later pod in another clone
// can restore runs/<run_id>/ and resume it. Both throw on any failure: unlike
// the best-effort pushRunRef, a park or restore that silently did nothing
// would lose the approver's answer or resume the wrong run.
//
// pushRunRef hashes the whole runDir, inputs.json included, after
// redactRunDir masks secret-shaped values: whatever was passed via --input
// still lands on the remote, but a secret-valued input is masked first.

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parkRun(projectRoot, runId, { handleFile, remote = "origin" } = {}) {
  const runDir = runDirFor(projectRoot, runId);
  checkRemote(remote);
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) throw new Error(`park: run ${runId} not found at ${runDir}`);
  const status = JSON.parse(readFileSync(statePath, "utf-8")).status;
  if (status !== "paused") throw new Error(`park: run ${runId} is not paused (status: ${status})`);
  const handle = JSON.parse(readFileSync(handleFile, "utf-8"));
  if (handle === null || typeof handle !== "object" || Array.isArray(handle)) {
    throw new Error("park: the handle file must hold a JSON object");
  }
  writeFileSync(join(runDir, "gate-handle.json"), JSON.stringify(handle, null, 2) + "\n", "utf-8");
  // ADR-478: redact every text file in place before it is hashed into the
  // ref, so a secret that leaked into state/logs/inputs never reaches the
  // remote. Machine-local files (lease.json, .push-ts) are excluded from the
  // tree by pushRunRef (ADR-477).
  redactRunDir(runDir);
  if (!pushRunRef(projectRoot, runId, runDir)) throw new Error(`park: could not record refs/factory-runs/${runId}`);
  const ref = `refs/factory-runs/${runId}`;
  // The run ref is rebuilt from scratch at every save, so it never descends
  // from the previous one: force-update it on the remote.
  gitOrThrow(projectRoot, ["push", "--quiet", remote, `+${ref}:${ref}`], "park: push");
  return ref;
}

export function restoreRun(projectRoot, runId, { remote = "origin", issueRef = null } = {}) {
  const runDir = runDirFor(projectRoot, runId);
  checkRemote(remote);
  // Exclusive claim, not existsSync-then-write: two pods restoring the same
  // run_id concurrently (the scenario this feature exists for) would both
  // pass an existsSync check before either had written anything, then
  // interleave writes into the same directory. mkdirSync without recursive
  // is an atomic directory-creation at the filesystem level (POSIX mkdir(2)
  // guarantees exactly one of two concurrent callers gets ENOENT's sibling
  // EEXIST); only the winner proceeds, the loser fails closed immediately
  // without touching anything the winner wrote.
  mkdirSync(dirname(runDir), { recursive: true });
  try {
    mkdirSync(runDir);
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`restore: ${runDir} already exists; refusing to overwrite it`);
    throw err;
  }
  try {
    const ref = `refs/factory-runs/${runId}`;
    gitOrThrow(projectRoot, ["fetch", "--quiet", remote, `+${ref}:${ref}`], "restore: fetch");
    if (issueRef !== null && issueRef !== undefined && issueRef !== "") {
      const inputs = JSON.parse(gitOrThrow(projectRoot, ["show", `${ref}:inputs.json`], "restore: read inputs").toString("utf-8"));
      const recorded = inputs?.inputs?.issue_ref ?? null;
      if (recorded !== issueRef) {
        throw new Error(`restore: run ${runId} belongs to issue_ref ${JSON.stringify(recorded)}, not ${JSON.stringify(issueRef)}`);
      }
    }
    const listing = gitOrThrow(projectRoot, ["ls-tree", "-r", "-z", ref], "restore: list").toString("utf-8");
    const baseDir = resolve(runDir);
    for (const entry of listing.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, sha] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      // Git stores a tree path verbatim, so a path that spells a ".."
      // segment with a backslash ("a\..\b") is one component to git but
      // three to a Windows host: it is rejected like the forward-slash
      // form. The resolved destination must also stay inside the run dir.
      if (type !== "blob" || path.split("/").includes("..") || path.includes("\\")) continue;
      const dest = resolve(baseDir, path);
      if (!dest.startsWith(baseDir + sep)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, gitOrThrow(projectRoot, ["cat-file", "blob", sha], "restore: read"));
    }
  } catch (err) {
    rmSync(runDir, { recursive: true, force: true });
    throw err;
  }
  return runDir;
}

function runDirFor(projectRoot, runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error(`invalid run id ${JSON.stringify(runId)}`);
  return join(projectRoot, ".adlc", "workflows", "runs", runId);
}

// A remote is a name or URL, never an option: `git fetch --upload-pack=<cmd>`
// would run <cmd>. This does not defend against an `ext::<command>` remote
// (git's remote-helper transport runs <command> directly) -- `remote` is
// operator-supplied here (a local CLI flag), never attacker data from a
// parked ref, so that trust assumption is accepted, not defended against.
function checkRemote(remote) {
  if (typeof remote !== "string" || remote === "" || remote.startsWith("-") || /[\0\n]/.test(remote)) {
    throw new Error(`invalid remote ${JSON.stringify(remote)}`);
  }
}

// stdout (Buffer) of a successful git call; throws with git's stderr otherwise.
function gitOrThrow(cwd, args, what) {
  const r = spawnSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : String(r.stderr ?? "").trim();
    throw new Error(`${what} failed: ${detail}`);
  }
  return r.stdout;
}
