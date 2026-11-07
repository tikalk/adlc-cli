// E2E — cross-session run transport + trace bundle (Phases 0+1 verification).
//
// Two separate adlc-cli processes ("sessions"), two separate clones of one
// bare remote ("pods"), driven only through the real CLI binary:
//
//   Session A (pod-a): run → paused at gate (exit 3) → park → exit
//   Session B (pod-b): restore (guarded) → resume → completed (exit 0)
//
// Contract verified here:
//   V1  a run paused at a gate exits 3 (lane contract) and parks to
//       refs/factory-runs/<id> on the remote.
//   V2  the pushed ref tree excludes machine-local lease.json / .push-ts
//       (ADR-477) and carries the trace bundle (ADR-490).
//   V3  restore refuses a mismatched --issue-ref and an existing run dir.
//   V4  every event line restored from the ref is a valid ADR-362 envelope
//       with an ADR-364 canonical type (ADR-362/364).
//   V5  a seeded secret never crosses the session boundary: it is absent
//       from the entire restored run dir (capture redaction, ADR-478).
//   V6  resume in session B completes the run; default retention prunes the
//       successful events and keeps the manifest (ADR-490 fail-closed).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "adlc-cli.mjs");

const SECRET = "crossSessionSecretValue42";

const base = mkdtempSync(join(tmpdir(), "adlc-e2e-cross-"));
const bare = join(base, "origin.git");
const podA = join(base, "pod-a");
const podB = join(base, "pod-b");

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failures += 1;
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function cli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

