import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { validateWorkspaceConfig, expandWorkspaceVars, normalizeEvent, checkHopDepth, MAX_HOPS } from "../src/providers/transport.mjs";
import { createCoderProvider } from "../src/providers/coder.mjs";

const exec = promisify(execFile);
const runCli = (args) =>
  exec(process.execPath, ["bin/adlc-cli.mjs", ...args]).catch((e) => e);
// A child whose stdin is closed immediately (spawnSync + input) — needed for
// the stdin task form, where an open pipe would block the read.
const runCliWithClosedStdin = (args) => {
  const r = spawnSync(process.execPath, ["bin/adlc-cli.mjs", ...args], {
    input: "",
    encoding: "utf-8",
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

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

test("iter-4: expansion keeps secret-sourced values out of the config, process-env values expand in place", async () => {
  const m = await import("../src/providers/transport.mjs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-expandenv-"));
  await fs.writeFile(path.join(tmp, "secrets.env"), "SHARED=file-val\nONLY_FILE=file-only\n");
  const env = { SHARED: "env-val", PLAIN: "plain-val" };
  const expandEnv = m.expansionEnv(tmp, env);
  const out = m.expandWorkspaceVars(
    { secret: "${SHARED}", fromFile: "${ONLY_FILE}", plain: "${PLAIN}" },
    expandEnv
  );
  assert.equal(out.plain, "plain-val", "a process-env value expands in place");
  assert.equal(out.secret, "${SHARED}", "a secret-sourced value must not be inlined into the config");
  assert.equal(out.fromFile, "${ONLY_FILE}", "a secrets.env value must not be inlined into the config");
  // The value still travels in the vars channel, referenced-only.
  const vars = m.referencedSecretsEnv(["SHARED", "ONLY_FILE"], tmp, env);
  assert.equal(vars.SHARED, "file-val", "the secret-sourced value wins for forwarding");
  assert.equal(vars.ONLY_FILE, "file-only");
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

test("iter-3: local workspace setup expands ${VAR} like the provider path", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-localvars-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    ["schema_version: 1", "name: ${WS_NAME}", "workspace:", "  dirs: []", ""].join("\n")
  );
  const { cmdWorkspaceSetup } = await import("../src/commands/workspace.mjs");
  const cwd = process.cwd();
  process.chdir(tmp);
  const prev = process.env.WS_NAME;
  process.env.WS_NAME = "local-ws";
  const lines = [];
  const origLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  let code;
  try {
    code = await cmdWorkspaceSetup(["workspace.yml"], { agents: ["opencode"], dryRun: true });
  } finally {
    console.log = origLog;
    process.chdir(cwd);
    if (prev === undefined) delete process.env.WS_NAME;
    else process.env.WS_NAME = prev;
  }
  assert.equal(code, 0, `workspace setup must succeed: ${lines.join(" | ")}`);
  assert.ok(
    lines.some((l) => l.includes("local-ws")),
    `the expanded name must be reported, got ${JSON.stringify(lines)}`
  );
  assert.ok(
    !lines.some((l) => l.includes("${WS_NAME}")),
    `the raw placeholder must not survive expansion: ${JSON.stringify(lines)}`
  );
});

test("iter-3: local workspace setup fails fast on a missing ${VAR}", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-localvars2-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    ["schema_version: 1", "name: ${WS_NAME_MISSING}", "workspace:", "  dirs: []", ""].join("\n")
  );
  const { cmdWorkspaceSetup } = await import("../src/commands/workspace.mjs");
  const cwd = process.cwd();
  process.chdir(tmp);
  const errs = [];
  const origErr = console.error;
  console.error = (...args) => errs.push(args.join(" "));
  let code;
  try {
    code = await cmdWorkspaceSetup(["workspace.yml"], { agents: ["opencode"], dryRun: true });
  } finally {
    console.error = origErr;
    process.chdir(cwd);
  }
  assert.equal(code, 1, "a missing variable must fail the setup");
  assert.match(errs.join(" "), /WS_NAME_MISSING/, "the error must name the missing variable");
});

