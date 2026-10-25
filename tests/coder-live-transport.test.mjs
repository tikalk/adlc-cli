// Contract tests for the live coder SSH transport.
//
// The `coder` CLI is faked (a script on PATH) so the transport's behaviour —
// provisioning, waiting for a running workspace, the stdin envelope, the
// exit-code propagation, and the secret discipline — is verifiable offline.
// SKIPPED on Windows: relies on bash script faking `coder` CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoderSshTransport } from "../src/providers/coder/ssh.mjs";
import { createCoderProvider } from "../src/providers/coder/handle.mjs";

if (process.platform === "win32") {
  // eslint-disable-next-line no-console
  console.log("# SKIP: coder-live-transport.test.mjs skipped on Windows (bash fake coder CLI)");
  process.exit(0);
}

/** A fake `coder` CLI. `record` collects what the transport asked for. */
function fakeCoder(
  dir,
  {
    status = "running",
    sshExit = 0,
    sshStderr = "",
    sshStdout = "",
    sshStdout2 = "",
    sshNoStdin = false,
    sshDelayMs = "",
    stepExit = null,
    stepStderr = "",
    listWorkspaces = null,
  } = {}
) {
  const record = { creates: [], shows: [], ssh: [], stdin: [] };
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "coder");
  const listBody = JSON.stringify(
    listWorkspaces ?? [{ name: "demo", latest_build: { status } }]
  );
  writeFileSync(script, `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  create)
    echo "create $*" >> "$FAKE_CODER_RECORD"
    touch "$FAKE_CODER_RECORD.created"
    exit 0 ;;
  list)
    echo "list $*" >> "$FAKE_CODER_RECORD"
    printf '%s' '${listBody}'
    exit 0 ;;
  ssh)
    shift
    echo "ssh $*" >> "$FAKE_CODER_RECORD"
    _n=$(cat "$FAKE_CODER_RECORD.ssh" 2>/dev/null || echo 0)
    _n=$((_n + 1))
    echo "$_n" > "$FAKE_CODER_RECORD.ssh"
    if [ -n "\${FAKE_CODER_SSH_NO_STDIN:-}" ]; then
      printf '%s' '${sshStderr}' >&2
      exit ${sshExit}
    fi
    cat >> "$FAKE_CODER_STDIN"
    if [ -n "\${FAKE_CODER_STEP_EXIT:-}" ] && [ "$_n" -ge 2 ]; then
      printf '%s' "\${FAKE_CODER_STEP_STDERR:-}" >&2
      exit "$FAKE_CODER_STEP_EXIT"
    fi
    printf '%s' '${sshStdout}'
    if [ "$_n" -ge 2 ] && [ -n "\${FAKE_CODER_SSH_DELAY_MS:-}" ]; then
      sleep "\${FAKE_CODER_SSH_DELAY_MS}"
    fi
    printf '%s' '${sshStdout2}'
    printf '%s' '${sshStderr}' >&2
    exit ${sshExit} ;;
  *)
    echo "unexpected coder invocation: $*" >&2
    exit 9 ;;
esac
`);
  chmodSync(script, 0o755);
  const recordFile = join(dir, "record.txt");
  const stdinFile = join(dir, "stdin.txt");
  writeFileSync(recordFile, "");
  writeFileSync(stdinFile, "");
  record.recordFile = recordFile;
  record.stdinFile = stdinFile;
  return { bin, recordFile, stdinFile, record };
}

