import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateWorkspaceConfig, expandWorkspaceVars, normalizeEvent, checkHopDepth, MAX_HOPS } from "../src/providers/transport.mjs";
import { createCoderProvider } from "../src/providers/coder.mjs";

const exec = promisify(execFile);
const runCli = (args) =>
  exec(process.execPath, ["bin/adlc-cli.mjs", ...args]).catch((e) => e);

function fakeTransport(overrides = {}) {
  return {
    provisionCalls: 0,
    async provision(name) {
      this.provisionCalls += 1;
      return { name, host: `mock-${name}`, handlePath: `.adlc/workspaces/${name}.json` };
    },
    async exec(handle, input) {
      return { stdout: input, stderr: "", exitCode: 0 };
    },
    ...overrides,
  };
}

test("workspace.yml with provider: key is rejected, not ignored", () => {
  assert.throws(
    () => validateWorkspaceConfig({ name: "demo", provider: "coder" }),
    /provider/
  );
});

test("missing ${VAR} in workspace file fails fast and names the var", () => {
  assert.throws(
    () => expandWorkspaceVars({ image: "app:${MISSING_VAR_42}" }, {}),
    /MISSING_VAR_42/
  );
});

test("transport interface exposes provision, exec streaming, and handle path", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const tmp = await import("node:fs/promises").then((m) => m.mkdtemp(path.join(os.tmpdir(), "adlc-iface-")));
  const transport = fakeTransport();
  const provider = createCoderProvider({ transport, workspacesDir: path.join(tmp, "workspaces") });
  assert.equal(typeof provider.provision, "function");
  assert.equal(typeof provider.run, "function");
  const handle = await provider.provision("demo");
  assert.match(handle.handlePath, /demo\.json/);
  const res = await provider.run(handle, "hello-stdin");
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, /hello-stdin/);
});

test("remote-vs-local JSONL event shapes identical modulo timestamps", () => {
  const local = [
    { type: "run_started", ts: "2026-01-01T00:00:00Z", run: "r1" },
    { type: "step_started", ts: "2026-01-01T00:00:01Z", step: "s1" },
    { type: "step_completed", ts: "2026-01-01T00:00:02Z", step: "s1" },
    { type: "run_completed", ts: "2026-01-01T00:00:03Z", run: "r1" },
  ];
  const remote = [
    { type: "run_started", ts: "2026-06-06T06:06:06Z", run: "r1" },
    { type: "step_started", ts: "2026-06-06T06:06:07Z", step: "s1" },
    { type: "step_completed", ts: "2026-06-06T06:06:08Z", step: "s1" },
    { type: "run_completed", ts: "2026-06-06T06:06:09Z", run: "r1" },
  ];
  assert.deepEqual(local.map(normalizeEvent), remote.map(normalizeEvent));
});

test("coder adapter reuses existing machine on repeat, second provision skipped", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const tmp = await import("node:fs/promises").then((m) => m.mkdtemp(path.join(os.tmpdir(), "adlc-reuse-")));
  const transport = fakeTransport();
  const provider = createCoderProvider({ transport, workspacesDir: path.join(tmp, "workspaces") });
  await provider.provision("demo");
  await provider.provision("demo");
  assert.equal(transport.provisionCalls, 1);
});

test("recursion guard refuses more than 2 hops", () => {
  assert.equal(MAX_HOPS, 2);
  assert.throws(() => checkHopDepth(3), /hop/i);
  assert.doesNotThrow(() => checkHopDepth(2));
});

test("factory setup --provider keeps tracker values github/gitlab/linear/jira", async () => {
  for (const p of ["github", "gitlab", "linear", "jira"]) {
    const r = await runCli(["factory", "setup", "--provider", p, "-a", "nonexistent-agent"]);
    assert.match(String(r.stderr ?? r.stdout ?? r.message ?? ""), /Unsupported agent|factory-setup skill not installed|Agent required/i);
  }
});