// ── iter-4: review findings (independent reviewer @ head 5f406f2) ────────

function captureRoute(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.error = (...a) => { errs.push(a.join(" ")); };
  return {
    logs,
    errs,
    restore() { console.log = origLog; console.error = origErr; },
  };
}

function injectedTransport(overrides = {}) {
  const calls = [];
  const transport = {
    calls,
    async provision(name) {
      calls.push({ op: "provision", name });
      return { name, host: `mock-${name}` };
    },
    async exec(handle, input) {
      calls.push({ op: "exec", handle, input });
      return { stdout: String(input ?? ""), stderr: "", exitCode: 0, ...overrides };
    },
  };
  globalThis.__ADLC_CODER_TRANSPORT__ = transport;
  return transport;
}

test("iter-4: a remote failure exits non-zero and surfaces the remote stderr", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-fail-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    "schema_version: 1\nname: fail-ws\nworkspace:\n  dirs: []\n"
  );
  injectedTransport({ stdout: "remote step FAILED\n", stderr: "fatal: clone failed\n", exitCode: 1 });
  const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdCoderWorkspaceSetup(["workspace.yml"], {}, []);
  } finally {
    process.chdir(prevCwd);
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.notEqual(code, 0, "a remote failure must not exit 0");
  assert.match(cap.errs.join("\n"), /clone failed/, "the remote stderr must be surfaced");
});

test("iter-4: outbound vars carry the real value — redaction belongs on the output path", async () => {
  const transport = injectedTransport();
  const { cmdCoderAgentRun } = await import("../src/providers/coder-route.mjs");
  const prev = process.env.MY_API_TOKEN;
  process.env.MY_API_TOKEN = "tok-secret-999";
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderAgentRun(
      ["--provider", "coder", "--workspace", "agent-ws", "deploy with ${MY_API_TOKEN}"],
      ["agent", "run", "--provider", "coder", "--workspace", "agent-ws", "deploy with ${MY_API_TOKEN}"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
    if (prev === undefined) delete process.env.MY_API_TOKEN;
    else process.env.MY_API_TOKEN = prev;
  }
  assert.equal(code, 0);
  const exec = transport.calls.find((c) => c.op === "exec");
  const payload = JSON.parse(exec.input);
  assert.equal(
    payload.vars.MY_API_TOKEN,
    "tok-secret-999",
    "the referenced var value must reach the transport, not a redacted placeholder"
  );
  assert.ok(
    !cap.logs.join("\n").includes("tok-secret-999"),
    "the secret must still be scrubbed from the output path"
  );
});

test("iter-4: secret-sourced vars are not inlined into the config payload", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-inline-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    "schema_version: 1\nname: inline-ws\nimage: app:${APP_TOKEN}\nworkspace:\n  dirs: []\n"
  );
  await fs.writeFile(path.join(tmp, "secrets.env"), "APP_TOKEN=sek-live-789\n");
  const transport = injectedTransport();
  const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
  const prevCwd = process.cwd();
  const prevToken = process.env.APP_TOKEN;
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdCoderWorkspaceSetup(["workspace.yml"], {}, []);
  } finally {
    process.chdir(prevCwd);
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
    if (prevToken === undefined) delete process.env.APP_TOKEN;
    else process.env.APP_TOKEN = prevToken;
  }
  assert.equal(code, 0);
  const exec = transport.calls.find((c) => c.op === "exec");
  const payload = JSON.parse(exec.input);
  assert.ok(
    !String(payload.config.image).includes("sek-live-789"),
    "a secret must not be inlined into the config channel"
  );
  assert.equal(
    payload.vars.APP_TOKEN,
    "sek-live-789",
    "the secret travels in the vars channel instead"
  );
});

test("iter-4: the local setup path rejects a provider: key instead of ignoring it", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-provkey-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    "schema_version: 1\nname: prov-ws\nprovider: coder\nworkspace:\n  dirs: []\n"
  );
  const { cmdWorkspaceSetup } = await import("../src/commands/workspace.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdWorkspaceSetup(["workspace.yml"], { agents: ["opencode"], dryRun: true });
  } finally {
    process.chdir(prevCwd);
    cap.restore();
  }
  assert.equal(code, 1, "a provider: key must fail the local path too");
  assert.match(cap.errs.join("\n"), /provider/, "the error must name the provider key");
});