// The PATH holds ONLY the fake bin (+ the system dirs the fake needs), so a
// missing fake can never fall through to the real coder CLI.
async function withFakeCoder(options, fn) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-live-"));
  const { bin, recordFile, stdinFile, record } = fakeCoder(dir, options);
  const prevPath = process.env.PATH;
  const prevRecord = process.env.FAKE_CODER_RECORD;
  const prevStdin = process.env.FAKE_CODER_STDIN;
  const extraEnv = {
    FAKE_CODER_STEP_EXIT: options?.stepExit,
    FAKE_CODER_STEP_STDERR: options?.stepStderr,
    FAKE_CODER_SSH_NO_STDIN: options?.sshNoStdin ? "1" : undefined,
    FAKE_CODER_SSH_DELAY_MS: options?.sshDelayMs,
  };
  const prevExtra = {};
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.FAKE_CODER_RECORD = recordFile;
  process.env.FAKE_CODER_STDIN = stdinFile;
  for (const [key, value] of Object.entries(extraEnv)) {
    prevExtra[key] = process.env[key];
    if (value === undefined || value === null || value === "") delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn(record);
  } finally {
    process.env.PATH = prevPath;
    if (prevRecord === undefined) delete process.env.FAKE_CODER_RECORD;
    else process.env.FAKE_CODER_RECORD = prevRecord;
    if (prevStdin === undefined) delete process.env.FAKE_CODER_STDIN;
    else process.env.FAKE_CODER_STDIN = prevStdin;
    for (const [key, value] of Object.entries(prevExtra)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("live transport: provisions the workspace and waits for it to run", async () => {
  await withFakeCoder({ status: "running" }, async (record) => {
    const transport = createCoderSshTransport({ pollMs: 10 });
    const handle = await transport.provision("demo");
    assert.equal(handle.name, "demo");
    assert.equal(handle.host, "demo.main");
    const calls = readFileSync(record.recordFile, "utf-8");
    assert.match(calls, /create demo --template general --use-parameter-defaults --yes/);
    assert.match(calls, /list --all -o json/);
  });
});

test("live transport: a workspace that never runs fails loudly (no silent success)", async () => {
  await withFakeCoder({ status: "starting" }, async () => {
    const transport = createCoderSshTransport({ pollMs: 10, timeoutMs: 60 });
    await assert.rejects(
      () => transport.provision("demo"),
      /did not reach a running state/i
    );
  });
});

test("live transport: the payload travels on stdin, the secret never in argv", async () => {
  await withFakeCoder({ sshStdout: "remote said hi\n" }, async (record) => {
    const transport = createCoderSshTransport();
    const payload = {
      op: "agent.run",
      task: "deploy the thing",
      vars: { MY_API_TOKEN: "tok-secret-999" },
      env: { ADLC_HOP_DEPTH: "1" },
      hop: 1,
    };
    const result = await transport.exec(
      { name: "demo" },
      JSON.stringify(payload)
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /remote said hi/);
    // The secret is NOT in the command line...
    const calls = readFileSync(record.recordFile, "utf-8");
    assert.ok(!calls.includes("tok-secret-999"), "a secret must never appear in argv");
    // ...it is in the stdin envelope, base64-encoded.
    const envelope = readFileSync(record.stdinFile, "utf-8").trim().split("\n")[0];
    const decoded = JSON.parse(Buffer.from(envelope, "base64").toString("utf-8"));
    assert.equal(decoded.vars.MY_API_TOKEN, "tok-secret-999");
    assert.equal(decoded.task, "deploy the thing");
  });
});

test("live transport: the step script is op-specific and travels in the envelope", async () => {
  await withFakeCoder({}, async (record) => {
    const transport = createCoderSshTransport();
    await transport.exec({ name: "demo" }, JSON.stringify({ op: "workspace.setup", configYaml: "schema_version: 1\n" }));
    await transport.exec({ name: "demo" }, JSON.stringify({ op: "workflow.run", source: "factory", inputs: { run_id: "r-7" } }));
    // The remote command lines are trivial (tee / sh) — the per-op script
    // travels in the envelope, because `coder ssh` re-interprets its
    // command line through the remote shell.
    const calls = readFileSync(record.recordFile, "utf-8");
    assert.ok(!calls.includes("adlc-cli workspace setup"), "the step script must not be in argv");
    assert.match(calls, /tee \/tmp\/adlc-envelope-/);
    const chunks = readFileSync(record.stdinFile, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return Buffer.from(line, "base64").toString("utf-8");
        } catch {
          return "";
        }
      });
    const all = chunks.join("\n");
    assert.match(all, /"op":"workspace.setup"/);
    assert.match(all, /adlc-cli workspace setup/);
    assert.match(all, /adlc-cli workflow run/);
    assert.match(all, /--input/);
  });
});

