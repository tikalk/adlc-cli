// Contract tests for the live coder SSH transport.
//
// The `coder` CLI is faked (a script on PATH) so the transport's behaviour —
// provisioning, waiting for a running workspace, the stdin envelope, the
// exit-code propagation, and the secret discipline — is verifiable offline.
// SKIPPED on Windows: relies on bash script faking `coder` CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCoderSshTransport } from "../src/providers/coder-ssh.mjs";

if (process.platform === "win32") {
  // eslint-disable-next-line no-console
  console.log("# SKIP: coder-live-transport.test.mjs skipped on Windows (bash fake coder CLI)");
  process.exit(0);
}

/** A fake `coder` CLI. `record` collects what the transport asked for. */
function fakeCoder(dir, { status = "running", sshExit = 0, sshStderr = "", sshStdout = "" } = {}) {
  const record = { creates: [], shows: [], ssh: [], stdin: [] };
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "coder");
  writeFileSync(script, `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  create)
    echo "create $*" >> "$FAKE_CODER_RECORD"
    touch "$FAKE_CODER_RECORD.created"
    exit 0 ;;
  list)
    echo "list $*" >> "$FAKE_CODER_RECORD"
    printf '%s' '${JSON.stringify([{ name: "demo", latest_build: { status } }])}'
    exit 0 ;;
  ssh)
    shift
    echo "ssh $*" >> "$FAKE_CODER_RECORD"
    cat >> "$FAKE_CODER_STDIN"
    printf '%s' '${sshStdout}'
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
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  process.env.FAKE_CODER_RECORD = recordFile;
  process.env.FAKE_CODER_STDIN = stdinFile;
  try {
    return await fn(record);
  } finally {
    process.env.PATH = prevPath;
    if (prevRecord === undefined) delete process.env.FAKE_CODER_RECORD;
    else process.env.FAKE_CODER_RECORD = prevRecord;
    if (prevStdin === undefined) delete process.env.FAKE_CODER_STDIN;
    else process.env.FAKE_CODER_STDIN = prevStdin;
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

test("live transport: a failing remote propagates its exit code and stderr", async () => {
  await withFakeCoder({ sshExit: 7, sshStderr: "fatal: clone failed\n" }, async () => {
    const transport = createCoderSshTransport();
    const result = await transport.exec({ name: "demo" }, JSON.stringify({ op: "agent.run", task: "x" }));
    assert.equal(result.exitCode, 7, "the remote's exit code must be propagated");
    assert.match(result.stderr, /fatal: clone failed/);
  });
});

test("live transport: the transport file exists and exports the factory", () => {
  assert.ok(existsSync(join(process.cwd(), "src/providers/coder-ssh.mjs")));
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

test("live transport: a deleted workspace is reported, never silently re-created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-gone-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const recordFile = join(dir, "record.txt");
  const script = join(bin, "coder");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  create)
    echo "create $*" >> "$FAKE_CODER_RECORD"
    exit 0 ;;
  list)
    printf '%s' '[{"name":"demo","latest_build":{"status":"running"}}]'
    exit 0 ;;
  ssh)
    shift
    cat >> "$FAKE_CODER_STDIN"
    echo "Resource not found or you do not have access to this resource" >&2
    exit 1 ;;
  *) exit 0 ;;
esac
`
  );
  chmodSync(script, 0o755);
  writeFileSync(recordFile, "");
  const prevPath = process.env.PATH;
  const prevRecord = process.env.FAKE_CODER_RECORD;
  process.env.PATH = `${bin}:${prevPath}`;
  process.env.FAKE_CODER_RECORD = recordFile;
  try {
    const transport = createCoderSshTransport({ pollMs: 10 });
    const result = await transport.exec(
      { name: "demo" },
      JSON.stringify({ op: "agent.run", task: "x", vars: {} })
    );
    assert.notEqual(result.exitCode, 0, "a missing workspace is a failure, not a success");
    assert.match(result.stderr, /was NOT re-created/i);
    assert.match(result.stderr, /stale/i);
    const calls = readFileSync(recordFile, "utf-8");
    assert.ok(
      !/create demo/.test(calls),
      "a deliberately torn-down workspace must never be resurrected"
    );
  } finally {
    process.env.PATH = prevPath;
    if (prevRecord === undefined) delete process.env.FAKE_CODER_RECORD;
    else process.env.FAKE_CODER_RECORD = prevRecord;
  }
});
