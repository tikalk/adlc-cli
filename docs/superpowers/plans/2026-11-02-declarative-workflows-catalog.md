# Declarative Workflows & Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement declarative YAML workflows and a catalog subsystem in `adlc-cli` under `workflows/`, support multi-source execution (URL, file, installed, bundled), and completely delete `src/workflow/builtins.mjs` with zero backward-compatibility shims.

**Architecture:** Bundled declarative workflow manifests live in `adlc-cli/workflows/<name>/workflow.yml` indexed by `workflows/catalog.json`. A new pure-ESM module `src/workflow/catalog.mjs` manages catalog lookup, URL fetching with safety guards (size limits, timeouts), and installed project registries in `.adlc/workflows/workflow-registry.json`. `WorkflowEngine.loadWorkflow()` resolves in order: URL -> filesystem path -> workspace installed (`.adlc/workflows/<id>/workflow.yml`) -> bundled asset (`workflows/<id>/workflow.yml`). `src/workflow/builtins.mjs` is deleted, and CLI commands `workflow search`, `workflow add`, and `workflow list` provide Spec-Kit workflow management parity.

**Tech Stack:** Node.js (>= 18) built-in modules (`node:fs`, `node:path`, `node:url`, `fetch`), `node:test`, `node:assert`, zero external runtime dependencies.

**Spec:** `adlc-cli/docs/superpowers/specs/2026-11-02-declarative-workflows-catalog-design.md`

## Global Constraints

- Runtime: Node.js >= 18 native ESM (`"type": "module"`).
- Dependencies: Zero npm runtime dependencies. All functionality uses Node standard libraries (`node:fs`, `node:path`, `node:url`, global `fetch`).
- File packaging: `package.json` `"files"` must include `"workflows/"` so assets are published to npm.
- Security: Remote fetches timeout after 30 seconds and reject bodies larger than 5MB (`MAX_WORKFLOW_BYTES = 5 * 1024 * 1024`).
- Security: Path traversal (`../`, absolute paths) in workflow IDs or custom install names is rejected.
- Registry safety: `.adlc/workflows/workflow-registry.json` is updated atomically via temp file replace and refuses symlink redirection.
- No shims: `src/workflow/builtins.mjs` must be deleted completely; no compatibility shims or fallback exports.

## Review Focus

1. **Remote workflow HTTP error (non-200):** Fetching an invalid URL or 404 returns a descriptive error naming the HTTP status and URL rather than unhandled promise rejections or raw HTML parse failures.
2. **Oversized remote workflow body (> 5MB):** A malicious or runaway remote workflow response aborts immediately when bytes exceed 5MB to prevent memory exhaustion.
3. **Remote workflow timeout (30s):** Hanging HTTP connections abort cleanly via `AbortSignal.timeout(30000)`.
4. **Path traversal in `workflow add` / custom name:** Attempting to install with `--as ../escape` or `--as /etc/cron` throws a path-traversal validation error.
5. **Symlink tampering in workflow registry:** Reading or writing `workflow-registry.json` refuses execution if the registry path or any parent is a symlink.

---

### Task 1: Package Assets & Bundled Catalog

**Files:**
- Create: `adlc-cli/workflows/catalog.json`
- Create: `adlc-cli/workflows/factory/workflow.yml`
- Modify: `adlc-cli/package.json:17-21`
- Test: `adlc-cli/tests/workflow-assets.test.mjs`

**Interfaces:**
- Consumes: Nothing (static assets & package manifest).
- Produces:
  - `adlc-cli/workflows/catalog.json`: Bundled catalog listing `factory` workflow metadata.
  - `adlc-cli/workflows/factory/workflow.yml`: Declarative factory outer-loop YAML.
  - `adlc-cli/package.json`: Includes `"workflows/"` in published package files.

- [ ] **Step 1: Write the failing test**

Create `adlc-cli/tests/workflow-assets.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test("workflows/catalog.json exists and conforms to spec-kit catalog schema", () => {
  const catalogPath = join(ROOT, "workflows", "catalog.json");
  assert.ok(existsSync(catalogPath), "catalog.json must exist under workflows/");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));
  assert.equal(catalog.schema_version, "1.0");
  assert.ok(catalog.workflows && typeof catalog.workflows === "object");
  assert.ok("factory" in catalog.workflows, "catalog must contain 'factory'");
  const factory = catalog.workflows.factory;
  assert.equal(factory.id, "factory");
  assert.equal(factory.name, "Factory Outer Loop");
  assert.ok(factory.path, "factory must specify path");
  assert.ok(existsSync(join(ROOT, factory.path)), `file at ${factory.path} must exist`);
});

test("workflows/factory/workflow.yml exists and declares all required factory steps", () => {
  const wfPath = join(ROOT, "workflows", "factory", "workflow.yml");
  assert.ok(existsSync(wfPath), "workflows/factory/workflow.yml must exist");
  const content = readFileSync(wfPath, "utf-8");
  assert.match(content, /id:\s*factory/);
  assert.match(content, /id:\s*run-branch/);
  assert.match(content, /id:\s*intent-product/);
  assert.match(content, /id:\s*publish-product/);
  assert.match(content, /id:\s*gate-product/);
  assert.match(content, /id:\s*run-branch-architecture/);
  assert.match(content, /id:\s*intent-architecture/);
  assert.match(content, /id:\s*publish-architecture/);
  assert.match(content, /id:\s*gate-architecture/);
  assert.match(content, /id:\s*execute/);
  assert.match(content, /id:\s*gate-completion/);
  assert.match(content, /id:\s*sweep/);
});

test("package.json files field includes 'workflows/'", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("workflows/") || pkg.files.includes("workflows"), "package.json files must include workflows/");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test adlc-cli/tests/workflow-assets.test.mjs
```
Expected: FAIL with missing `workflows/catalog.json`.

