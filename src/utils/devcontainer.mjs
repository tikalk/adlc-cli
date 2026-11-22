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
// Wrapper semantics: stream inner stdout/stderr to outer stdout; propagate the
// exact exit code; forward SIGTERM/SIGINT to the inner run; artifacts land on
// /workspace. Daemon readiness is the runner pod's job (native-sidecar
// startupProbe gates main, ADR-386-amendment-4) — not waited on here. Any
// failure is a non-zero setup failure — fail-fast, before skills run.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join, resolve } from "node:path";

const CANONICAL = ".devcontainer/devcontainer.json";
const LEGACY = ".devcontainer.json";

// Resolve the devcontainer declaration for a project root. Returns the
// relative config path (canonical preferred over legacy) or null when no
// devcontainer file declares use.
export function resolveDevcontainerConfig(projectRoot) {
  if (existsSync(join(projectRoot, CANONICAL))) return CANONICAL;
  if (existsSync(join(projectRoot, LEGACY))) return LEGACY;
  return null;
}

// Verify the `devcontainer` CLI runs. `devcontainer --version` lets the OS
// resolve the binary (no PATH/PATHEXT logic here) and fails setup early with
// a cause naming the missing prerequisite.
// Returns null when usable, or an error string.
export function checkDevcontainerCli() {
  const result = spawnSync("devcontainer", ["--version"], { encoding: "utf-8" });
  if (result.error?.code === "ENOENT") {
    return (
      "devcontainer CLI not found on PATH — install devcontainers/cli " +
      "(pod image provides it per #102; local dev installs it)"
    );
  }
  if (result.error || result.status !== 0) {
    return `devcontainer --version failed: ${describeSpawnFailure(result)}`;
  }
  return null;
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
export async function runDevcontainerTrigger({ projectRoot, dryRun, out = null }) {
  const config = resolveDevcontainerConfig(projectRoot);
  if (!config) return { ran: false, code: 0 };

  const argv = ["up", "--workspace-folder", projectRoot];
  const planLine = `devcontainer ${argv.join(" ")} (${config})`;
  const print = out || ((line) => process.stdout.write(`${line}\n`));

  if (dryRun) {
    print(`  → ${planLine} [dry-run]`);
    return { ran: true, code: 0 };
  }

  const cliError = checkDevcontainerCli();
  if (cliError) {
    return { ran: true, code: 1, error: cliError };
  }

  // Async spawn so a SIGTERM/SIGINT delivered to this process alone (e.g. the
  // runner pod signalling its main process) is forwarded to the inner run
  // instead of orphaning it. stdio: inherit streams output unchanged.
  const child = spawn("devcontainer", argv, {
    stdio: "inherit",
    cwd: resolve(projectRoot),
    env: process.env,
  });
  const forwardTerm = () => child.kill("SIGTERM");
  const forwardInt = () => child.kill("SIGINT");
  process.on("SIGTERM", forwardTerm);
  process.on("SIGINT", forwardInt);
  const { code: exitCode, signal, error: spawnError } = await new Promise((done) => {
    child.on("error", (error) => done({ error }));
    child.on("close", (code, sig) => done({ code, signal: sig }));
  });
  process.off("SIGTERM", forwardTerm);
  process.off("SIGINT", forwardInt);

  if (spawnError) {
    return {
      ran: true,
      code: 1,
      error: `devcontainer up could not start: ${describeSpawnFailure({ error: spawnError })}`,
    };
  }
  // A signal-killed child has no exit code; report the shell convention 128+n.
  const code = typeof exitCode === "number" ? exitCode : 128 + (osConstants.signals[signal] ?? 0);
  if (code !== 0) {
    return { ran: true, code, error: `devcontainer up failed with exit code ${code}` };
  }
  return { ran: true, code: 0 };
}
