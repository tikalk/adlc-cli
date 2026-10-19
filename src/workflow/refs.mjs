// git-refs Tier-3 (ADR-393): push the run directory as a tree under
// refs/factory-runs/<run_id> using git plumbing — no working-tree commits,
// main history stays untouched. Called at session exit points (pause and
// terminal states); best-effort: silently skipped outside a git repo.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

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
      const abs = join(absDir, name);
      if (statSync(abs).isDirectory()) {
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
  } catch (err) {
    console.error(`[workflow] git-refs push skipped: ${err.message}`);
    return false;
  }
}

// Park and restore (ADR-391-amendment-3 §2–3): a run paused at a gate past
// its in-pod wait is saved — with the gate's Slack thread handle — to
// refs/factory-runs/<run_id> on a git remote, so a later pod in another clone
// can restore runs/<run_id>/ and resume it. Both throw on any failure: unlike
// the best-effort pushRunRef, a park or restore that silently did nothing
// would lose the approver's answer or resume the wrong run.

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
  if (existsSync(runDir)) throw new Error(`restore: ${runDir} already exists; refusing to overwrite it`);
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
  try {
    for (const entry of listing.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, sha] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (type !== "blob" || path.split("/").includes("..")) continue;
      const dest = join(runDir, path);
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
// would run <cmd>.
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
