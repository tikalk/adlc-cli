// Live SSH transport for the coder provider.
//
// The mock transport (see route.mjs) exercises the contract without a
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
import { randomUUID } from "node:crypto";

const DEFAULT_TEMPLATE = "general";
// Default 15 minutes; override with ADLC_TRANSPORT_TIMEOUT_MS (milliseconds).
const DEFAULT_TIMEOUT_MS =
  Number(process.env.ADLC_TRANSPORT_TIMEOUT_MS) || 15 * 60 * 1000;
const DEFAULT_POLL_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCoder(
  args,
  { input = "", timeoutMs = 120000, collectStdout = true, onStdout = null } = {}
) {
  return new Promise((resolve) => {
    // POSIX: make the child a process-group leader so a timeout kills the
    // ssh process *and* anything it spawned. Windows has no equivalent
    // synchronous group kill; child.kill() remains the fallback there.
    const detached = process.platform !== "win32";
    const child = spawn("coder", args, { stdio: ["pipe", "pipe", "pipe"], detached });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const killChild = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The group may already be gone; fall through to the direct kill.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      killed = true;
      killChild();
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      const chunk = d.toString();
      if (collectStdout) stdout += chunk;
      if (onStdout) onStdout(chunk);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    // A child that exits before consuming a large stdin envelope (auth
    // failure, stopped workspace, killed run) raises EPIPE. That is the
    // child's verdict to report through its exit code/stderr, never an
    // unhandled stream error that crashes the CLI.
    child.stdin?.on("error", (err) => {
      if (err?.code !== "EPIPE") stderr += `\n${err.message}`;
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
    try {
      if (child.stdin) {
        if (input) child.stdin.write(input);
        child.stdin.end();
      }
    } catch (err) {
      if (err?.code !== "EPIPE") stderr += `\n${err.message}`;
    }
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

// Stale-handle detection must come from the provider, never from a step's
// stderr: a missing binary inside the remote is a step failure, not evidence
// that the workspace was deleted. Returns true/false, or null when the
// provider cannot answer (then the caller reports the original failure).
async function workspaceExists(name) {
  const list = await runCoder(["list", "--all", "-o", "json"]);
  if (list.code !== 0) return null;
  try {
    const workspaces = JSON.parse(list.stdout);
    if (!Array.isArray(workspaces)) return null;
    return workspaces.some((w) => w && w.name === name);
  } catch {
    return null;
  }
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

  // Two hops, because `coder ssh` re-interprets its command line through the
  // remote shell: a multi-line script passed as an argument does not survive.
  // So the ENVELOPE (payload + step script, base64) is written to a file with
  // a trivial command, and the runner script arrives on stdin of a second,
  // equally trivial command.
  function makeEnvelope(payload) {
    const token = randomUUID();
    const envelopePath = `/tmp/adlc-envelope-${token}.b64`;
    const envelope = [
      Buffer.from(JSON.stringify(payload), "utf-8").toString("base64"),
      Buffer.from(remoteStep(payload.op), "utf-8").toString("base64"),
    ].join("\n") + "\n";
    return { envelopePath, envelope };
  }

  async function writeFailure(name, written, envelopePath) {
    // The envelope write is the only place where "the workspace is gone" can
    // be inferred: it is the coder CLI talking, not the step. Confirm with
    // the provider before giving destructive advice.
    const exists = await workspaceExists(name);
    if (exists === false) {
      // The workspace is gone (deleted out of band, or torn down
      // deliberately by the developer). It is NOT silently re-created: a
      // resurrected workspace would undo the teardown the developer just
      // asked for. The handle is stale and the operator decides next.
      return {
        stdout: written.stdout,
        stderr:
          `${written.stderr}\n` +
          `the workspace '${name}' no longer exists — its handle ` +
          `(.adlc/workspaces/${name}.json) is stale. It was NOT re-created: ` +
          `delete the handle to provision a fresh workspace, or re-provision it deliberately.`,
        exitCode: written.code,
      };
    }
    return {
      stdout: written.stdout,
      stderr: `${written.stderr}\n(failed to write the transport envelope to ${envelopePath})`,
      exitCode: written.code,
    };
  }

  async function openRemote(name, payload) {
    const { envelopePath, envelope } = makeEnvelope(payload);
    // The envelope carries the payload (including the referenced secret
    // values), so it must never be created with the remote shell's default
    // umask. coder ssh joins its argv into a remote command line, so keep this
    // a single, path-only command: the path is an internally generated UUID.
    const written = await runCoder(
      ["ssh", name, "--", `umask 077 && tee ${envelopePath} && chmod 600 ${envelopePath}`],
      { input: envelope, timeoutMs }
    );
    if (written.code !== 0) {
      return { envelopePath, failure: await writeFailure(name, written, envelopePath) };
    }
    return { envelopePath, failure: null };
  }

  async function exec(handle, input, opts = {}) {
    const name = typeof handle === "string" ? handle : handle?.name;
    if (!name) throw new Error("exec requires a workspace name");
    const offset = Number(opts?.offset ?? opts?.fromOffset ?? 0);
    if (offset !== 0) {
      throw new Error(
        "the live SSH transport does not support stream-offset resume; " +
          "use `adlc-cli workflow resume <run_id> --provider coder`"
      );
    }
    const payload = JSON.parse(String(input ?? "{}"));
    const opened = await openRemote(name, payload);
    if (opened.failure) return opened.failure;
    const result = await runCoder(["ssh", name, "--", "sh"], {
      input: remoteRunner(opened.envelopePath),
      timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.code,
    };
  }

  // Streaming variant: stdout lines are yielded as the remote writes them,
  // instead of buffering the whole run and replaying it at exit. The final
  // return value carries the same verdict as exec().
  async function* execStream(handle, input, opts = {}) {
    const name = typeof handle === "string" ? handle : handle?.name;
    if (!name) throw new Error("exec requires a workspace name");
    const offset = Number(opts?.offset ?? opts?.fromOffset ?? 0);
    if (offset !== 0) {
      throw new Error(
        "the live SSH transport does not support stream-offset resume; " +
          "use `adlc-cli workflow resume <run_id> --provider coder`"
      );
    }
    const payload = JSON.parse(String(input ?? "{}"));
    const opened = await openRemote(name, payload);
    if (opened.failure) {
      return { exitCode: opened.failure.exitCode, stderr: opened.failure.stderr };
    }

    const queue = [];
    let partial = "";
    let wake = null;
    let finished = false;
    let result = null;
    const notify = () => {
      if (wake) {
        const resume = wake;
        wake = null;
        resume();
      }
    };
    const onStdout = (chunk) => {
      partial += chunk;
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        if (line !== "") queue.push(line);
      }
      notify();
    };
    const resultPromise = runCoder(["ssh", name, "--", "sh"], {
      input: remoteRunner(opened.envelopePath),
      timeoutMs,
      collectStdout: false,
      onStdout,
    }).then(
      (r) => {
        result = r;
        finished = true;
        notify();
        return r;
      },
      (err) => {
        result = { code: 1, stderr: String(err?.message ?? err) };
        finished = true;
        notify();
        return result;
      }
    );

    while (true) {
      while (queue.length > 0) yield queue.shift();
      if (finished) {
        if (partial !== "") {
          const line = partial;
          partial = "";
          yield line;
          continue;
        }
        await resultPromise;
        return { exitCode: result.code, stderr: result.stderr };
      }
      await new Promise((resolve) => {
        if (queue.length > 0 || finished) resolve();
        else wake = resolve;
      });
    }
  }

  return { provision, exec, execStream };
}

// The runner: read on stdin (so it never passes through a shell command
// line), decode the envelope that was written to a file, run the step.
function remoteRunner(envelopePath) {
  return `
set -u
umask 077 || exit 1
_d=$(mktemp -d) || exit 1
cleanup() { rm -rf "$_d" "${envelopePath}"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
_p=$(sed -n '1p' "${envelopePath}") || {
  echo "adlc: transport envelope is missing or unreadable" >&2
  exit 1
}
_s=$(sed -n '2p' "${envelopePath}") || {
  echo "adlc: transport envelope is missing or truncated" >&2
  exit 1
}
if [ -z "$_p" ] || [ -z "$_s" ]; then
  echo "adlc: transport envelope is missing or truncated" >&2
  exit 1
fi
printf '%s' "$_p" | base64 -d > "$_d/payload.json" || {
  echo "adlc: could not decode the transport payload" >&2
  exit 1
}
printf '%s' "$_s" | base64 -d > "$_d/step.sh" || {
  echo "adlc: could not decode the transport step" >&2
  exit 1
}
if [ ! -s "$_d/payload.json" ] || [ ! -s "$_d/step.sh" ]; then
  echo "adlc: decoded transport payload is empty" >&2
  exit 1
fi
sh "$_d/step.sh" "$_d"
_rc=$?
exit "$_rc"
`;
}

// The per-op step script. It receives the payload directory as $1 and
// returns the remote exit code.
function remoteStep(op) {
  const prelude = `
set -u
umask 077 || exit 1
_d="$1"
_op=$(jq -r '.op // empty' "$_d/payload.json")
_export_vars() { jq -r '(.vars // {}) | to_entries[] | "export \\(.key)=\\(.value | @sh)"' "$_d/payload.json" > "$_d/vars.sh"; . "$_d/vars.sh"; }
# workspace setup records the cloned repo's relative path. Agent/workflow
# steps run there, not in the remote user's home directory.
_workspace_root() {
  _root=""
  if [ -f "$HOME/.adlc/workspace-root" ]; then
    _root=$(cat "$HOME/.adlc/workspace-root" 2>/dev/null || true)
    case "$_root" in
      ""|/*|..|../*|*/..|*/../*) _root="" ;;
    esac
  fi
  if [ -n "$_root" ] && [ -d "$HOME/$_root" ]; then
    printf '%s\\n' "$HOME/$_root"
  else
    printf '%s\\n' "$HOME"
  fi
}
# The hop counter must cross the transport boundary: a step that starts
# another provider run has to inherit this depth or the recursion guard
# resets to zero on every hop.
_hop=$(jq -r '.env.ADLC_HOP_DEPTH // empty' "$_d/payload.json")
if [ -n "$_hop" ]; then
  export ADLC_HOP_DEPTH="$_hop"
fi
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
  // Rebuild an argv array from the payload's JSON string array. Base64 keeps
  // each argument opaque, so a value with spaces, leading dashes, or embedded
  // newlines can never be re-split or synthesize another flag.
  const decodedArgs = `
    jq -r '(.args // [])[] | @base64' "$_d/payload.json" > "$_d/args.b64" || exit 1
    set --
    while IFS= read -r _encoded; do
      if ! printf '%s' "$_encoded" | base64 -d > "$_d/arg.bin"; then
        echo "adlc: could not decode payload args" >&2
        exit 1
      fi
      _arg=$(cat "$_d/arg.bin"; printf x)
      _arg=\${_arg%x}
      set -- "$@" "$_arg"
    done < "$_d/args.b64"
`;
  switch (op) {
    case "workspace.setup":
      return `${prelude}  workspace.setup)
    # Prefer the parsed config object (JSON) over raw YAML: expanding raw YAML
    # text lets a process-env value inject new keys into the document.
    _wsfile="$_d/workspace.yml"
    if jq -e '.config != null' "$_d/payload.json" >/dev/null 2>&1; then
      jq -c '.config' "$_d/payload.json" > "$_d/workspace.json" || exit 1
      _wsfile="$_d/workspace.json"
    else
      jq -r '.configYaml // empty' "$_d/payload.json" > "$_d/workspace.yml" || exit 1
    fi
    _export_vars
    _secret_keys=$(jq -r '(.secretKeys // []) | join(" ")' "$_d/payload.json")
    if [ -n "$_secret_keys" ]; then export ADLC_SECRET_KEYS="$_secret_keys"; fi
    # The developer's LATER session (a separate shell) must inherit the same
    # env the transport used: persist the referenced vars 0600 for the session
    # to source. Values stay in the workspace's env — never in a command line.
    mkdir -p "$HOME/.adlc" || exit 1
    # Make the destination private BEFORE writing secrets. umask covers a new
    # file; chmod also covers a file left behind by an older version. Fail
    # closed: a mode we cannot enforce must not leave the secret at rest.
    : > "$HOME/.adlc/secrets.env" || exit 1
    chmod 600 "$HOME/.adlc/secrets.env" || exit 1
    jq -r '(.vars // {}) | to_entries[] | "export \\(.key)=\\(.value | @sh)"' \
      "$_d/payload.json" > "$HOME/.adlc/secrets.env" || exit 1
    chmod 600 "$HOME/.adlc/secrets.env" || exit 1
${decodedArgs}
    adlc-cli workspace setup "$_wsfile" "$@"
    _rc=$?
    if [ "$_rc" -eq 0 ]; then
      _root=$(jq -r '(.config.workspace.git // [])[0].path // empty' "$_d/payload.json" 2>/dev/null || true)
      case "$_root" in
        ""|/*|..|../*|*/..|*/../*) ;;
        *) printf '%s\\n' "$_root" > "$HOME/.adlc/workspace-root" ;;
      esac
    fi
    ;;${tail}`;
    case "agent.run":
      return `${prelude}  agent.run)
    _export_vars
${decodedArgs}
    _root=$(_workspace_root)
    cd "$_root" || exit 1
    # payload.args carries the same argv the local route received (flags and
    # task). Older payloads only have task; keep that form working.
    if [ "$#" -gt 0 ]; then
      adlc-cli agent run "$@"
    else
      _task=$(jq -r '.task // empty' "$_d/payload.json")
      adlc-cli agent run "$_task"
    fi
    _rc=$?
    ;;${tail}`;
    case "workflow.run":
      return `${prelude}  workflow.run)
    _export_vars
    _source=$(jq -r '.source // empty' "$_d/payload.json")
${decodedArgs}
    _root=$(_workspace_root)
    cd "$_root" || exit 1
    # Add inputs to the same argv array. One base64-encoded pair per line keeps
    # spaces, leading dashes, and embedded newlines inside a single argument
    # (a plain line-based split would let a newline synthesize another flag).
    jq -r '(.inputs // {}) | to_entries[] | "\\(.key)=\\(.value)" | @base64' \
      "$_d/payload.json" > "$_d/inputs.b64"
    while IFS= read -r _encoded; do
      # base64 -d adds no newline of its own; the trailing sentinel keeps
      # command substitution from stripping a newline that is part of the value.
      _pair=$(printf '%s' "$_encoded" | base64 -d; printf x)
      _pair=\${_pair%x}
      set -- "$@" "--input" "$_pair"
    done < "$_d/inputs.b64"
    adlc-cli workflow run "$_source" "$@"
    _rc=$?
    ;;${tail}`;
    case "workflow.resume":
      return `${prelude}  workflow.resume)
    _export_vars
    _run_id=$(jq -r '.runId // empty' "$_d/payload.json")
    if [ -z "$_run_id" ]; then
      echo "adlc: workflow resume is missing its run id" >&2
      exit 1
    fi
${decodedArgs}
    _root=$(_workspace_root)
    cd "$_root" || exit 1
    jq -r '(.inputs // {}) | to_entries[] | "\\(.key)=\\(.value)" | @base64' \
      "$_d/payload.json" > "$_d/inputs.b64"
    while IFS= read -r _encoded; do
      _pair=$(printf '%s' "$_encoded" | base64 -d; printf x)
      _pair=\${_pair%x}
      set -- "$@" "--input" "$_pair"
    done < "$_d/inputs.b64"
    adlc-cli workflow resume "$_run_id" "$@"
    _rc=$?
    ;;${tail}`;
    default:
      return `${prelude}  *)
  echo "adlc: unsupported op '$_op'" >&2
  _rc=2
  ;;${tail}`;
  }
}
