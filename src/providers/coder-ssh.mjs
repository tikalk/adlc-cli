// Live SSH transport for the coder provider.
//
// The mock transport (see coder-route.mjs) exercises the contract without a
// remote. This adapter is the real one: it provisions a Coder workspace with
// the `coder` CLI and runs the step over `coder ssh`.
//
// Secret discipline: a secret never appears in a command line. The payload
// travels as ONE base64 line on the transport's stdin; the remote decodes it
// into a file, exports the referenced vars with `export KEY=<sh-quoted>`
// (jq @sh), and runs the step. The vars therefore live in the remote's
// environment, never in argv — where `ps` would show them.
//
// The remote shell is POSIX sh + jq + base64 (all present in the baked
// workspace image).

import { spawn } from "node:child_process";

const DEFAULT_TEMPLATE = "general";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_POLL_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCoder(args, { input = "", timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("coder", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? 124 : (code ?? 1),
        stdout,
        stderr: killed ? `${stderr}\n(coder ${args[0]} timed out after ${timeoutMs}ms)` : stderr,
      });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

// A workspace is usable once its build is running (or finished running).
// `coder list -o json` reports the build status in latest_build.status;
// `coder show` has no JSON output.
function workspaceStatus(workspace) {
  return String(
    workspace?.latest_build?.status ?? workspace?.status ?? workspace?.state ?? ""
  ).toLowerCase();
}

function isRunning(workspace) {
  const status = workspaceStatus(workspace);
  return status === "running" || status === "succeeded" || status === "started";
}

export function createCoderSshTransport({
  template = DEFAULT_TEMPLATE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  async function provision(name) {
    if (!name) throw new Error("provision requires a workspace name");
    // --use-parameter-defaults: the template declares rich parameters (CPU,
    // memory, disk); without it `coder create` prompts and a non-TTY run
    // dies with "prepare build: EOF".
    const created = await runCoder(
      ["create", name, "--template", template, "--use-parameter-defaults", "--yes"],
      { timeoutMs: 300000 }
    );
    if (created.code !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
      throw new Error(
        `coder create ${name} failed (exit ${created.code}): ${(created.stderr || created.stdout).trim()}`
      );
    }
    const deadline = Date.now() + timeoutMs;
    let last = "no status yet";
    while (Date.now() < deadline) {
      const list = await runCoder(["list", "--all", "-o", "json"]);
      if (list.code === 0) {
        try {
          const workspaces = JSON.parse(list.stdout);
          const workspace = (Array.isArray(workspaces) ? workspaces : []).find(
            (w) => w && w.name === name
          );
          if (workspace && isRunning(workspace)) {
            // The coder SSH address for this template is <workspace>.main.
            return { name, host: `${name}.main` };
          }
          last = workspace ? workspaceStatus(workspace) || "unknown" : "not listed";
        } catch (err) {
          last = `unparseable workspace list: ${err.message}`;
        }
      } else {
        last = (list.stderr || list.stdout).trim().split("\n").slice(-1)[0] ?? "unknown";
      }
      await sleep(pollMs);
    }
    throw new Error(
      `workspace ${name} did not reach a running state within ${timeoutMs}ms (last status: ${last})`
    );
  }

  async function exec(handle, input) {
    const name = typeof handle === "string" ? handle : handle?.name;
    if (!name) throw new Error("exec requires a workspace name");
    const payload = JSON.parse(String(input ?? "{}"));
    // Two hops, because `coder ssh` re-interprets its command line through
    // the remote shell: a multi-line script passed as an argument does not
    // survive. So the ENVELOPE (payload + step script, base64) is written to
    // a file with a trivial command, and the runner script arrives on stdin
    // of a second, equally trivial command.
    const token = Math.random().toString(36).slice(2, 10);
    const envelopePath = `/tmp/adlc-envelope-${token}.b64`;
    const envelope = [
      Buffer.from(JSON.stringify(payload), "utf-8").toString("base64"),
      Buffer.from(remoteStep(payload.op), "utf-8").toString("base64"),
    ].join("\n") + "\n";

    const attempt = async () => {
      const written = await runCoder(["ssh", name, "--", "tee", envelopePath], {
        input: envelope,
        timeoutMs,
      });
      if (written.code !== 0) return { written, result: null };
      const result = await runCoder(["ssh", name, "--", "sh"], {
        input: remoteRunner(envelopePath),
        timeoutMs,
      });
      return { written, result };
    };

    let { written, result } = await attempt();
    const code = result ? result.code : written.code;
    const stderr = result ? result.stderr : written.stderr;
    // The workspace may have been deleted out of band while the handle
    // survived (the pilot hit exactly this: a stale handle + a deleted
    // workspace = "Resource not found"). Re-create it once and retry.
    if (code !== 0 && /not found|no longer exists|resource not found/i.test(stderr)) {
      console.error(`[provider] workspace '${name}' is gone — re-creating it and retrying once`);
      try {
        await this.provision(name);
      } catch (err) {
        return {
          stdout: result ? result.stdout : written.stdout,
          stderr: `${stderr}\n(re-creating the workspace failed: ${err.message})`,
          exitCode: code,
        };
      }
      ({ written, result } = await attempt());
    }
    const finalResult = result ?? written;
    return {
      stdout: finalResult.stdout,
      stderr: result ? finalResult.stderr : `${finalResult.stderr}\n(failed to write the transport envelope to ${envelopePath})`,
      exitCode: finalResult.code,
    };
  }

  return { provision, exec };
}

// The runner: read on stdin (so it never passes through a shell command
// line), decode the envelope that was written to a file, run the step.
function remoteRunner(envelopePath) {
  return `
set -u
_d=$(mktemp -d)
_p=$(sed -n 1p ${envelopePath})
_s=$(sed -n 2p ${envelopePath})
printf '%s' "$_p" | base64 -d > "$_d/payload.json"
printf '%s' "$_s" | base64 -d > "$_d/step.sh"
sh "$_d/step.sh" "$_d"
_rc=$?
rm -rf "$_d" ${envelopePath}
exit "$_rc"
`;
}

// The per-op step script. It receives the payload directory as $1 and
// returns the remote exit code.
function remoteStep(op) {
  const prelude = `
set -u
_d="$1"
_op=$(jq -r '.op // empty' "$_d/payload.json")
_export_vars() { jq -r '(.vars // {}) | to_entries[] | "export \\(.key)=\\(.value | @sh)"' "$_d/payload.json" > "$_d/vars.sh"; . "$_d/vars.sh"; }
_rc=1
case "$_op" in
`;
  const tail = `
*)
  echo "adlc: unsupported op '$_op'" >&2
  _rc=2
  ;;
esac
exit "$_rc"
`;
  switch (op) {
    case "workspace.setup":
      return `${prelude}  workspace.setup)
    jq -r '.configYaml // empty' "$_d/payload.json" > "$_d/workspace.yml"
    _export_vars
    # The developer's LATER session (a separate shell) must inherit the same
    # env the transport used: persist the referenced vars 0600 for the session
    # to source. Values stay in the workspace's env — never in a command line.
    mkdir -p "$HOME/.adlc"
    jq -r '(.vars // {}) | to_entries[] | "export \(.key)=\(.value | @sh)"' \
      "$_d/payload.json" > "$HOME/.adlc/secrets.env"
    chmod 600 "$HOME/.adlc/secrets.env"
    adlc-cli workspace setup "$_d/workspace.yml"
    _rc=$?
    ;;${tail}`;
    case "agent.run":
      return `${prelude}  agent.run)
    _export_vars
    _task=$(jq -r '.task // empty' "$_d/payload.json")
    adlc-cli agent run "$_task"
    _rc=$?
    ;;${tail}`;
    case "workflow.run":
      return `${prelude}  workflow.run)
    _export_vars
    _source=$(jq -r '.source // empty' "$_d/payload.json")
    adlc-cli workflow run "$_source" $(jq -r '(.inputs // {}) | to_entries[] | "--input \\(.key)=\\(.value)"' "$_d/payload.json")
    _rc=$?
    ;;${tail}`;
    default:
      return `${prelude}  *)
  echo "adlc: unsupported op '$_op'" >&2
  _rc=2
  ;;${tail}`;
  }
}