test("iter-4: an --input value is never mistaken for the workflow source", async () => {
  const transport = injectedTransport();
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderWorkflowRun(
      ["FOO=bar", "factory"],
      {},
      ["--provider", "coder", "--workspace", "wf-ws", "--input", "FOO=bar", "factory"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 0);
  const exec = transport.calls.find((c) => c.op === "exec");
  const payload = JSON.parse(exec.input);
  assert.equal(payload.source, "factory", "the workflow source must not be an --input value");
  assert.deepEqual(payload.inputs, { FOO: "bar" });
});

test("iter-4: agent run without a task fails even when --provider is given", async () => {
  injectedTransport();
  const { cmdCoderAgentRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderAgentRun(["--provider", "coder"], []);
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 1, "a missing task must fail, not run with the provider as the task");
  assert.match(cap.errs.join("\n"), /task is required/i);
});

test("iter-4: a negative hop depth fails closed", async () => {
  const m = await import("../src/providers/transport.mjs");
  const prev = process.env.ADLC_HOP_DEPTH;
  process.env.ADLC_HOP_DEPTH = "-1";
  try {
    assert.throws(() => m.currentHopDepth(), /ADLC_HOP_DEPTH|hop depth/i);
  } finally {
    if (prev === undefined) delete process.env.ADLC_HOP_DEPTH;
    else process.env.ADLC_HOP_DEPTH = prev;
  }
});

test("iter-4: a corrupt handle file fails loudly instead of re-provisioning", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-corrupt-"));
  await fs.mkdir(path.join(tmp, "w"), { recursive: true });
  await fs.writeFile(path.join(tmp, "w", "demo.json"), "{not json");
  const transport = injectedTransport();
  const { createCoderProvider } = await import("../src/providers/coder.mjs");
  const p = createCoderProvider({ transport, workspacesDir: path.join(tmp, "w") });
  await assert.rejects(() => p.provision("demo"), /handle|corrupt|unreadable/i);
  assert.equal(
    transport.calls.filter((c) => c.op === "provision").length,
    0,
    "a corrupt handle must not trigger a second provision"
  );
});

test("iter-4: --workspace selects the workspace for the agent/workflow routes", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-wssel-"));
  const transport = injectedTransport();
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  const prevCwd = process.cwd();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdCoderWorkflowRun(
      ["factory"],
      {},
      ["run", "--provider", "coder", "--workspace", "repo-mission-42", "factory"]
    );
  } finally {
    process.chdir(prevCwd);
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 0);
  const prov = transport.calls.find((c) => c.op === "provision");
  assert.equal(prov.name, "repo-mission-42", "the route must provision the selected workspace");
});

// ── iter-5: second re-review findings ─────────────────────────────────────

test("iter-5: a secret-sourced name fails loudly instead of naming another workspace", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-secretname-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    "schema_version: 1\nname: ${WORKSPACE_NAME}\nworkspace:\n  dirs: []\n"
  );
  await fs.writeFile(path.join(tmp, "secrets.env"), "WORKSPACE_NAME=repo-mission-42\n");
  injectedTransport();
  const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdCoderWorkspaceSetup(["workspace.yml"], {}, []);
  } finally {
    process.chdir(prevCwd);
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.notEqual(code, 0, "a secret-sourced name must not be silently mangled");
  assert.match(cap.errs.join("\n"), /WORKSPACE_NAME|unresolved/i);
});

