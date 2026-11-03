// Security-audit regression (skills.sh lens: Socket/Snyk/Gen).
// RED: fails on the unhardened tree; GREEN after argv/allowlist/containment fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { evaluateExpression } from "../src/workflow/expressions.mjs";
import { fetchEventsManifest } from "../src/events.mjs";
import { ShellStep } from "../src/workflow/steps/shell.mjs";
import { StepStatus } from "../src/workflow/base.mjs";

const exec = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/adlc-cli.mjs", import.meta.url));
const run = (args, cwd) =>
  exec(process.execPath, [BIN, ...args], { cwd }).catch((e) => e);

function tmpProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "adlc-sec-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const statusOf = (r) => (r.code === 0 && !r.stderr ? 0 : (r.code ?? 1));
const WS_HEAD = `schema_version: "1.0"\nname: "sec"\nversion: "1.0.0"\nagent: opencode\n`;

test("workspace setup --dry-run rejects ext:: remote-helper URLs", async () => {
  const dir = tmpProject({
    "workspace.yml": `${WS_HEAD}\nworkspace:\n  git:\n    - repo: ext::sh -c touch pwned\n      path: backend\n`,
  });
  try {
    const r = await run(["workspace", "setup", "workspace.yml", "--dry-run"], dir);
    assert.notEqual(statusOf(r), 0, "ext:: remote helper must be rejected");
    assert.match(r.stderr || "", /unsafe repo/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace setup --dry-run rejects option-like git refs", async () => {
  const dir = tmpProject({
    "workspace.yml": `${WS_HEAD}\nworkspace:\n  git:\n    - repo: https://github.com/org/backend\n      path: backend\n      branch: -uploader\n`,
  });
  try {
    const r = await run(["workspace", "setup", "workspace.yml", "--dry-run"], dir);
    assert.notEqual(statusOf(r), 0, "option-like branch must be rejected");
    assert.match(r.stderr || "", /branch|ref/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace setup warns (not blocks) on plaintext http source", async () => {
  const body = `${WS_HEAD}\nworkspace:\n  dirs:\n    - sub\n`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/yaml" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = tmpProject();
  try {
    const port = server.address().port;
    const r = await run(["workspace", "setup", `http://127.0.0.1:${port}/ws.yml`, "--dry-run"], dir);
    assert.match(r.stderr || "", /plaintext|unencrypted|downgrade|insecure/i);
    assert.equal(r.code ?? 0, 0, "warn-and-continue: http still proceeds");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace setup rejects git entry paths escaping the project root", async () => {
  const dir = tmpProject({
    "workspace.yml": `${WS_HEAD}\nworkspace:\n  git:\n    - repo: https://github.com/org/backend\n      path: ../evil\n`,
  });
  try {
    const r = await run(["workspace", "setup", "workspace.yml", "--dry-run"], dir);
    assert.notEqual(statusOf(r), 0, "path escape must be rejected");
    assert.match(r.stderr || "", /outside|contain|within|escape/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events manifest fetch warns (not blocks) on http github URL", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  const origWarn = console.warn;
  const warnings = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, text: async () => "{}" };
  };
  console.warn = (msg, ...rest) => warnings.push([msg, ...rest].join(" "));
  try {
    await fetchEventsManifest("http://github.com/o/r");
    assert.match(warnings.join("\n"), /plaintext|unencrypted|downgrade|insecure|https/i);
    assert.ok(calls.every((u) => u.startsWith("https://")), "fetch itself stays https");
  } finally {
    globalThis.fetch = origFetch;
    console.warn = origWarn;
  }
});

test("expression engine does not expose prototype chain", () => {
  const ctx = { inputs: { name: "x" } };
  assert.equal(evaluateExpression("{{ inputs.constructor }}", ctx), null);
  assert.equal(evaluateExpression("{{ inputs.__proto__ }}", ctx), null);
  assert.equal(evaluateExpression("{{ inputs.name }}", ctx), "x");
});

test("shell step still interpolates legitimate inputs (no-break guard)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-sec-sh-"));
  try {
    const step = new ShellStep();
    const res = await step.execute(
      { id: "t", run: "echo hello-{{ inputs.who }}" },
      { projectRoot: dir, inputs: { who: "world" } },
    );
    assert.equal(res.status, StepStatus.COMPLETED);
    assert.match(res.output.stdout, /hello-world/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