- [ ] **Step 3: Write minimal implementation**

1. Create directory:
```bash
mkdir -p adlc-cli/workflows/factory
```

2. Create `adlc-cli/workflows/catalog.json`:
```json
{
  "schema_version": "1.0",
  "updated_at": "2026-11-02T00:00:00Z",
  "workflows": {
    "factory": {
      "id": "factory",
      "name": "Factory Outer Loop",
      "description": "Factory outer loop — product → architecture → execution → sweep, with stage gates",
      "version": "1.0.0",
      "path": "workflows/factory/workflow.yml",
      "tags": ["factory", "outer-loop", "adlc"]
    }
  }
}
```

3. Create `adlc-cli/workflows/factory/workflow.yml`:
```yaml
schema_version: "1.0"
workflow:
  id: factory
  name: Factory Outer Loop
  version: "1.0.0"
inputs:
  verdict:
    type: string
    enum: ["", approve, reject]
  mr_url:
    type: string
    default: ""
  # Set by the dispatching runtime. issue_ref becomes the agent steps'
  # ADLC_ISSUE_REF (ADR-444) and is checked on restore; undeclared inputs are
  # dropped, so both must be declared here.
  issue_ref:
    type: string
    default: ""
  dispatch:
    type: string
    default: ""
steps:
  - id: run-branch
    type: shell
    # The engine checks out the intent run branch before any agent step
    # (ADR-431-amendment §1, §3a), so agent commits land on it and a
    # re-dispatch continues the issue's branch and MR. Idempotent with the
    # orchestrator's own run-branch call; skipped without the helper.
    run: |-
      node -e "const fs=require('fs'),cp=require('child_process');const fl=['.agents/skills/factory-mission/scripts/bash/run-branch.sh'];const miss=[];for(const f of fl){const n=f.split('/').pop();if(!fs.existsSync(f)){miss.push(n);continue}const r=cp.spawnSync('bash',[f],{stdio:'inherit'});if(r.error){miss.push(n+' ('+r.error.message+')');continue}if(r.status!==0)process.exit(r.status===null?1:r.status)}if(miss.length){const m='run-branch: skipped '+miss.join(', ')+' (factory-mission helpers not installed)';console.error(m);console.log(m);const o=process.env.ADLC_STEP_OUTPUT;if(o){let d={};try{d=JSON.parse(fs.readFileSync(o,'utf8'))}catch(e){}d.skipped=m.slice(0,2000);fs.writeFileSync(o,JSON.stringify(d))}}"
  - id: intent-product
    type: command
    command: factory-product
  - id: publish-product
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # run-branch first: an intent step that changed nothing may never have
    # left the base branch, and open-mr refuses anything but factory/intent/*.
    # open-mr is idempotent and opens nothing for an empty run; a missing
    # helper (factory-mission skill not installed) is skipped and reported.
    run: |-
      node -e "const fs=require('fs'),cp=require('child_process');const fl=['.agents/skills/factory-mission/scripts/bash/run-branch.sh','.agents/skills/factory-mission/scripts/bash/open-mr.sh'];const miss=[];for(const f of fl){const n=f.split('/').pop();if(!fs.existsSync(f)){miss.push(n);continue}const r=cp.spawnSync('bash',[f],{stdio:'inherit'});if(r.error){miss.push(n+' ('+r.error.message+')');continue}if(r.status!==0)process.exit(r.status===null?1:r.status)}if(miss.length){const m='publish: skipped '+miss.join(', ')+' (factory-mission helpers not installed)';console.error(m);console.log(m);const o=process.env.ADLC_STEP_OUTPUT;if(o){let d={};try{d=JSON.parse(fs.readFileSync(o,'utf8'))}catch(e){}d.skipped=m.slice(0,2000);fs.writeFileSync(o,JSON.stringify(d))}}"
  - id: gate-product
    type: gate
    message: "Approve PDRs before architecture?"
    context:
      records: [".adlc/drafts/pdr/*.md"]
      since: last_approved
      # The draft MR the publish step opened (ADR-444 §5, ADR-431-amendment §3a).
      link: "{{ steps.publish-product.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: run-branch-architecture
    type: shell
    # Again after the product gate: a parked run resumes after it, possibly
    # restored into a fresh clone on the base branch, and resume never re-runs
    # the first run-branch step.
    run: |-
      node -e "const fs=require('fs'),cp=require('child_process');const fl=['.agents/skills/factory-mission/scripts/bash/run-branch.sh'];const miss=[];for(const f of fl){const n=f.split('/').pop();if(!fs.existsSync(f)){miss.push(n);continue}const r=cp.spawnSync('bash',[f],{stdio:'inherit'});if(r.error){miss.push(n+' ('+r.error.message+')');continue}if(r.status!==0)process.exit(r.status===null?1:r.status)}if(miss.length){const m='run-branch: skipped '+miss.join(', ')+' (factory-mission helpers not installed)';console.error(m);console.log(m);const o=process.env.ADLC_STEP_OUTPUT;if(o){let d={};try{d=JSON.parse(fs.readFileSync(o,'utf8'))}catch(e){}d.skipped=m.slice(0,2000);fs.writeFileSync(o,JSON.stringify(d))}}"
  - id: intent-architecture
    type: command
    command: factory-architect
  - id: publish-architecture
    type: shell
    # The engine pushes the run branch and opens/reuses the draft MR itself
    # (ADR-431-amendment §3a), so the gate link never depends on the agent.
    # run-branch first: an intent step that changed nothing may never have
    # left the base branch, and open-mr refuses anything but factory/intent/*.
    # open-mr is idempotent and opens nothing for an empty run; a missing
    # helper (factory-mission skill not installed) is skipped and reported.
    run: |-
      node -e "const fs=require('fs'),cp=require('child_process');const fl=['.agents/skills/factory-mission/scripts/bash/run-branch.sh','.agents/skills/factory-mission/scripts/bash/open-mr.sh'];const miss=[];for(const f of fl){const n=f.split('/').pop();if(!fs.existsSync(f)){miss.push(n);continue}const r=cp.spawnSync('bash',[f],{stdio:'inherit'});if(r.error){miss.push(n+' ('+r.error.message+')');continue}if(r.status!==0)process.exit(r.status===null?1:r.status)}if(miss.length){const m='publish: skipped '+miss.join(', ')+' (factory-mission helpers not installed)';console.error(m);console.log(m);const o=process.env.ADLC_STEP_OUTPUT;if(o){let d={};try{d=JSON.parse(fs.readFileSync(o,'utf8'))}catch(e){}d.skipped=m.slice(0,2000);fs.writeFileSync(o,JSON.stringify(d))}}"
  - id: gate-architecture
    type: gate
    message: "Approve ADRs before execution?"
    context:
      records: [".adlc/drafts/adr/*.md"]
      since: last_approved
      link: "{{ steps.publish-architecture.output.mr_url }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: execute
    type: command
    command: factory-mission
    # The mission is the run's issue (ADR-444 §4): without it factory-mission
    # asked for one and returned, and the step counted as completed
    # (adlc-workspace#12 M9 pilot, run 84412db5). The skill also falls back to
    # ADLC_ISSUE_REF and fails the step when neither is set.
    input:
      args: "--issue {{ inputs.issue_ref }}"
  - id: gate-completion
    type: gate
    message: "Approve completion (ChDRs and merge request)?"
    context:
      records: [".adlc/drafts/chdr/*.md"]
      since: last_approved
      # The code MR factory-mission opened (its mr_url step output, ADR-444);
      # an operator-supplied mr_url input is the fallback.
      link: "{{ steps.execute.output.mr_url | default(inputs.mr_url) }}"
    options: [approve, reject]
    on_reject: abort
    verdict_input: verdict
  - id: sweep
    type: command
    command: factory-init
```