test("iter-5: a literal input value never reaches stdout", async () => {
  const transport = injectedTransport();
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderWorkflowRun(
      ["factory"],
      {},
      ["run", "--provider", "coder", "--workspace", "in-ws", "--input", "session=s3cr3t-literal-value", "factory"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 0);
  assert.ok(
    !cap.logs.join("\n").includes("s3cr3t-literal-value"),
    "a value passed via --input must be redacted from the outbound stream"
  );
  const exec = transport.calls.find((c) => c.op === "exec");
  const payload = JSON.parse(exec.input);
  assert.equal(payload.inputs.session, "s3cr3t-literal-value", "the remote still receives the value");
});

test("iter-5: workspace setup refuses a --workspace that conflicts with the file's name", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-wsconflict-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    "schema_version: 1\nname: file-ws\nworkspace:\n  dirs: []\n"
  );
  injectedTransport();
  const { cmdCoderWorkspaceSetup } = await import("../src/providers/coder-route.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdCoderWorkspaceSetup(["workspace.yml"], {}, ["--workspace", "other-ws"]);
  } finally {
    process.chdir(prevCwd);
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 1, "a conflicting --workspace must be refused");
  assert.match(cap.errs.join("\n"), /--workspace/);
});

test("iter-5: the exec routes refuse to provision a second machine implicitly", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-nohandle-"));
  const transport = injectedTransport();
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  const prevCwd = process.cwd();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdCoderWorkflowRun(["factory"], {}, ["run", "--provider", "coder", "factory"]);
  } finally {
    process.chdir(prevCwd);
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 1, "without a handle the route must not silently provision");
  assert.equal(transport.calls.filter((c) => c.op === "provision").length, 0);
  assert.match(cap.errs.join("\n"), /no workspace handle/);
});

test("iter-5: --input=k=v (equals form) is forwarded", async () => {
  const transport = injectedTransport();
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderWorkflowRun(
      ["factory"],
      {},
      ["run", "--provider", "coder", "--workspace", "eq-ws", "--input=run_id=r-7", "factory"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 0);
  const exec = transport.calls.find((c) => c.op === "exec");
  assert.deepEqual(JSON.parse(exec.input).inputs, { run_id: "r-7" });
});

test("iter-5: a handle file holding valid non-object JSON is treated as corrupt", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-nullhandle-"));
  await fs.mkdir(path.join(tmp, "w"), { recursive: true });
  await fs.writeFile(path.join(tmp, "w", "demo.json"), "null");
  const transport = injectedTransport();
  const { createCoderProvider } = await import("../src/providers/coder.mjs");
  const p = createCoderProvider({ transport, workspacesDir: path.join(tmp, "w") });
  await assert.rejects(() => p.provision("demo"), /handle|corrupt|unreadable/i);
  assert.equal(transport.calls.filter((c) => c.op === "provision").length, 0);
});

test("iter-5: an unknown --provider is refused, not silently run locally", async () => {
  const r = await runCli(["agent", "run", "--provider", "coderx", "task"]);
  assert.equal(r.code, 1, "an unknown provider must fail");
  assert.match(`${r.stdout}${r.stderr}`, /unknown --provider/i);
});

test("iter-5: a transport that returns no result is a failure, not a success", async () => {
  const transport = injectedTransport({ stdout: undefined });
  globalThis.__ADLC_CODER_TRANSPORT__ = {
    provisionCalls: 0,
    async provision(name) { return { name, host: "h" }; },
    async exec() { return undefined; },
  };
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderWorkflowRun(
      ["factory"], {}, ["run", "--provider", "coder", "--workspace", "undef-ws", "factory"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.notEqual(code, 0, "a transport without a result must not read as success");
});

test("iter-5: a whitespace hop depth fails closed", async () => {
  const m = await import("../src/providers/transport.mjs");
  const prev = process.env.ADLC_HOP_DEPTH;
  process.env.ADLC_HOP_DEPTH = " ";
  try {
    assert.throws(() => m.currentHopDepth(), /ADLC_HOP_DEPTH|hop depth/i);
  } finally {
    if (prev === undefined) delete process.env.ADLC_HOP_DEPTH;
    else process.env.ADLC_HOP_DEPTH = prev;
  }
});

test("iter-5: the local path never prints a secret value", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-localsecret-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    [
      "schema_version: 1",
      "name: local-secret",
      "workspace:",
      "  git:",
      "    - repo: https://x-access-token:${GIT_TOKEN}@github.com/org/repo.git",
      "      path: repo",
      "",
    ].join("\n")
  );
  await fs.writeFile(path.join(tmp, "secrets.env"), "GIT_TOKEN=ghp_supersecretvalue\n");
  const { cmdWorkspaceSetup } = await import("../src/commands/workspace.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdWorkspaceSetup(["workspace.yml"], { agents: ["opencode"], dryRun: true });
  } finally {
    process.chdir(prevCwd);
    cap.restore();
  }
  assert.equal(code, 0);
  assert.ok(
    !cap.logs.join("\n").includes("ghp_supersecretvalue"),
    `a secret must never be printed: ${cap.logs.join(" | ")}`
  );
});

