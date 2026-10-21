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

// A workspace is usable when it is running (not starting/stopped/failed).
function isRunning(workspace) {
  const status = String(workspace?.status ?? workspace?.state ?? "").toLowerCase();
  if (!status) return false;
  return status === "running" || status === "started";
}

export function createCoderSshTransport({
  template = DEFAULT_TEMPLATE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  async function provision(name) {
    if (!name) throw new Error("provision requires a workspace name");
    const created = await runCoder(["create", name, "--template", template, "--yes"], {
      timeoutMs: 300000,
    });
    if (created.code !== 0 && !/already exists/i.test(created.stderr + created.stdout)) {
      throw new Error(
        `coder create ${name} failed (exit ${created.code}): ${(created.stderr || created.stdout).trim()}`
      );
    }
    const deadline = Date.now() + timeoutMs;
    let last = "no status yet";
    while (Date.now() < deadline) {
      const show = await runCoder(["show", name, "--output", "json"]);
      if (show.code === 0) {
        try {
          const workspace = JSON.parse(show.stdout);
          if (isRunning(workspace)) {
            return { name, host: `coder.${name}.main` };
          }
          last = String(workspace?.status ?? workspace?.state ?? "unknown");
        } catch (err) {
          last = `unparseable workspace json: ${err.message}`;
        }
      } else {
        last = (show.stderr || show.stdout).trim().split("\n").slice(-1)[0] ?? "unknown";
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
    const command = remoteCommand(payload.op);
    const envelope = `${Buffer.from(JSON.stringify(payload), "utf-8").toString("base64")}\n`;
    const result = await runCoder(["ssh", name, "--", "sh", "-c", command], {
      input: envelope,
      timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  }

  return { provision, exec };
}

// The remote script: one base64 line on stdin, the payload decoded into a
// file, the referenced vars exported (shell-quoted), the step executed, the
// exit code propagated.
const REMOTE_PRELUDE = `
set -u
_d=$(mktemp -d)
IFS= read -r _b64
printf '%s' "$_b64" | base64 -d > "$_d/payload.json"
_op=$(jq -r '.op // empty' "$_d/payload.json")
_jq_vars() { jq -r '(.vars // {}) | to_entries[] | "export \\(.key)=\\(.value | @sh)"' "$_d/payload.json" > "$_d/vars.sh"; . "$_d/vars.sh"; }
_rc=1
case "$_op" in
`;

function remoteCommand(op) {
  const tail = `
*)
  echo "adlc: unsupported op '$_op'" >&2
  _rc=2
  ;;
esac
rm -rf "$_d"
exit "$_rc"
`;
  switch (op) {
    case "workspace.setup":
      return `${REMOTE_PRELUDE}  workspace.setup)
    jq -r '.configYaml // empty' "$_d/payload.json" > "$_d/workspace.yml"
    _jq_vars
    adlc-cli workspace setup "$_d/workspace.yml"
    _rc=$?
    ;;${tail}`;
    case "agent.run":
      return `${REMOTE_PRELUDE}  agent.run)
    _jq_vars
    _task=$(jq -r '.task // empty' "$_d/payload.json")
    adlc-cli agent run "$_task"
    _rc=$?
    ;;${tail}`;
    case "workflow.run":
      return `${REMOTE_PRELUDE}  workflow.run)
    _jq_vars
    _source=$(jq -r '.source // empty' "$_d/payload.json")
    _inputs=$(jq -r '(.inputs // {}) | to_entries[] | "\\(.key)=\\(.value)"' "$_d/payload.json")
    set -- "$_source"
    for _kv in $_inputs; do set -- "$@" --input "$_kv"; done
    adlc-cli workflow run "$@"
    _rc=$?
    ;;${tail}`;
    default:
      return `${REMOTE_PRELUDE}  *)
  echo "adlc: unsupported op '$_op'" >&2
  _rc=2
  ;;${tail}`;
  }
}