4. In `adlc-cli/package.json`, update `"files"` array to:
```json
  "files": [
    "bin/",
    "src/",
    "shim/",
    "workflows/"
  ],
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test adlc-cli/tests/workflow-assets.test.mjs
```
Expected: PASS (all 3 tests green).

- [ ] **Step 5: Commit**

```bash
git add adlc-cli/workflows/ adlc-cli/package.json adlc-cli/tests/workflow-assets.test.mjs
git commit -m "feat(workflow): package declarative factory workflow and catalog index"
```

---

### Task 2: Catalog Subsystem & Registry Manager

**Files:**
- Create: `adlc-cli/src/workflow/catalog.mjs`
- Test: `adlc-cli/tests/workflow-catalog.test.mjs`

**Interfaces:**
- Consumes: Node built-ins (`node:fs`, `node:path`, `node:url`, `fetch`), `adlc-cli/workflows/catalog.json`.
- Produces:
  - `MAX_WORKFLOW_BYTES`: constant `5 * 1024 * 1024` (5MB).
  - `getBundledCatalogPath()`: returns absolute path to `workflows/catalog.json`.
  - `getBundledWorkflowsDir()`: returns absolute path to `workflows/`.
  - `loadBundledCatalog()`: reads and parses bundled `workflows/catalog.json`.
  - `fetchWorkflowFromUrl(url, options = {})`: fetches remote workflow text, enforces 30s timeout and 5MB limit, returns `{ yaml: string, url: string }`.
  - `WorkflowRegistry`: class managing `.adlc/workflows/workflow-registry.json` (`add`, `remove`, `get`, `list`, `isInstalled`, `save`) with atomic replace and symlink check.
  - `installWorkflow(projectRoot, idOrUrl, options = {})`: downloads/copies workflow definition into `.adlc/workflows/<id>/workflow.yml` and registers in `WorkflowRegistry`.
  - `searchCatalog(query, options = {})`: searches catalog entries by id, name, description, tags.
  - `listWorkflows(projectRoot)`: returns `{ installed: [...], bundled: [...] }`.

- [ ] **Step 1: Write the failing test**