const strip = (s) => s.replace(/\[[0-9;]*[A-Za-z]/g, "");

try {
  // ── setup: bare remote + two clones ────────────────────────────────────
  git(base, "init", "-q", "--bare", "-b", "main", bare);
  mkdirSync(podA);
  git(podA, "init", "-q", "-b", "main");
  git(podA, "config", "user.email", "t@t.local");
  git(podA, "config", "user.name", "t");
  git(podA, "config", "commit.gpgsign", "false");
  writeFileSync(join(podA, ".gitignore"), ".adlc/workflows/\n", "utf-8");
  writeFileSync(join(podA, "README.md"), "base\n", "utf-8");
  git(podA, "add", "-A");
  git(podA, "commit", "-q", "-m", "base");
  git(podA, "remote", "add", "origin", bare);
  git(podA, "push", "-q", "origin", "main");

  const wfDir = join(podA, "wf");
  mkdirSync(wfDir);
  writeFileSync(join(wfDir, "flow.yml"), `schema_version: "1.0"
workflow:
  id: cross-session
  name: Cross Session
  version: "1.0.0"
inputs:
  verdict: {type: string, enum: ["", approve, reject]}
steps:
  - id: work
    type: shell
    run: "echo leaked=$CROSS_SESSION_TOKEN"
  - id: approve
    type: gate
    message: "Approve before finishing?"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: finish
    type: shell
    run: "echo finished"
`, "utf-8");

  // ── session A: run to the gate, then park ──────────────────────────────
  console.log("== 1. session A: run → paused at gate ==");
  const runA = cli(podA, ["workflow", "run", "wf/flow.yml", "--input", "verdict="], {
    CROSS_SESSION_TOKEN: SECRET,
  });
  const runText = strip(runA.stdout + runA.stderr);
  const runIdMatch = runText.match(/resume ([A-Za-z0-9][A-Za-z0-9._-]*)/);
  check("run exits 3 (paused, lane contract)", runA.status === 3);
  check("run prints the resume hint with the run id", runIdMatch !== null);
  const runId = runIdMatch ? runIdMatch[1] : "unknown";

  writeFileSync(join(base, "handle.json"), JSON.stringify({ channel: "C1", thread_ts: "1.0" }), "utf-8");
  const parkA = cli(podA, ["workflow", "park", runId, "--handle-file", join(base, "handle.json")]);
  check("park exits 0", parkA.status === 0);

  console.log("== 2. remote ref contents (V2) ==");
  const ref = `refs/factory-runs/${runId}`;
  const tree = git(bare, "ls-tree", "-r", "--name-only", ref).split("\n").filter(Boolean);
  check("ref tree excludes lease.json (ADR-477)", !tree.includes("lease.json"));
  check("ref tree excludes .push-ts (ADR-477)", !tree.includes(".push-ts"));
  for (const rel of ["trace/manifest.json", "trace/events.jsonl", "trace/artifacts.json"]) {
    check(`ref tree carries ${rel} (ADR-490)`, tree.includes(rel));
  }
  const remoteManifest = JSON.parse(git(bare, "show", `${ref}:trace/manifest.json`));
  check("remote manifest outcome is paused", remoteManifest.outcome === "paused");

  console.log("== 3. session B: guarded restore (V3) ==");
  git(bare, "clone", "-q", bare, podB);
  for (const args of [["user.email", "t@t.local"], ["user.name", "t"], ["commit.gpgsign", "false"]]) {
    git(podB, "config", ...args);
  }
  git(podB, "remote", "remove", "origin");
  git(podB, "remote", "add", "origin", bare);
  const wrongRef = cli(podB, ["workflow", "restore", runId, "--issue-ref", "issue-999"]);
  check("restore refuses a mismatched issue-ref", wrongRef.status === 1);
  check(
    "restore names the mismatch",
    strip(wrongRef.stderr + wrongRef.stdout).includes("issue_ref"),
  );

  const restoreB = cli(podB, ["workflow", "restore", runId]);
  check("restore succeeds", restoreB.status === 0);
  const againB = cli(podB, ["workflow", "restore", runId]);
  check("second restore refuses an existing run dir", againB.status === 1);

  console.log("== 4. restored bundle validates (V4/V5) ==");
  const runDirB = join(podB, ".adlc", "workflows", "runs", runId);
  const eventsPath = join(runDirB, "trace", "events.jsonl");
  const canonical = new Set(["message", "tool", "permission_request", "error", "complete", "log"]);
  const envelopes = readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("restored events file is non-empty", envelopes.length > 0);
  check(
    "every event is a valid ADR-362 envelope with a canonical type",
    envelopes.every(
      (e) =>
        e.schema_version === 1 &&
        typeof e.agent_id === "string" &&
        e.agent_id.length > 0 &&
        !Number.isNaN(Date.parse(e.ts)) &&
        canonical.has(e.type) &&
        typeof e.payload?.adlc?.event === "string",
    ),
  );
  check(
    "run pause is recorded in the stream",
    envelopes.some((e) => e.payload.adlc.event === "run_paused" || e.payload.adlc.event === "gate_paused"),
  );

  // V5: the secret printed by the work step must be absent from the whole
  // restored run dir — shell-step redaction and trace redaction together.
  let secretHits = 0;
  const scan = (abs) => {
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) scan(join(abs, name));
      return;
    }
    try {
      if (readFileSync(abs, "utf-8").includes(SECRET)) secretHits += 1;
    } catch {} // binary file
  };
  scan(runDirB);
  check(`seeded secret absent from the restored run dir (${secretHits} hits)`, secretHits === 0);
  const maskText = readFileSync(join(runDirB, "state.json"), "utf-8");
  check("work-step output carries the mask", maskText.includes("***"));

  console.log("== 5. session B: resume → completed (V6) ==");
  const resumeB = cli(podB, ["workflow", "resume", runId, "--input", "verdict=approve"]);
  check("resume exits 0", resumeB.status === 0);
  const showB = cli(podB, ["workflow", "state", "show", runId, "--format", "json"]);
  const stateB = JSON.parse(showB.stdout);
  check("final status is completed", stateB.status === "completed");

  const manifestB = JSON.parse(readFileSync(join(runDirB, "trace", "manifest.json"), "utf-8"));
  check("manifest outcome is completed", manifestB.outcome === "completed");
  check("default retention prunes successful events (fail-closed)", !existsSync(eventsPath));
  check("manifest survives retention", existsSync(join(runDirB, "trace", "manifest.json")));
  check("retention class is manifest-only", manifestB.retention_class === "manifest-only");
  check("manifest has no lease conflict fields", !existsSync(join(runDirB, "lease.json")));
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}

if (failures > 0) {
  console.log(`\nE2E FAILED (${failures} assertion${failures === 1 ? "" : "s"} failed)`);
  process.exit(1);
}
console.log("\nE2E PASSED (all assertions green)");