test("iter-5: a nested provider key is rejected too", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-nestedprov-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    "schema_version: 1\nname: nested\nworkspace:\n  provider: coder\n  dirs: []\n"
  );
  const { cmdWorkspaceSetup } = await import("../src/commands/workspace.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdWorkspaceSetup(["workspace.yml"], { agents: ["opencode"], dryRun: true });
  } finally {
    process.chdir(prevCwd);
    cap.restore();
  }
  assert.equal(code, 1, "a nested provider key must be rejected as well");
  assert.match(cap.errs.join("\n"), /provider/);
});

test("iter-5: an empty ${VAR} is missing (pinned)", async () => {
  const m = await import("../src/providers/transport.mjs");
  assert.throws(
    () => m.expandWorkspaceVars({ v: "${EMPTY_VAR}" }, { EMPTY_VAR: "" }),
    /Missing required workspace variable: EMPTY_VAR/
  );
});

test("iter-5: the remote exit code is propagated exactly", async () => {
  injectedTransport({ stdout: "boom\n", stderr: "remote failed\n", exitCode: 7 });
  const { cmdCoderWorkflowRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderWorkflowRun(
      ["factory"], {}, ["run", "--provider", "coder", "--workspace", "exit-ws", "factory"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 7, "the remote's exit code must be propagated, not flattened to 1");
});

test("iter-5: the dispatch consumes an --input value (not a positional)", async () => {
  const r = await runCli(["workflow", "run", "--input", "FOO=bar", "factory"]);
  assert.notEqual(r.code, 0, "the local path has no workflow named FOO=bar — the point is the source");
  assert.ok(
    !`${r.stdout}${r.stderr}`.includes("Workflow not found: FOO=bar"),
    `the --input value must not be taken as the workflow source: ${r.stdout}${r.stderr}`
  );
});

test("iter-6: the repo's own workspace file is satisfiable by the documented lane command", async () => {
  // The shipped .adlc/workspace.yml must only reference variables the lane
  // contract supplies (WORKSPACE_NAME, BRANCH) — otherwise the documented
  // command fails on arrival.
  const { readFileSync } = await import("node:fs");
  const { collectReferencedVars } = await import("../src/providers/transport.mjs");
  const content = readFileSync(".adlc/workspace.yml", "utf-8");
  const refs = collectReferencedVars(content);
  const laneVars = ["WORKSPACE_NAME", "BRANCH"];
  for (const ref of refs) {
    assert.ok(
      laneVars.includes(ref),
      `the repo's workspace file references ${ref}, which the lane does not supply (lane supplies: ${laneVars.join(", ")})`
    );
  }
});

test("iter-7: the stdin task REPLACES the '-' in the outbound args", async () => {
  // The remote agent must receive the task text, not the "-" marker.
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const tmp = await import("node:fs/promises").then((m) =>
    m.mkdtemp(path.join(os.tmpdir(), "adlc-stdin-"))
  );
  // A fake transport that records the payload it receives.
  const payloadFile = path.join(tmp, "payload.json");
  const transport = path.join(tmp, "transport.mjs");
  writeFileSync(
    transport,
    [
      "import { writeFileSync } from 'node:fs';",
      "globalThis.__ADLC_CODER_TRANSPORT__ = {",
      "  async provision(name) { return { name, host: 'h' }; },",
      "  async exec(handle, input) {",
      `    writeFileSync(${JSON.stringify(payloadFile)}, input);`,
      "    return { stdout: '', stderr: '', exitCode: 0 };",
      "  },",
      "};",
      "",
    ].join("\n")
  );
  const cli = path.join(tmp, "cli.mjs");
  writeFileSync(
    cli,
    [
      `import(${JSON.stringify(transport)});`,
      `const { cmdCoderAgentRun } = await import(${JSON.stringify(
        new URL("../src/providers/coder-route.mjs", import.meta.url).pathname
      )});`,
      "const code = await cmdCoderAgentRun(['--provider','coder','--workspace','stdin-ws','-'], ['agent','run','--provider','coder','--workspace','stdin-ws','-']);",
      "process.exit(code);",
      "",
    ].join("\n")
  );
  const r = spawnSync(process.execPath, [cli], {
    input: "TASK-FROM-STDIN-12345 do it",
    encoding: "utf-8",
    cwd: tmp,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse((await import("node:fs")).readFileSync(payloadFile, "utf-8"));
  assert.equal(
    payload.args[0],
    "TASK-FROM-STDIN-12345 do it",
    "the stdin task must reach the transport, not the '-' marker"
  );
  rmSync(tmp, { recursive: true, force: true });
});

test("iter-7: a short secret in a git URL is masked in the printed plan", async () => {
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { default: fs } = await import("node:fs/promises");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "adlc-shortsecret-"));
  await fs.writeFile(
    path.join(tmp, "workspace.yml"),
    [
      "schema_version: 1",
      "name: short-secret",
      "workspace:",
      "  git:",
      "    - repo: https://x-access-token:${GIT_TOKEN}@github.com/org/repo.git",
      "      path: repo",
      "",
    ].join("\n")
  );
  await fs.writeFile(path.join(tmp, "secrets.env"), "GIT_TOKEN=xy\n");
  const { cmdWorkspaceSetup } = await import("../src/commands/workspace.mjs");
  const prevCwd = process.cwd();
  const cap = captureRoute();
  process.chdir(tmp);
  let code;
  try {
    code = await cmdWorkspaceSetup(["workspace.yml"], { agents: ["opencode"], dryRun: true });
  } finally {
    process.chdir(prevCwd);
    cap.restore();
  }
  assert.equal(code, 0);
  const out = cap.logs.join("\n");
  assert.ok(!out.includes("x-access-token:xy@"), `a 2-char secret must be masked too: ${out}`);
  assert.ok(out.includes("[REDACTED]"), `the credentials must be masked: ${out}`);
});

test("iter-6: the stdin task form is reachable (an empty stdin fails loudly)", async () => {
  // Run the CLI as a child: reading fd 0 in-process would block on the
  // test runner's terminal. The child's stdin is closed -> the task is empty.
  const r = runCliWithClosedStdin([
    "agent", "run", "--provider", "coder", "--workspace", "stdin-ws", "-",
  ]);
  assert.equal(r.code, 1, "an empty stdin must fail, not dispatch an empty task");
  assert.match(`${r.stdout}${r.stderr}`, /task is required/i);
});

test("iter-6: a flag value is never dispatched as the task", async () => {
  const transport = injectedTransport();
  const { cmdCoderAgentRun } = await import("../src/providers/coder-route.mjs");
  const cap = captureRoute();
  let code;
  try {
    code = await cmdCoderAgentRun(
      ["--provider", "coder", "--workspace", "flag-ws", "-a", "opencode"],
      ["agent", "run", "--provider", "coder", "--workspace", "flag-ws", "-a", "opencode"]
    );
  } finally {
    cap.restore();
    delete globalThis.__ADLC_CODER_TRANSPORT__;
  }
  assert.equal(code, 1, "a taskless run must fail even when a flag value is present");
  assert.match(cap.errs.join("\n"), /task is required/i);
  assert.equal(transport.calls.filter((c) => c.op === "exec").length, 0, "nothing may be dispatched");
});

test("iter-6: --provider coder on a command with no provider route is refused", async () => {
  const r = await runCli(["agent", "list", "--provider", "coder"]);
  assert.equal(r.code, 1, "an unrouted provider command must not run locally");
  assert.match(`${r.stdout}${r.stderr}`, /not supported/i);
});