test("factory setup --provider rejects unknown tracker value", async () => {
  const r = await runCli(["factory", "setup", "--provider", "bogus", "-a", "nonexistent-agent"]);
  assert.equal(r.code ?? r.exitCode, 1);
  assert.match(String(r.stderr ?? r.stdout ?? r.message ?? ""), /--provider must be one of/);
});

test("handle persists to .adlc/workspaces/<name>.json; second instance skips provisioning", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { existsSync, readFileSync } = await import("node:fs");
  const tmp = await import("node:fs/promises").then((m) => m.mkdtemp(path.join(os.tmpdir(), "adlc-prov-")));
  const workspacesDir = path.join(tmp, ".adlc", "workspaces");
  const transport = fakeTransport();
  const provider1 = createCoderProvider({ transport, workspacesDir });
  const h1 = await provider1.provision("demo42");
  assert.match(h1.handlePath, /demo42\.json/);
  assert.ok(existsSync(path.join(workspacesDir, "demo42.json")), `handle file must exist at ${workspacesDir}/demo42.json`);
  const saved = JSON.parse(readFileSync(path.join(workspacesDir, "demo42.json"), "utf-8"));
  assert.match(String(saved.host ?? ""), /mock-demo42/);
  const provider2 = createCoderProvider({ transport, workspacesDir });
  const h2 = await provider2.provision("demo42");
  assert.deepEqual(h2, h1);
  assert.equal(transport.provisionCalls, 1, "second provider instance with same dir must SKIP provisioning (read handle)");
});

test("redactSecrets redacts secret-shaped values without mutating original", async () => {
  const m = await import("../src/providers/transport.mjs");
  assert.equal(typeof m.redactSecrets, "function", "transport must export redactSecrets (FAIL: no redaction)");
  const input = { user: "amy", apiToken: "sek-123", nested: { db_password: "pw", normal: "ok" }, API_KEY: "k" };
  const out = m.redactSecrets(input);
  assert.notEqual(out, input);
  assert.equal(out.user, "amy");
  assert.equal(out.nested.normal, "ok");
  assert.ok(!String(out.apiToken).includes("sek-123"), "token value must be redacted");
  assert.ok(!String(out.nested.db_password).includes("pw"), "password value must be redacted");
  assert.equal(input.apiToken, "sek-123", "must return redacted copy, not mutate");
});

test("workspace var expansion forwards only referenced vars", async () => {
  const m = await import("../src/providers/transport.mjs");
  assert.equal(typeof m.collectReferencedVars ?? typeof m.expandWorkspaceVarsWithRefs, "function", "transport must export referenced-var tracking (FAIL: expansion leaks env)");
  const collect = m.collectReferencedVars ?? m.expandWorkspaceVarsWithRefs;
  const cfg = { image: "app:${USED_VAR}", other: "plain" };
  const env = { USED_VAR: "v1", UNUSED_SECRET_TOKEN: "sek" };
  const res = collect(cfg, env);
  const refs = Array.isArray(res) ? res : (res.referenced ?? res.refs ?? res.used);
  assert.ok(refs.includes("USED_VAR"));
  assert.ok(!refs.includes("UNUSED_SECRET_TOKEN"), "must forward only referenced vars");
});

test("resumeRun resumes after machine loss mid-stream (mock-level, no real git)", async () => {
  const m = await import("../src/providers/transport.mjs").catch(() => ({}));
  const cm = await import("../src/providers/coder.mjs").catch(() => ({}));
  const resume = m.resumeRun ?? m.replayStream ?? cm.resumeRun ?? cm.resume;
  assert.equal(typeof resume, "function", "must export resumeRun/stream-replay helper (FAIL: no resume)");
  let calls = 0;
  const flaky = {
    async exec(handle, input, { offset = 0 } = {}) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("machine lost mid-stream"), { code: "MACHINE_LOST", offset: 2 });
      return { stdout: `resumed-from-2:${input}`, stderr: "", exitCode: 0, resumedFrom: 2 };
    },
  };
  const out = await resume(flaky, { name: "demo" }, "payload", { fromOffset: 2 });
  assert.match(String(out.stdout ?? ""), /resumed-from-2/);
  assert.equal(calls, 2);
});