test("live transport: a failing remote step propagates its exit code and stderr", async () => {
  await withFakeCoder(
    { stepExit: 7, stepStderr: "fatal: clone failed\n" },
    async () => {
      const transport = createCoderSshTransport();
      const result = await transport.exec(
        { name: "demo" },
        JSON.stringify({ op: "agent.run", task: "x" })
      );
      assert.equal(result.exitCode, 7, "the remote's exit code must be propagated");
      assert.match(result.stderr, /fatal: clone failed/);
    }
  );
});

test("live transport: the transport file exists and exports the factory", () => {
  assert.ok(existsSync(join(process.cwd(), "src/providers/coder/ssh.mjs")));
});

test("live transport: the referenced vars are persisted for the developer's later session", async () => {
  await withFakeCoder({}, async (record) => {
    const transport = createCoderSshTransport();
    await transport.exec(
      { name: "demo" },
      JSON.stringify({ op: "workspace.setup", configYaml: "schema_version: 1\n", vars: { GITLAB_TOKEN: "tok-1" } })
    );
    const chunks = readFileSync(record.stdinFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return Buffer.from(l, "base64").toString("utf-8");
        } catch {
          return "";
        }
      });
    const step = chunks.join("\n");
    assert.match(step, /secrets\.env/, "the step must persist the vars for the session");
    assert.match(step, /chmod 600/, "the persisted vars file must be 0600");
  });
});

const hasJq = spawnSync("jq", ["--version"], { encoding: "utf-8" }).status === 0;
const needsJq = hasJq ? false : "jq is required to execute the generated remote step";

function decodeEnvelope(stdinFile) {
  const lines = readFileSync(stdinFile, "utf-8").split("\n");
  return {
    payload: JSON.parse(Buffer.from(lines[0], "base64").toString("utf-8")),
    step: Buffer.from(lines[1], "base64").toString("utf-8"),
  };
}

// Execute the generated remote step locally with a stub adlc-cli. This
// exercises the shell contract (argv, env) rather than only grepping source.
function runGeneratedStep(step, payload) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-step-"));
  const bin = join(dir, "bin");
  const remote = join(dir, "remote");
  mkdirSync(bin, { recursive: true });
  mkdirSync(remote, { recursive: true });
  const stub = join(bin, "adlc-cli");
  writeFileSync(
    stub,
    `#!/usr/bin/env sh
jq -n --arg hop "\${ADLC_HOP_DEPTH:-unset}" --args '{hop:$hop, args:$ARGS.positional}' -- "$@"
`
  );
  chmodSync(stub, 0o755);
  const stepPath = join(remote, "step.sh");
  writeFileSync(stepPath, step);
  writeFileSync(join(remote, "payload.json"), JSON.stringify(payload));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.ADLC_HOP_DEPTH;
  try {
    const r = spawnSync("sh", [stepPath, remote], { encoding: "utf-8", env });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("live transport: an early-exiting child reports its verdict instead of crashing on EPIPE", async () => {
  await withFakeCoder(
    { sshNoStdin: true, sshExit: 3, sshStderr: "auth failed before stdin\n" },
    async () => {
      const transport = createCoderSshTransport();
      // > the 64 KiB pipe buffer, the threshold from the review.
      const result = await transport.exec(
        { name: "demo" },
        JSON.stringify({ op: "agent.run", task: "x".repeat(200 * 1024), vars: {} })
      );
      assert.equal(result.exitCode, 3, "the child's exit code must survive the EPIPE");
      assert.match(result.stderr, /auth failed before stdin/);
      assert.ok(!/stale|no longer exists/i.test(result.stderr));
    }
  );
});

test("live transport: provider runStream yields the first line before the remote exits", async () => {
  await withFakeCoder(
    { sshStdout: "first-line\n", sshStdout2: "second-line\n", sshDelayMs: "0.6" },
    async () => {
      const provider = createCoderProvider({
        transport: createCoderSshTransport(),
        workspacesDir: join(tmpdir(), "adlc-stream-ws"),
      });
      const started = Date.now();
      const iter = provider.runStream(
        { name: "demo" },
        JSON.stringify({ op: "agent.run", task: "stream", vars: {} })
      );
      const first = await iter.next();
      const firstMs = Date.now() - started;
      assert.equal(first.done, false);
      assert.equal(first.value, "first-line");
      assert.ok(
        firstMs < 500,
        `runStream buffered the first line for ${firstMs}ms instead of streaming it`
      );
      const second = await iter.next();
      assert.equal(second.value, "second-line");
      const done = await iter.next();
      assert.equal(done.done, true);
      assert.equal(done.value.exitCode, 0);
    }
  );
});

test("live transport: a step's 'not found' is a step failure, never a stale handle", async () => {
  await withFakeCoder(
    { stepExit: 127, stepStderr: "sh: adlc-cli: not found\n" },
    async (record) => {
      const transport = createCoderSshTransport();
      const result = await transport.exec(
        { name: "demo" },
        JSON.stringify({ op: "agent.run", task: "x", vars: {} })
      );
      assert.equal(result.exitCode, 127);
      assert.match(result.stderr, /not found/);
      assert.ok(
        !/stale|no longer exists/i.test(result.stderr),
        `a missing binary must not delete a healthy handle: ${result.stderr}`
      );
      const calls = readFileSync(record.recordFile, "utf-8");
      assert.ok(!/\blist\b/.test(calls), "a step failure must not trigger a provider lookup");
    }
  );
});

test("live transport: a coder ssh write failure is not stale when the provider confirms the workspace", async () => {
  await withFakeCoder(
    {
      sshNoStdin: true,
      sshExit: 1,
      sshStderr: "Resource not found or you do not have access to this resource",
      listWorkspaces: [{ name: "demo", latest_build: { status: "running" } }],
    },
    async () => {
      const transport = createCoderSshTransport();
      const result = await transport.exec(
        { name: "demo" },
        JSON.stringify({ op: "agent.run", task: "x", vars: {} })
      );
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /failed to write the transport envelope/);
      assert.ok(
        !/stale|no longer exists/i.test(result.stderr),
        `an existing workspace must not be called stale: ${result.stderr}`
      );
    }
  );
});