Create `adlc-cli/tests/workflow-catalog.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import {
  loadBundledCatalog,
  fetchWorkflowFromUrl,
  WorkflowRegistry,
  installWorkflow,
  searchCatalog,
  listWorkflows,
  MAX_WORKFLOW_BYTES,
} from "../src/workflow/catalog.mjs";

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-cat-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadBundledCatalog loads bundled catalog entries", () => {
  const catalog = loadBundledCatalog();
  assert.equal(catalog.schema_version, "1.0");
  assert.ok(catalog.workflows.factory);
  assert.equal(catalog.workflows.factory.id, "factory");
});

test("searchCatalog matches id, name, description, tags and empty query returns all", () => {
  const all = searchCatalog("");
  assert.ok(all.some((w) => w.id === "factory"));

  const byName = searchCatalog("outer loop");
  assert.ok(byName.some((w) => w.id === "factory"));

  const byTag = searchCatalog("outer-loop");
  assert.ok(byTag.some((w) => w.id === "factory"));

  const none = searchCatalog("nonexistent-xyz-999");
  assert.equal(none.length, 0);
});

test("WorkflowRegistry manages installed workflows atomically and safely", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const registry = new WorkflowRegistry(dir);
    assert.deepEqual(registry.list(), {});
    assert.equal(registry.isInstalled("factory"), false);

    registry.add("factory", { version: "1.0.0", source: "bundled" });
    assert.equal(registry.isInstalled("factory"), true);
    assert.equal(registry.get("factory").version, "1.0.0");
    assert.ok(registry.get("factory").installed_at);

    // Reopen registry from disk to verify persistence
    const reopened = new WorkflowRegistry(dir);
    assert.equal(reopened.isInstalled("factory"), true);
    assert.equal(reopened.get("factory").version, "1.0.0");

    assert.equal(registry.remove("factory"), true);
    assert.equal(registry.isInstalled("factory"), false);
  } finally {
    cleanup();
  }
});

test("WorkflowRegistry refuses symlinked registry path", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const realFile = join(dir, "real-registry.json");
    writeFileSync(realFile, JSON.stringify({ schema_version: "1.0", workflows: {} }));
    const symlinkPath = join(dir, "symlink-registry.json");
    symlinkSync(realFile, symlinkPath);

    assert.throws(
      () => new WorkflowRegistry(dir, symlinkPath),
      /symlink/i
    );
  } finally {
    cleanup();
  }
});

test("fetchWorkflowFromUrl fetches valid remote workflow", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/yaml" });
    res.end("workflow:\n  id: remote-test\n  name: Remote Test\nsteps: []\n");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/workflow.yml`;

  try {
    const res = await fetchWorkflowFromUrl(url);
    assert.match(res.yaml, /id:\s*remote-test/);
    assert.equal(res.url, url);
  } finally {
    server.close();
  }
});

test("fetchWorkflowFromUrl rejects HTTP errors with status and URL", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/missing.yml`;

  try {
    await assert.rejects(
      () => fetchWorkflowFromUrl(url),
      /Failed to fetch workflow from .* \(HTTP 404\)/
    );
  } finally {
    server.close();
  }
});

test("fetchWorkflowFromUrl rejects responses exceeding 5MB limit", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("a".repeat(MAX_WORKFLOW_BYTES + 10));
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/huge.yml`;

  try {
    await assert.rejects(
      () => fetchWorkflowFromUrl(url),
      /exceeds size limit/i
    );
  } finally {
    server.close();
  }
});

test("installWorkflow installs bundled workflow into project", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const result = await installWorkflow(dir, "factory");
    assert.equal(result.id, "factory");
    assert.ok(existsSync(join(dir, ".adlc", "workflows", "factory", "workflow.yml")));

    const list = listWorkflows(dir);
    assert.ok(list.installed.some((w) => w.id === "factory"));
    assert.ok(list.bundled.some((w) => w.id === "factory"));
  } finally {
    cleanup();
  }
});

test("installWorkflow rejects path traversal in workflow id or alias", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    await assert.rejects(
      () => installWorkflow(dir, "factory", { as: "../escape" }),
      /path traversal|invalid workflow id/i
    );
    await assert.rejects(
      () => installWorkflow(dir, "../escape"),
      /path traversal|invalid workflow id/i
    );
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test adlc-cli/tests/workflow-catalog.test.mjs
```
Expected: FAIL with "Cannot find module '../src/workflow/catalog.mjs'".

- [ ] **Step 3: Write minimal implementation**

Create `adlc-cli/src/workflow/catalog.mjs`:
```javascript
import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync, renameSync, unlinkSync } from "node:fs";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024; // 5 MB

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADLC_CLI_ROOT = resolve(__dirname, "..", "..");

export function getBundledWorkflowsDir() {
  return join(ADLC_CLI_ROOT, "workflows");
}

export function getBundledCatalogPath() {
  return join(getBundledWorkflowsDir(), "catalog.json");
}

export function loadBundledCatalog() {
  const path = getBundledCatalogPath();
  if (!existsSync(path)) {
    return { schema_version: "1.0", workflows: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (exc) {
    throw new Error(`Failed to parse bundled workflow catalog at ${path}: ${exc.message}`);
  }
}

export function searchCatalog(query = "", options = {}) {
  const catalog = loadBundledCatalog();
  const q = String(query ?? "").trim().toLowerCase();
  const workflows = Object.values(catalog.workflows || {});
  if (!q) {
    return workflows;
  }
  return workflows.filter((w) => {
    const id = String(w.id || "").toLowerCase();
    const name = String(w.name || "").toLowerCase();
    const desc = String(w.description || "").toLowerCase();
    const tags = Array.isArray(w.tags) ? w.tags.map((t) => String(t).toLowerCase()) : [];
    return (
      id.includes(q) ||
      name.includes(q) ||
      desc.includes(q) ||
      tags.some((t) => t.includes(q))
    );
  });
}

export async function fetchWorkflowFromUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "text/yaml, text/plain, */*" },
    });
  } catch (exc) {
    throw new Error(`Failed to connect to ${url}: ${exc.message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch workflow from ${url} (HTTP ${response.status}: ${response.statusText || "Error"})`);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_WORKFLOW_BYTES) {
      try {
        await reader.cancel();
      } catch {}
      throw new Error(`Workflow from ${url} exceeds size limit of ${MAX_WORKFLOW_BYTES} bytes`);
    }
    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);
  const yaml = buffer.toString("utf-8");
  return { yaml, url };
}