test("JSONL events stream through transport exec identical modulo timestamps (not echo-only)", async () => {
  const events = [
    { type: "run_started", ts: "2026-01-01T00:00:00Z", run: "r1" },
    { type: "step_started", ts: "2026-01-01T00:00:01Z", step: "s1" },
    { type: "run_completed", ts: "2026-01-01T00:00:02Z", run: "r1" },
  ];
  const input = events.map((e) => JSON.stringify(e)).join("\n");
  const shifting = fakeTransport({
    async exec(handle, raw) {
      const lines = String(raw).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const shifted = lines.map((e, i) => ({ ...e, ts: `2099-01-01T00:00:${String(i).padStart(2, "0")}Z` }));
      return { stdout: shifted.map((e) => JSON.stringify(e)).join("\n"), stderr: "", exitCode: 0 };
    },
  });
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const tmp = await import("node:fs/promises").then((m) => m.mkdtemp(path.join(os.tmpdir(), "adlc-stream-")));
  const provider = createCoderProvider({ transport: shifting, workspacesDir: path.join(tmp, "workspaces") });
  assert.equal(typeof provider.runStream, "function", "provider must expose streaming run (FAIL: echo-only)");
  const chunks = [];
  for await (const line of provider.runStream({ name: "demo" }, input)) chunks.push(line);
  const got = chunks.join("\n").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(got.map(normalizeEvent), events.map(normalizeEvent));
});

test("CLI wiring: --provider coder routes workspace/agent/workflow to provider path", async () => {
  const { dispatch } = await import("../src/dispatch.mjs");
  assert.equal(typeof dispatch, "function");
  async function capture(fn) {
    const err = [];
    const origErr = console.error;
    const origLog = console.log;
    console.error = (...a) => { err.push(a.join(" ")); };
    console.log = (...a) => { err.push(a.join(" ")); };
    try { await fn(); } finally { console.error = origErr; console.log = origLog; }
    return err.join("\n");
  }
  const ws = await capture(() => dispatch(["workspace", "setup", "--provider", "coder"], "cli"));
  assert.match(ws, /provider|coder/i, "workspace setup --provider coder must route to provider path (FAIL: no wiring)");
  const ar = await capture(() => dispatch(["agent", "run", "--provider", "coder", "-a", "nonexistent-agent", "hi"], "cli"));
  assert.match(ar, /provider|coder/i, "agent run --provider coder must route to provider path (FAIL: no wiring)");
  const wr = await capture(() => dispatch(["workflow", "run", "--provider", "coder"], "cli"));
  assert.match(wr, /provider|coder/i, "workflow run --provider coder must route to provider path (FAIL: no wiring)");
  const tr = await runCli(["factory", "setup", "--provider", "github", "-a", "nonexistent-agent"]);
  assert.match(String(tr.stderr ?? tr.stdout ?? tr.message ?? ""), /Unsupported agent|factory-setup skill not installed|Agent required/i, "factory setup --provider github must stay tracker path");
});

test("review fix: --provider=coder equals-form routes to provider path", async () => {
  const { dispatch } = await import("../src/dispatch.mjs");
  const err = [];
  const logs = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => { err.push(a.join(" ")); };
  console.log = (...a) => { logs.push(a.join(" ")); };
  try { await dispatch(["agent", "run", "--provider=coder", "-a", "nonexistent-agent", "hi"], "cli"); } finally { console.error = origErr; console.log = origLog; }
  assert.match(err.join("\n"), /provider path: coder agent/i, "equals-form must route to coder provider path");
  assert.ok(!logs.join("\n").includes("provider path"), "stdout must stay pure JSONL (banner on stderr)");
});