test("live transport: a deleted workspace is confirmed with the provider, never silently re-created", async () => {
  await withFakeCoder(
    {
      sshNoStdin: true,
      sshExit: 1,
      sshStderr: "Resource not found or you do not have access to this resource",
      listWorkspaces: [],
    },
    async (record) => {
      const transport = createCoderSshTransport({ pollMs: 10 });
      const result = await transport.exec(
        { name: "demo" },
        JSON.stringify({ op: "agent.run", task: "x", vars: {} })
      );
      assert.notEqual(result.exitCode, 0, "a missing workspace is a failure, not a success");
      assert.match(result.stderr, /was NOT re-created/i);
      assert.match(result.stderr, /stale/i);
      const calls = readFileSync(record.recordFile, "utf-8");
      assert.match(calls, /list --all -o json/, "the provider lookup must confirm the workspace is gone");
      assert.ok(
        !/create demo/.test(calls),
        "a deliberately torn-down workspace must never be resurrected"
      );
    }
  );
});

test("live transport: workflow --input keeps spaces, leading dashes, and newlines in one argv entry", { skip: needsJq }, async () => {
  await withFakeCoder({}, async (record) => {
    const transport = createCoderSshTransport();
    const injected = "do\n--provider\ncoder\n";
    const payload = {
      op: "workflow.run",
      source: "factory",
      inputs: { goal: "do the thing", note: "-leading-dash", inject: injected },
      vars: {},
      env: { ADLC_HOP_DEPTH: "2" },
      hop: 2,
    };
    await transport.exec({ name: "demo" }, JSON.stringify(payload));
    const decoded = decodeEnvelope(record.stdinFile);
    assert.equal(decoded.payload.inputs.goal, "do the thing");

    const r = runGeneratedStep(decoded.step, decoded.payload);
    assert.equal(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.hop, "2", "the remote step must export payload.env.ADLC_HOP_DEPTH");
    assert.deepEqual(
      parsed.args,
      [
        "workflow",
        "run",
        "factory",
        "--input",
        "goal=do the thing",
        "--input",
        "note=-leading-dash",
        "--input",
        `inject=${injected}`,
      ],
      `the remote argv was re-split: ${r.stdout}`
    );
    assert.equal(
      parsed.args.filter((arg) => arg === "--provider").length,
      0,
      "an input value must not be able to synthesize another flag"
    );
  });
});
