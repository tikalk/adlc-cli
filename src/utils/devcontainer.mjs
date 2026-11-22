// Step 5.7 — thin `devcontainer up` trigger (issue #101, executable brief
// comment 85133, per ADR-386-amendment-3).
//
// The trigger fires on declaration: the workspace file declares devcontainer
// use via a devcontainer.json file, resolved as
// `.devcontainer/devcontainer.json` > `.devcontainer.json` > skip. It fires
// on declaration — never on a provider flag (ADR-443: the workspace file
// declares WHAT, never WHERE).
//
// adlc-cli shells out to the real `devcontainer up` against the
// runner-provided daemon. All feature semantics (fetch, order, install)
// belong to devcontainers/cli, never to adlc-cli. Node stdlib only.
//
// Readiness + wrapper semantics per amendment-3: wait for daemon readiness;
// stream inner stdout/stderr to outer stdout; propagate the exact exit code;
// artifacts land on /workspace. SIGTERM is NOT forwarded in flight (see
// the limitation note at the spawn site). Any failure is a non-zero
// setup failure — fail-fast, before skills run.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

const CANONICAL = ".devcontainer/devcontainer.json";
const LEGACY = ".devcontainer.json";

// Tunables for tests: ADLC_DAEMON_WAIT_ATTEMPTS / ADLC_DAEMON_WAIT_MS shrink
// the readiness window; ADLC_DEVCONTAINER_SKIP_READINESS bypasses it (stub
// CLIs in tests stand in for the real binary — the daemon check only makes
// sense against a live daemon).
function waitConfig() {
  const attempts = Number(process.env.ADLC_DAEMON_WAIT_ATTEMPTS ?? 30);
  const waitMs = Number(process.env.ADLC_DAEMON_WAIT_MS ?? 1000);
  return {
    attempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 30,
    waitMs: Number.isFinite(waitMs) && waitMs >= 0 ? Math.floor(waitMs) : 1000,
  };
}

// Resolve the devcontainer declaration for a project root. Returns the
// relative config path (canonical preferred over legacy) or null when no
// devcontainer file declares use.
export function resolveDevcontainerConfig(projectRoot) {
  if (existsSync(join(projectRoot, CANONICAL))) return CANONICAL;
  if (existsSync(join(projectRoot, LEGACY))) return LEGACY;
  return null;
}

// Locate the `devcontainer` CLI on PATH. Returns the resolved path or null.
// spawnSync `error` covers ENOENT, but an explicit pre-check lets setup fail
// loudly with a cause that names the missing prerequisite.
export function findDevcontainerCli() {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  // Windows resolves executables through PATHEXT (devcontainer.cmd/.exe).
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `devcontainer${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Wait for the Docker daemon to answer. The runner provides the daemon
// (sidecar per #102 / amendment-3); DOCKER_HOST selects the socket.
// Returns null when ready, or an error string naming the cause.
export function waitForDaemon() {
  if (process.env.ADLC_DEVCONTAINER_SKIP_READINESS === "1") return null;
  const { attempts, waitMs } = waitConfig();
  const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const result = spawnSync("docker", ["info"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    if (result.status === 0) return null;
    lastError = describeSpawnFailure(result);
    if (i < attempts - 1 && waitMs > 0) {
      // Blocking sleep without CPU spin; stdlib-only, sync setup path.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  return `docker daemon not ready (DOCKER_HOST=${dockerHost}): ${lastError}`;
}

function describeSpawnFailure(result) {
  if (result?.error) {
    const err = result.error;
    return err.code ? `${err.code}: ${err.message}` : String(err.message || err);
  }
  const stderr = String(result?.stderr || "").trim();
  if (stderr) return stderr.split("\n")[0];
  return `exit ${result?.status ?? "unknown"}`;
}

// Run the thin trigger. Prints the plan line under --dry-run and spawns
// nothing. Returns { ran, code } — ran=false when no declaration exists.
export function runDevcontainerTrigger({ projectRoot, dryRun, out = null }) {
  const config = resolveDevcontainerConfig(projectRoot);
  if (!config) return { ran: false, code: 0 };

  const configTrace = process.env.ADLC_DEVCONTAINER_CONFIG_TRACE === "1" ? ` (${config})` : "";
  const argv = ["up", "--workspace-folder", projectRoot];
  const planLine = `devcontainer ${argv.join(" ")}${configTrace}`;
  const print = out || ((line) => process.stdout.write(`${line}\n`));
  const spawnLog = process.env.ADLC_DEVCONTAINER_SPAWN_LOG;

  if (dryRun) {
    print(`  → ${planLine} [dry-run]`);
    // Spawn audit for tests: dry-run must leave no trace of a spawn.
    if (spawnLog) {
      try {
        writeFileSync(spawnLog, "", "utf-8");
      } catch {
        // best-effort audit only
      }
    }
    return { ran: true, code: 0 };
  }

  const cli = findDevcontainerCli();
  if (!cli) {
    return {
      ran: true,
      code: 1,
      error:
        "devcontainer CLI not found on PATH — install devcontainers/cli " +
        "(pod image provides it per #102; local dev installs it)",
    };
  }

  const daemonError = waitForDaemon();
  if (daemonError) {
    return { ran: true, code: 1, error: daemonError };
  }

  const child = spawnSync(cli, argv, {
    stdio: "inherit",
    cwd: resolve(projectRoot),
    env: process.env,
  });
  // Limitation: spawnSync blocks the event loop, so a SIGTERM delivered to
  // this process alone is not forwarded to the inner run. With stdio: inherit
  // the child shares the terminal/process group, so a group-directed signal
  // (Ctrl-C, `kill -- -PGID`, pod termination) still reaches it.
  if (spawnLog) {
    try {
      writeFileSync(spawnLog, `spawned: devcontainer ${argv.join(" ")}\n`, "utf-8");
    } catch {
      // best-effort audit only
    }
  }
  if (child.error) {
    return {
      ran: true,
      code: 1,
      error: `devcontainer up could not start: ${describeSpawnFailure(child)}`,
    };
  }
  const code = typeof child.status === "number" ? child.status : 1;
  if (code !== 0) {
    return { ran: true, code, error: `devcontainer up failed with exit code ${code}` };
  }
  return { ran: true, code: 0 };
}