test("review fix: hop guard fails closed on NaN/non-numeric depth", async () => {
  const m = await import("../src/providers/transport.mjs");
  assert.throws(() => m.checkHopDepth(Number.NaN), /hop/i);
  assert.throws(() => m.checkHopDepth("1"), /hop/i);
  assert.doesNotThrow(() => m.checkHopDepth(0));
  assert.equal(typeof m.currentHopDepth, "function");
  const prev = process.env.ADLC_HOP_DEPTH;
  process.env.ADLC_HOP_DEPTH = "abc";
  try {
    assert.throws(() => m.currentHopDepth(), /numeric/i);
  } finally {
    if (prev === undefined) delete process.env.ADLC_HOP_DEPTH; else process.env.ADLC_HOP_DEPTH = prev;
  }
  assert.ok(String(m.remoteInputs.toString()).includes("ADLC_HOP_DEPTH"), "hop count must propagate to remote inputs");
});

test("review fix: stdout is pure JSONL, secrets redacted on output paths", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const tmp = await import("node:fs/promises").then((m) => m.mkdtemp(path.join(os.tmpdir(), "adlc-route-")));
  mkdirSync(path.join(tmp, ".adlc"), { recursive: true });
  writeFileSync(path.join(tmp, ".adlc", "workspace.yml"), "schema_version: 1\nname: route42\nimage: app:${APP_TOKEN}\n");
  writeFileSync(path.join(tmp, "secrets.env"), "APP_TOKEN=sek-live-789\n");
  const prevCwd = process.cwd();
  const prevToken = process.env.APP_TOKEN;
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.error = () => {};
  process.chdir(tmp);
  try {
    const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
    const code = await cmdCoderWorkspaceSetup([], {}, []);
    assert.equal(code, 0);
  } finally {
    process.chdir(prevCwd);
    console.log = origLog;
    console.error = origErr;
    if (prevToken === undefined) delete process.env.APP_TOKEN; else process.env.APP_TOKEN = prevToken;
  }
  assert.ok(logs.length > 0, "mock transport must echo payload lines on stdout");
  for (const line of logs) {
    JSON.parse(line);
    assert.ok(!line.includes("sek-live-789"), "secret values must never appear on stdout");
  }
});

test("review fix: secrets merge order docker > secrets.env > process.env, referenced-only", async () => {
  const m = await import("../src/providers/transport.mjs");
  assert.equal(typeof m.loadSecretsEnv, "function");
  assert.equal(typeof m.referencedSecretsEnv, "function");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { writeFileSync } = await import("node:fs");
  const tmp = await import("node:fs/promises").then((m2) => m2.mkdtemp(path.join(os.tmpdir(), "adlc-sec-")));
  writeFileSync(path.join(tmp, "secrets.env"), "ONLY_FILE=file-val\nSHARED=file-wins\n");
  const prevOnly = process.env.ONLY_FILE;
  const prevShared = process.env.SHARED;
  const prevExtra = process.env.EXTRA_UNREFERENCED;
  process.env.SHARED = "env-val";
  process.env.EXTRA_UNREFERENCED = "leak-me";
  try {
    const loaded = m.loadSecretsEnv(tmp);
    assert.equal(loaded.ONLY_FILE, "file-val");
    assert.equal(loaded.SHARED, "file-wins", "secrets.env must beat process.env");
    const scoped = m.referencedSecretsEnv(["SHARED"], tmp);
    assert.equal(scoped.SHARED, "file-wins");
    assert.ok(!("EXTRA_UNREFERENCED" in scoped), "forwarded vars must be referenced-only");
  } finally {
    if (prevOnly === undefined) delete process.env.ONLY_FILE; else process.env.ONLY_FILE = prevOnly;
    if (prevShared === undefined) delete process.env.SHARED; else process.env.SHARED = prevShared;
    if (prevExtra === undefined) delete process.env.EXTRA_UNREFERENCED; else process.env.EXTRA_UNREFERENCED = prevExtra;
  }
});