function assertSafeId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`Invalid workflow ID: "${id}"`);
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..") || isAbsolute(id)) {
    throw new Error(`Path traversal rejected in workflow ID or alias: "${id}"`);
  }
}

export class WorkflowRegistry {
  constructor(projectRoot, customPath = null) {
    this.projectRoot = resolve(projectRoot);
    this.registryPath = customPath ? resolve(customPath) : join(this.projectRoot, ".adlc", "workflows", "workflow-registry.json");
    this._checkSymlink(this.registryPath);
    this.data = this._load();
  }

  _checkSymlink(p) {
    if (existsSync(p)) {
      const stat = lstatSync(p);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to read/write workflow registry at ${p}: target is a symlink`);
      }
    }
  }

  _load() {
    if (!existsSync(this.registryPath)) {
      return { schema_version: "1.0", workflows: {} };
    }
    try {
      return JSON.parse(readFileSync(this.registryPath, "utf-8"));
    } catch (exc) {
      throw new Error(`Failed to read workflow registry at ${this.registryPath}: ${exc.message}`);
    }
  }

  save() {
    this._checkSymlink(this.registryPath);
    const parentDir = dirname(this.registryPath);
    mkdirSync(parentDir, { recursive: true });

    const tmpFile = join(parentDir, `.${basename(this.registryPath)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      writeFileSync(tmpFile, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
      renameSync(tmpFile, this.registryPath);
    } catch (exc) {
      try {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      } catch {}
      throw exc;
    }
  }

  add(workflowId, metadata = {}) {
    assertSafeId(workflowId);
    const now = new Date().toISOString();
    const existing = this.data.workflows[workflowId] || {};
    this.data.workflows[workflowId] = {
      ...existing,
      ...metadata,
      id: workflowId,
      installed_at: existing.installed_at || now,
      updated_at: now,
    };
    this.save();
  }

  remove(workflowId) {
    if (workflowId in this.data.workflows) {
      delete this.data.workflows[workflowId];
      this.save();
      return true;
    }
    return false;
  }

  get(workflowId) {
    return this.data.workflows[workflowId] ?? null;
  }

  list() {
    return { ...this.data.workflows };
  }

  isInstalled(workflowId) {
    return Boolean(this.data.workflows[workflowId]);
  }
}

export async function installWorkflow(projectRoot, idOrUrl, options = {}) {
  const isUrl = /^https?:\/\//i.test(String(idOrUrl));
  let workflowId = options.as;
  let yamlContent;
  let metadata = {};

  if (isUrl) {
    if (!workflowId) {
      const urlPath = new URL(idOrUrl).pathname;
      const base = basename(urlPath).replace(/\.(yml|yaml)$/i, "");
      workflowId = base || "workflow";
    }
    assertSafeId(workflowId);
    const fetched = await fetchWorkflowFromUrl(idOrUrl, options);
    yamlContent = fetched.yaml;
    metadata = { source_url: idOrUrl };
  } else {
    workflowId = workflowId || idOrUrl;
    assertSafeId(workflowId);
    const catalog = loadBundledCatalog();
    const entry = catalog.workflows[idOrUrl];
    if (!entry) {
      throw new Error(`Workflow "${idOrUrl}" not found in catalog.`);
    }
    const sourcePath = join(ADLC_CLI_ROOT, entry.path);
    if (!existsSync(sourcePath)) {
      throw new Error(`Bundled workflow file for "${idOrUrl}" not found at ${sourcePath}`);
    }
    yamlContent = readFileSync(sourcePath, "utf-8");
    metadata = {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      source: "bundled",
    };
  }

  assertSafeId(workflowId);
  const destDir = join(projectRoot, ".adlc", "workflows", workflowId);
  mkdirSync(destDir, { recursive: true });
  const destFile = join(destDir, "workflow.yml");
  writeFileSync(destFile, yamlContent, "utf-8");

  const registry = new WorkflowRegistry(projectRoot);
  registry.add(workflowId, {
    ...metadata,
    path: `.adlc/workflows/${workflowId}/workflow.yml`,
  });

  return { id: workflowId, path: destFile };
}

export function listWorkflows(projectRoot) {
  const registry = new WorkflowRegistry(projectRoot);
  const installedMap = registry.list();
  const installed = Object.entries(installedMap).map(([id, meta]) => ({
    id,
    ...meta,
    location: "installed",
  }));

  const catalog = loadBundledCatalog();
  const bundled = Object.entries(catalog.workflows || {}).map(([id, meta]) => ({
    id,
    ...meta,
    location: "bundled",
  }));

  return { installed, bundled };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test adlc-cli/tests/workflow-catalog.test.mjs
```
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add adlc-cli/src/workflow/catalog.mjs adlc-cli/tests/workflow-catalog.test.mjs
git commit -m "feat(workflow): add catalog discovery, URL fetching, and registry manager"
```

---

### Task 3: Multi-Source Workflow Resolution in Engine

**Files:**
- Modify: `adlc-cli/src/workflow/engine.mjs:25-40, 655-675`
- Test: `adlc-cli/tests/workflow-engine-resolution.test.mjs`

**Interfaces:**
- Consumes:
  - `loadBundledCatalog`, `getBundledWorkflowsDir`, `fetchWorkflowFromUrl` from `./catalog.mjs`.
  - `WorkflowDefinition.fromYamlFile`, `WorkflowDefinition.fromString`.
- Produces:
  - Updated `WorkflowDefinition.fromString(yamlString, sourcePath = null)`: attaches `sourcePath` (e.g. URL or filename) and stores `sourceYaml = yamlString`.
  - Updated `WorkflowEngine.loadWorkflow(source)`:
    1. HTTP/HTTPS URL: fetches via `fetchWorkflowFromUrl`, returns `WorkflowDefinition.fromString(fetched.yaml, source)`.
    2. Local YAML file path (`.yml`/`.yaml`): returns `WorkflowDefinition.fromYamlFile(path)`.
    3. Workspace installed definition (`.adlc/workflows/<id>/workflow.yml`): returns `WorkflowDefinition.fromYamlFile(installedPath)`.
    4. Bundled catalog workflow (`workflows/<id>/workflow.yml` or `workflows/<id>.yml`): returns `WorkflowDefinition.fromYamlFile(bundledPath)`.
    5. Throws `Workflow not found: ${source}` if not resolved.

- [ ] **Step 1: Write the failing test**

Create `adlc-cli/tests/workflow-engine-resolution.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../src/workflow/engine.mjs";

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-eng-res-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("engine.loadWorkflow resolves bundled 'factory' workflow", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.name, "Factory Outer Loop");
    assert.ok(def.sourcePath.includes("workflows/factory/workflow.yml") || def.sourcePath.includes("workflows/factory"));
    assert.ok(def.sourceYaml);
  } finally {
    cleanup();
  }
});

test("engine.loadWorkflow prioritizes workspace installed workflow over bundled asset", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const installedDir = join(dir, ".adlc", "workflows", "factory");
    mkdirSync(installedDir, { recursive: true });
    writeFileSync(
      join(installedDir, "workflow.yml"),
      "schema_version: '1.0'\nworkflow:\n  id: factory\n  name: Custom Workspace Factory\nsteps: []\n"
    );

    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow("factory");
    assert.equal(def.id, "factory");
    assert.equal(def.name, "Custom Workspace Factory");
  } finally {
    cleanup();
  }
});

test("engine.loadWorkflow resolves direct HTTP/HTTPS URL", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/yaml" });
    res.end("schema_version: '1.0'\nworkflow:\n  id: url-flow\n  name: From URL\nsteps: []\n");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/workflow.yml`;

  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    const def = await engine.loadWorkflow(url);
    assert.equal(def.id, "url-flow");
    assert.equal(def.name, "From URL");
    assert.equal(def.sourcePath, url);
  } finally {
    server.close();
    cleanup();
  }
});

