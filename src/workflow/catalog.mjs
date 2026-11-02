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
