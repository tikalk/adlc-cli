// git-refs Tier-3 (ADR-393): push the run directory as a tree under
// refs/factory-runs/<run_id> using git plumbing — no working-tree commits,
// main history stays untouched. Called at session exit points (pause and
// terminal states); best-effort: silently skipped outside a git repo.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