test("engine.loadWorkflow throws clear error when workflow cannot be resolved", async () => {
  const { dir, cleanup } = makeTmp();
  try {
    const engine = new WorkflowEngine(dir);
    await assert.rejects(
      () => engine.loadWorkflow("nonexistent-flow-12345"),
      /Workflow not found: nonexistent-flow-12345/
    );
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test adlc-cli/tests/workflow-engine-resolution.test.mjs
```
Expected: FAIL with missing URL support or `loadWorkflow` being synchronous / not checking catalog.

- [ ] **Step 3: Write minimal implementation**

In `adlc-cli/src/workflow/engine.mjs`:
1. Update `WorkflowDefinition.fromString`:
```javascript
  static fromString(yamlString, sourcePath = null) {
    let data;
    try {
      data = parseYaml(yamlString);
    } catch (exc) {
      throw new Error(`Invalid YAML: ${exc.message}`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Workflow YAML must be a mapping, got ${Array.isArray(data) ? "list" : typeof data}.`);
    }
    return new WorkflowDefinition(data, sourcePath, yamlString);
  }
```

2. Make sure `WorkflowDefinition.fromYamlFile` populates `sourceYaml`:
```javascript
  static fromYamlFile(path) {
    let raw;
    try {
      raw = readFileSync(path, "utf-8");
    } catch (exc) {
      throw new Error(`Failed to read workflow file at ${path}: ${exc.message}`);
    }
    let data;
    try {
      data = parseYaml(raw);
    } catch (exc) {
      throw new Error(`Invalid YAML in ${path}: ${exc.message}`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Workflow YAML must be a mapping, got ${Array.isArray(data) ? "list" : typeof data}.`);
    }
    return new WorkflowDefinition(data, path, raw);
  }
```

3. Update `WorkflowEngine.loadWorkflow(source)` to support async URL fetch and catalog resolution:
```javascript
  async loadWorkflow(source) {
    const strSource = String(source).trim();

    // 1. HTTP/HTTPS URL
    if (/^https?:\/\//i.test(strSource)) {
      const { yaml } = await fetchWorkflowFromUrl(strSource);
      return WorkflowDefinition.fromString(yaml, strSource);
    }

    // 2. Local YAML file path
    const path = resolve(strSource);
    if (/\.(yml|yaml)$/i.test(path) && existsSync(path)) {
      return WorkflowDefinition.fromYamlFile(path);
    }

    // 3. Workspace installed workflow (.adlc/workflows/<id>/workflow.yml)
    const installedPath = join(this.projectRoot, ".adlc", "workflows", strSource, "workflow.yml");
    if (existsSync(installedPath)) {
      return WorkflowDefinition.fromYamlFile(installedPath);
    }

    // 4. Bundled catalog workflow
    const catalog = loadBundledCatalog();
    if (catalog.workflows && catalog.workflows[strSource]) {
      const entry = catalog.workflows[strSource];
      const bundledPath = join(getBundledWorkflowsDir(), entry.path.replace(/^workflows\//, ""));
      if (existsSync(bundledPath)) {
        return WorkflowDefinition.fromYamlFile(bundledPath);
      }
    }
    const directBundled = join(getBundledWorkflowsDir(), strSource, "workflow.yml");
    if (existsSync(directBundled)) {
      return WorkflowDefinition.fromYamlFile(directBundled);
    }

    throw new Error(`Workflow not found: ${source}`);
  }
```

Note: Update calls to `loadWorkflow` in `src/commands/workflow.mjs` and `src/workflow/state.mjs` to `await` the result (`await engine.loadWorkflow(source)`).

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test adlc-cli/tests/workflow-engine-resolution.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add adlc-cli/src/workflow/engine.mjs adlc-cli/tests/workflow-engine-resolution.test.mjs
git commit -m "feat(workflow): support URL, file, installed, and catalog resolution in loadWorkflow"
```

---

### Task 4: Delete `src/workflow/builtins.mjs` and Update All Dependent Tests

**Files:**
- Delete: `adlc-cli/src/workflow/builtins.mjs`
- Modify: `adlc-cli/src/workflow/engine.mjs` (remove `getBuiltinWorkflow` import)
- Modify: `adlc-cli/tests/workflow-events.test.mjs`
- Modify: `adlc-cli/tests/workflow-step-output.test.mjs`
- Modify: `adlc-cli/tests/workflow-gate-context-3.test.mjs`

**Interfaces:**
- Consumes: `adlc-cli/workflows/factory/workflow.yml` directly or via `engine.loadWorkflow("factory")`.
- Produces: Complete removal of `builtins.mjs` with zero shims; all tests green.

- [ ] **Step 1: Check all occurrences of `builtins.mjs`**

Run:
```bash
grep -rn "builtins\.mjs" adlc-cli/
```

- [ ] **Step 2: Update `workflow-events.test.mjs`**

Replace:
```javascript
import { BUILTIN_WORKFLOWS } from "../src/workflow/builtins.mjs";
```
With reading `adlc-cli/workflows/factory/workflow.yml`:
```javascript
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FACTORY_YAML = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), "workflows", "factory", "workflow.yml"),
  "utf-8"
);
```
And replace usages of `BUILTIN_WORKFLOWS.factory.yaml` with `FACTORY_YAML`. Also, since `engine.loadWorkflow()` is now async, ensure `await engine.loadWorkflow("factory")` is used in async test functions.

- [ ] **Step 3: Update `workflow-step-output.test.mjs`**

Replace:
```javascript
import { getBuiltinWorkflow } from "../src/workflow/builtins.mjs";
```
With reading `FACTORY_YAML` from `workflows/factory/workflow.yml`. Replace all occurrences of `getBuiltinWorkflow("factory").yaml` with `FACTORY_YAML`.

- [ ] **Step 4: Update `workflow-gate-context-3.test.mjs`**

Replace:
```javascript
import { BUILTIN_WORKFLOWS } from "../src/workflow/builtins.mjs";
```
With reading `FACTORY_YAML` from `workflows/factory/workflow.yml`. Replace `BUILTIN_WORKFLOWS.factory.yaml` with `FACTORY_YAML`.

- [ ] **Step 5: Delete `src/workflow/builtins.mjs` and remove its import in `src/workflow/engine.mjs`**

1. Remove:
```javascript
import { getBuiltinWorkflow } from "./builtins.mjs";
```
from `adlc-cli/src/workflow/engine.mjs`.

2. Delete `adlc-cli/src/workflow/builtins.mjs`:
```bash
rm adlc-cli/src/workflow/builtins.mjs
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
node --test adlc-cli/tests/workflow-events.test.mjs adlc-cli/tests/workflow-step-output.test.mjs adlc-cli/tests/workflow-gate-context-3.test.mjs
```
Expected: PASS with 0 failures.

- [ ] **Step 7: Commit**

```bash
git rm adlc-cli/src/workflow/builtins.mjs
git add adlc-cli/src/workflow/engine.mjs adlc-cli/tests/
git commit -m "refactor(workflow): delete builtins.mjs and load from declarative catalog asset"
```

---

### Task 5: CLI Subcommands: `workflow search`, `workflow add`, `workflow list`

**Files:**
- Modify: `adlc-cli/src/commands/workflow.mjs:48-75, 190-210`
- Modify: `adlc-cli/src/help.mjs:75-85, 410-440`
- Test: `adlc-cli/tests/workflow-cli-commands.test.mjs`

**Interfaces:**
- Consumes: `searchCatalog`, `installWorkflow`, `listWorkflows` from `../workflow/catalog.mjs`.
- Produces:
  - `adlc-cli workflow search [query]`: prints matching workflows with columns (ID, Version, Name, Description).
  - `adlc-cli workflow add <id|url> [--as <name>]`: installs workflow into `.adlc/workflows/<id>/workflow.yml` and registers it.
  - `adlc-cli workflow list`: prints installed workflows and bundled catalog workflows.
  - Updated `printWorkflowHelp()` documentation in `src/help.mjs`.

- [ ] **Step 1: Write the failing test**

Create `adlc-cli/tests/workflow-cli-commands.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "adlc-cli.mjs");

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-cli-cmd-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("adlc-cli workflow search lists catalog entries", () => {
  const res = spawnSync("node", [CLI, "workflow", "search"], { encoding: "utf-8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /factory/);
  assert.match(res.stdout, /Factory Outer Loop/);
});

test("adlc-cli workflow search with query filters results", () => {
  const match = spawnSync("node", [CLI, "workflow", "search", "outer"], { encoding: "utf-8" });
  assert.equal(match.status, 0);
  assert.match(match.stdout, /factory/);

  const nomatch = spawnSync("node", [CLI, "workflow", "search", "xyznonexistent"], { encoding: "utf-8" });
  assert.equal(nomatch.status, 0);
  assert.match(nomatch.stdout, /No workflows found/i);
});

test("adlc-cli workflow add installs workflow into .adlc/workflows/", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const res = spawnSync("node", [CLI, "workflow", "add", "factory"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Installed workflow 'factory'/i);
    assert.ok(existsSync(join(dir, ".adlc", "workflows", "factory", "workflow.yml")));

    const listRes = spawnSync("node", [CLI, "workflow", "list"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(listRes.status, 0);
    assert.match(listRes.stdout, /Installed workflows/i);
    assert.match(listRes.stdout, /factory/);
  } finally {
    cleanup();
  }
});

test("adlc-cli workflow list shows installed and bundled workflows", () => {
  const { dir, cleanup } = makeTmp();
  try {
    const res = spawnSync("node", [CLI, "workflow", "list"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Bundled workflows/i);
    assert.match(res.stdout, /factory/);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test adlc-cli/tests/workflow-cli-commands.test.mjs
```
Expected: FAIL with "Unknown workflow command: 'search'".

- [ ] **Step 3: Write minimal implementation**

1. In `adlc-cli/src/commands/workflow.mjs`:
Import catalog utilities:
```javascript
import { searchCatalog, installWorkflow, listWorkflows } from "../workflow/catalog.mjs";
```

Add subcommands to `cmdWorkflow`:
```javascript
    case "search":
      return cmdWorkflowSearch(rest, rawArgv);
    case "add":
      return cmdWorkflowAdd(rest, rawArgv);
    case "list":
      return cmdWorkflowList(rest, rawArgv);
```

Implement handlers:
```javascript
async function cmdWorkflowSearch(rest, rawArgv) {
  const query = firstPositional(rest, rawArgv) ?? "";
  const results = searchCatalog(query);
  if (results.length === 0) {
    out(tint("No workflows found matching query.", "gray"));
    return 0;
  }
  const rows = results.map((w) => [
    tint(w.id, "bold"),
    tint(w.version || "0.0.0", "gray"),
    w.name || "",
    tint(w.description || "", "gray"),
  ]);
  table(["ID", "Version", "Name", "Description"], rows);
  return 0;
}

async function cmdWorkflowAdd(rest, rawArgv) {
  const idOrUrl = firstPositional(rest, rawArgv);
  if (!idOrUrl) {
    err("Usage: adlc-cli workflow add <id|url> [--as <name>]");
    return 1;
  }
  const asName = extractFlagValue(rawArgv, "as");
  try {
    const result = await installWorkflow(process.cwd(), idOrUrl, { as: asName });
    success(`Installed workflow '${result.id}' to ${result.path}`);
    return 0;
  } catch (exc) {
    error(exc.message);
    return 1;
  }
}

async function cmdWorkflowList(rest, rawArgv) {
  const { installed, bundled } = listWorkflows(process.cwd());

  out(section("Installed workflows", []));
  if (installed.length === 0) {
    out(tint("  (none installed in this workspace)", "gray"));
  } else {
    const rows = installed.map((w) => [
      tint(w.id, "bold"),
      tint(w.version || "0.0.0", "gray"),
      w.name || "",
      tint(w.path || "", "gray"),
    ]);
    table(["ID", "Version", "Name", "Path"], rows);
  }

  out("");
  out(section("Bundled workflows", []));
  if (bundled.length === 0) {
    out(tint("  (none)", "gray"));
  } else {
    const rows = bundled.map((w) => [
      tint(w.id, "bold"),
      tint(w.version || "0.0.0", "gray"),
      w.name || "",
      tint(w.description || "", "gray"),
    ]);
    table(["ID", "Version", "Name", "Description"], rows);
  }
  return 0;
}
```

Make sure `cmdWorkflowRun` and `cmdWorkflowValidate` await `engine.loadWorkflow(source)`.

2. In `adlc-cli/src/help.mjs`:
Add `search`, `add`, and `list` to workflow commands:
```javascript
        ["workflow search [query]", "Search available workflows in catalog"],
        ["workflow add <id|url> [--as <name>]", "Install a workflow from catalog or URL into workspace"],
        ["workflow list", "List installed and bundled workflows"],
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test adlc-cli/tests/workflow-cli-commands.test.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add adlc-cli/src/commands/workflow.mjs adlc-cli/src/help.mjs adlc-cli/tests/workflow-cli-commands.test.mjs
git commit -m "feat(workflow): add workflow search, add, and list CLI commands"
```

---

### Task 6: Full Integration & Regression Suite Verification

**Files:**
- Test: All tests in `adlc-cli/tests/`

- [ ] **Step 1: Run the full test suite**

Run:
```bash
npm test
```
(in `adlc-cli/`)
Expected: All tests pass (838+ passing tests, 0 failures, e2e passing).

- [ ] **Step 2: Verify zero residual references to `builtins.mjs`**

Run:
```bash
grep -rn "builtins\.mjs" adlc-cli/
```
Expected: Zero matches in `adlc-cli/src/` or `adlc-cli/tests/`.

- [ ] **Step 3: Run git status and verify clean tree**

Run:
```bash
git status --porcelain adlc-cli/
```
Verify only intended tracked changes exist.

- [ ] **Step 4: Commit any final test adjustments**

```bash
git commit -m "chore(workflow): verify complete test suite and zero legacy builtins.mjs references" --allow-empty
```