test("iter-2: raw secret values never leak even when key is non-secret", async () => {
  const m = await import("../src/providers/transport.mjs");
  const scrubbed = m.scrubSecretValues("echo sek-live-789 done", { APP_TOKEN: "sek-live-789" });
  assert.ok(!scrubbed.includes("sek-live-789"), "scrub must use raw values, not [REDACTED]");
  assert.match(scrubbed, /\[REDACTED\]/);
  const noOp = m.scrubSecretValues("echo sek-live-789 done", { APP_TOKEN: "[REDACTED]" });
  assert.ok(noOp.includes("sek-live-789"), "scrubbing [REDACTED] literal proves the old bug");
});

test("iter-2: coder-route payloads carry env.ADLC_HOP_DEPTH for nested hopGuard", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../src/providers/coder-route.mjs", import.meta.url), "utf-8");
  assert.ok(/remoteInputs\(\)/.test(src), "payloads must wire remoteInputs()");
  assert.ok(/env:\s*remoteInputs\(\)/.test(src), "remote hop env must be set on payload");
});

test("iter-2: expansion merge order is process.env < secrets.env (docker wins)", async () => {
  const m = await import("../src/providers/transport.mjs");
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../src/providers/coder-route.mjs", import.meta.url), "utf-8");
  assert.ok(/\{\s*\.\.\.process\.env,\s*\.\.\.loadSecretsEnv/.test(src),
    "coder-route must use {...process.env, ...loadSecretsEnv} to match transport");
  const out = m.expandWorkspaceVars({ v: "${SHARED}" }, { ...{ SHARED: "env-val" }, ...{ SHARED: "file-wins" } });
  assert.equal(out.v, "file-wins");
});

test("iter-2: coder.mjs preserves transport-provided handlePath", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const tmp = await import("node:fs/promises").then((mk) => mk.mkdtemp(path.join(os.tmpdir(), "adlc-handle-")));
  const t = { async provision(n) { return { name: n, host: "h", handlePath: "/custom/path.json" }; } };
  const p = createCoderProvider({ transport: t, workspacesDir: path.join(tmp, "w") });
  const h = await p.provision("demo");
  assert.equal(h.handlePath, "/custom/path.json", "transport-provided handlePath must win");
});

test("iter-3: workspace name expands ${VAR} from env (per-mission workspace names)", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-name-"));
  const wsFile = path.join(tmp, "workspace.yml");
  await fs.writeFile(
    wsFile,
    ["schema_version: 1", "name: ${WORKSPACE_NAME}", "workspace:", "  dirs: []", ""].join("\n")
  );
  const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
  const prev = process.env.WORKSPACE_NAME;
  process.env.WORKSPACE_NAME = "repo-mission-42";
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    const code = await cmdCoderWorkspaceSetup([wsFile], {}, []);
    assert.equal(code, 0, "workspace setup must succeed");
  } finally {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.WORKSPACE_NAME;
    else process.env.WORKSPACE_NAME = prev;
  }
  const handles = await fs.readdir(path.join(tmp, ".adlc", "workspaces"));
  assert.ok(
    handles.includes("repo-mission-42.json"),
    `expanded name must drive the handle file, got ${JSON.stringify(handles)}`
  );
});

test("iter-3: workspace name is sanitized before use as a handle filename", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-name2-"));
  const wsFile = path.join(tmp, "workspace.yml");
  await fs.writeFile(
    wsFile,
    ["schema_version: 1", "name: ../../etc/passwd", "workspace:", "  dirs: []", ""].join("\n")
  );
  const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    const code = await cmdCoderWorkspaceSetup([wsFile], {}, []);
    assert.equal(code, 0, "workspace setup must succeed");
  } finally {
    process.chdir(cwd);
  }
  const handles = await fs.readdir(path.join(tmp, ".adlc", "workspaces"));
  for (const h of handles) {
    assert.ok(!h.includes("/") && !h.includes(".."), `unsafe handle filename: ${h}`);
  }
  const escaped = await fs
    .stat(path.join(path.dirname(tmp), "etc", "passwd.json"))
    .then(() => true)
    .catch(() => false);
  assert.equal(escaped, false, "handle file must not escape the workspaces dir");
});
