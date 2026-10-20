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
  const transport = fakeTransport();
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
  assert.equal(typeof provider.provision, "function");
  assert.equal(typeof provider.run, "function");
  const handle = await provider.provision("demo");
  assert.match(handle.handlePath, /\.adlc\/workspaces\/demo\.json/);
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
  const transport = fakeTransport();
  const provider = createCoderProvider({ transport, workspacesDir: ".adlc/workspaces" });
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
  const provider = createCoderProvider({ transport: shifting, workspacesDir: ".adlc/workspaces" });
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
