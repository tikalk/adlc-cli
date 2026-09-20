// Events layer — generates per-event native hook configs from a skills repo's
// `.events.json` manifest. Supports 4 context-injection agents (opencode,
// Claude Code, Cursor, Copilot) across 6 canonical events.
//
// Architecture (spec-kit model, ported to Node):
//   .events.json → resolve events → generate native hook entries →
//   dispatcher.mjs (shipped to project) → stdout → agent context injection
//
// Two execution paths in the dispatcher (both first-class):
//   - Script path (spec-kit): skill has `scripts:` → run script → stdout
//   - Body path (superpowers): no scripts → output skill body → stdout

import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVENT_AGENTS,
  EVENT_MARKER,
  DISPATCHER_REL,
  BODY_INJECTION_EVENTS,
  GENERATED_TEXT,
  SOURCE_MARKER,
  resolveEnvelope,
} from "./registry.mjs";
import { parseFrontmatter } from "./frontmatter.mjs";

const MARKER = `${GENERATED_TEXT}; ${SOURCE_MARKER} adlc-events`;

// ── Dispatcher installation ─────────────────────────────────────────────

export function getDispatcherContent() {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dispatcher.mjs"), "utf-8");
}

export function installDispatcher(projectRoot) {
  const targetDir = join(projectRoot, ".agents");
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, "dispatcher.mjs");

  // Safe-destination validation (spec-kit #12): reject symlinked-ancestor paths.
  validateSafeDestination(target, projectRoot);

  writeFileSync(target, getDispatcherContent(), "utf-8");
  return target;
}

// ── .events.json discovery ──────────────────────────────────────────────

export function readLocalEventsManifest(sourcePath) {
  const manifestPath = join(sourcePath, ".events.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    if (raw.includes("\uFFFD")) {
      // Non-UTF-8 manifest (spec-kit #3900): Node's utf-8 decode never throws,
      // it substitutes U+FFFD — detect it and skip with a warning instead of
      // silently dropping events or crashing on mojibake JSON.
      console.warn(`adlc-cli: ${manifestPath} is not valid UTF-8 — skipping events`);
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function fetchEventsManifest(source) {
  // Local path (., ./, ../, /)
  if (source === "." || source.startsWith("./") || source.startsWith("/") || source.startsWith("../")) {
    return readLocalEventsManifest(source);
  }

  // GitHub shorthand: owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return await fetchGitHubRaw(source, "HEAD", ".events.json");
  }

  // Full GitHub URL: https://github.com/owner/repo
  const ghMatch = source.match(/^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)/);
  if (ghMatch) {
    return await fetchGitHubRaw(ghMatch[1], "HEAD", ".events.json");
  }

  // Bare local directory name (e.g., "adlc-team-skills").
  // The skills CLI falls back to { type: "git", url: source } for inputs that
  // match no URL/shorthand pattern, and git treats bare names as local paths
  // (git clone <dir>). Probe for a local .events.json so events aren't
  // silently dropped when the source is a local directory clone.
  if (existsSync(source)) {
    return readLocalEventsManifest(source);
  }

  return null;
}

async function fetchGitHubRaw(ownerRepo, ref, file) {
  const url = `https://raw.githubusercontent.com/${ownerRepo}/${ref}/${file}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.text();
    if (raw.includes("\uFFFD")) {
      // Same non-UTF-8 guard as readLocalEventsManifest (spec-kit #3900).
      console.warn(`adlc-cli: ${url} is not valid UTF-8 — skipping events`);
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Event resolution ────────────────────────────────────────────────────

export function resolveEvents(manifest, agentConfig) {
  if (!manifest || !manifest.events) return {};
  if (!agentConfig) return {};

  const resolved = {};
  for (const [canonicalEvent, handlers] of Object.entries(manifest.events)) {
    const nativeEvent = agentConfig.canonical_to_native[canonicalEvent];
    if (!nativeEvent) continue; // agent doesn't support this event (null = skip)

    const handlerList = Array.isArray(handlers) ? handlers : [handlers];
    resolved[canonicalEvent] = handlerList.filter((h) => h && h.skill).map((h) => ({
      skill: h.skill,
      description: h.description || "",
      timeout: h.timeout || 60,
      matcher: h.matcher || null,
      nativeEvent,
    }));
  }
  return resolved;
}

// ── Native hook config generation ───────────────────────────────────────

export function installEvents(agentKey, projectRoot, resolvedEvents, agentSkillsDir) {
  const agentConfig = EVENT_AGENTS[agentKey];
  if (!agentConfig) return null;

  if (Object.keys(resolvedEvents).length === 0) {
    // Empty resolved map: strip prior hooks (spec-kit #3).
    return removeNativeEventHooks(agentKey, projectRoot);
  }

  switch (agentConfig.format) {
    case "ts-plugin":
      return generateOpenCodePlugin(projectRoot, resolvedEvents, agentSkillsDir, agentConfig);
    case "json-nested":
      return generateJsonNested(agentKey, projectRoot, resolvedEvents, agentSkillsDir, agentConfig);
    case "copilot-json":
      return generateCopilotJson(projectRoot, resolvedEvents, agentSkillsDir, agentConfig);
    case "toml":
      return generateToml(projectRoot, resolvedEvents, agentSkillsDir, agentConfig, agentKey);
    case "json-root-nested":
      return generateJsonRootNested(projectRoot, resolvedEvents, agentSkillsDir, agentConfig, agentKey);
    default:
      return null;
  }
}

// ── opencode: TypeScript plugin ─────────────────────────────────────────

function generateOpenCodePlugin(projectRoot, resolvedEvents, skillsDir, agentConfig) {
  const hookEntries = buildOpenCodeHooks(resolvedEvents, skillsDir, agentConfig);

  const content = `// ${MARKER} — do not edit
import type { Plugin } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"
import { statSync } from "node:fs"

let DISPATCHER = ""
let SKILLS_DIR = ${JSON.stringify(skillsDir)}

// Cache for session_start handlers — experimental.chat.messages.transform
// fires on every step, but the script output is stable for the session.
// Keyed by skill name so multiple session_start handlers each get their own cache.
const _sessionStartCache: Record<string, string> = {}

// Track init-options.json state so the cache invalidates when team-setup
// creates/modifies/deletes the config (e.g., unconfigured → configured).
let _sessionStartState: { exists: boolean; mtime: number } = { exists: false, mtime: 0 }

function runEvent(command: string, event: string, timeoutSec: number): string {
  try {
    const result = execFileSync("node", [DISPATCHER, event, command, SKILLS_DIR, String(timeoutSec)], {
      input: "",
      encoding: "utf-8",
      timeout: (timeoutSec + 5) * 1000,
    })
    return result
  } catch (e) {
    throw new Error("adlc event " + command + " (" + event + ") failed: " + (e as Error).message)
  }
}

export const AdlcEventsPlugin: Plugin = async ({ directory }) => {
  DISPATCHER = resolve(directory, ".agents", "dispatcher.mjs")
  return {
${hookEntries}
  }
}
`;

  const target = join(projectRoot, agentConfig.config_file);
  validateSafeDestination(target, projectRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf-8");
  return { path: agentConfig.config_file, merged: false };
}

function buildOpenCodeHooks(resolvedEvents, skillsDir, agentConfig) {
  const entries = [];
  for (const [canonicalEvent, handlers] of Object.entries(resolvedEvents)) {
    const nativeEvent = agentConfig.canonical_to_native[canonicalEvent];
    for (const h of handlers) {
      // Different opencode hooks have different output shapes:
      // - experimental.chat.messages.transform: inject into first user message (active instructions)
      // - tool.execute.before/after: output.args (not context injection)
      //
      // Every handler degrades gracefully: runEvent failures are caught and
      // logged, never rethrown, so a broken event can't crash the session.
      if (nativeEvent === "experimental.chat.messages.transform") {
        entries.push(`    "${nativeEvent}": async (_input, output) => {
      try {
        // Invalidate cache when .adlc/init-options.json changes (team-setup ran)
        let _exists = false, _mtime = 0
        try { const st = statSync(".adlc/init-options.json"); _exists = true; _mtime = st.mtimeMs } catch {}
        const _stateChanged = _exists !== _sessionStartState.exists || _mtime !== _sessionStartState.mtime
        if (_stateChanged) {
          for (const k of Object.keys(_sessionStartCache)) delete _sessionStartCache[k]
          _sessionStartState = { exists: _exists, mtime: _mtime }
        }
        const _key = ${JSON.stringify(h.skill)}
        if (!(_key in _sessionStartCache)) {
          _sessionStartCache[_key] = runEvent(_key, ${JSON.stringify(canonicalEvent)}, ${h.timeout})
        }
        const ctx = _sessionStartCache[_key]
        if (!ctx) return
        // Inject into first user message (active instructions, not passive system prompt)
        const firstUser = output.messages.find((m: any) => m.info.role === 'user')
        if (!firstUser || !firstUser.parts.length) return
        // Guard: skip if already injected (prevents double-injection on step re-fires)
        if (firstUser.parts.some((p: any) => p.type === 'text' && p.text.includes('EXTREMELY_IMPORTANT'))) return
        const ref = firstUser.parts[0]
        firstUser.parts.unshift({ ...ref, type: 'text', text: ctx })
      } catch (e) {
        console.error("adlc messages.transform hook failed:", (e as Error).message)
      }
    }`);
      } else if (nativeEvent === "chat.message") {
        // Part id must start with "prt" (opencode Identifier brand). Derive it
        // from the last existing part (keeps the brand even if opencode changes
        // its prefix), falling back to "prt_" when output.parts is empty.
        entries.push(`    "${nativeEvent}": async (input, output) => {
      try {
        const ctx = runEvent(${JSON.stringify(h.skill)}, ${JSON.stringify(canonicalEvent)}, ${h.timeout})
        if (!ctx) return
        const base = output.parts[output.parts.length - 1]?.id ?? "prt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
        output.parts.push({ id: base + ".adlc" + Math.random().toString(36).slice(2, 8), sessionID: input.sessionID, messageID: output.message.id, type: "text", text: ctx, synthetic: true })
      } catch (e) {
        console.error("adlc chat.message hook failed:", (e as Error).message)
      }
    }`);
      } else {
        // Generic fallback for tool.execute.before/after etc.
        entries.push(`    "${nativeEvent}": async (_input, output) => {
      try {
        const ctx = runEvent(${JSON.stringify(h.skill)}, ${JSON.stringify(canonicalEvent)}, ${h.timeout})
        if (ctx && output.system) output.system.push(ctx)
      } catch (e) {
        console.error(${JSON.stringify(`adlc ${nativeEvent} hook failed:`)}, (e as Error).message)
      }
    }`);
      }
    }
  }
  return entries.join(",\n");
}

// ── Claude Code / Cursor: nested JSON merge ─────────────────────────────

function generateJsonNested(agentKey, projectRoot, resolvedEvents, skillsDir, agentConfig) {
  const configPath = join(projectRoot, agentConfig.config_file);
  validateSafeDestination(configPath, projectRoot);
  mkdirSync(dirname(configPath), { recursive: true });

  // Build our hook entries (with marker for idempotent merge).
  const newEntries = buildJsonNestedHooks(resolvedEvents, skillsDir, agentConfig, agentKey);

  let existing = {};
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      existing = parseJsonPreserving(raw);
    } catch {
      // JSONC preservation (#22): abort on parse failure, don't reset to {}.
      return { path: agentConfig.config_file, merged: false, error: "parse-failed-preserved" };
    }
  }

  // Idempotent merge: strip all marker entries, then add fresh ones.
  const merged = mergeJsonNested(existing, newEntries, agentConfig);
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return { path: agentConfig.config_file, merged: true };
}

function buildJsonNestedHooks(resolvedEvents, skillsDir, agentConfig, agentKey) {
  // Returns { <NativeEvent>: [ { type, command, timeout?, _adlc_skills_cli: true } ] }
  const result = {};
  for (const [canonicalEvent, handlers] of Object.entries(resolvedEvents)) {
    const nativeEvent = agentConfig.canonical_to_native[canonicalEvent];
    const entries = [];
    for (const h of handlers) {
      const cmd = buildDispatcherCommand(canonicalEvent, h, skillsDir, agentKey);
      const entry = {
        type: "command",
        command: cmd,
        [EVENT_MARKER]: true,
      };
      // Include timeout in the agent's native unit (ms for gemini/qwen/tabnine).
      entry.timeout = nativeTimeout(agentConfig, h.timeout || 60);
      if (h.matcher) entry.matcher = h.matcher;
      entries.push(entry);
    }
    if (entries.length > 0) result[nativeEvent] = entries;
  }
  return result;
}

function buildDispatcherCommand(event, handler, skillsDir, agentKey) {
  const timeout = handler.timeout || 60;
  // Context-injection envelope (registry.mjs): appended as a 5th arg so the
  // dispatcher wraps stdout in the JSON shape this agent's hook protocol
  // requires. Plain-passthrough agents (Claude/Codex) get no extra arg.
  const agentConfig = EVENT_AGENTS[agentKey];
  const envelope = agentConfig ? resolveEnvelope(agentConfig, event) : undefined;
  const envelopeArg = envelope ? " " + envelope : "";
  // Claude Code: use ${CLAUDE_PROJECT_DIR}/ for portability (shell-expanded).
  if (agentKey === "claude-code") {
    // Use string concatenation to avoid template-literal interpolation of
    // CLAUDE_PROJECT_DIR (it must be literal in the generated command string).
    const projDir = "${CLAUDE_PROJECT_DIR}";
    return 'node "' + projDir + "/" + DISPATCHER_REL + '" ' + event + " " + handler.skill + " " + skillsDir + " " + timeout + envelopeArg;
  }
  // Codex: use absolute path relative to project root via $(pwd).
  if (agentKey === "codex") {
    return `node ${DISPATCHER_REL} ${event} ${handler.skill} ${skillsDir} ${timeout}${envelopeArg}`;
  }
  // Cursor / generic: relative path.
  return `node ${DISPATCHER_REL} ${event} ${handler.skill} ${skillsDir} ${timeout}${envelopeArg}`;
}

// Convert timeout to the agent's native unit (seconds or milliseconds).
function nativeTimeout(agentConfig, timeoutSeconds) {
  const unit = agentConfig.timeout_unit || "s";
  if (unit === "ms") return timeoutSeconds * 1000;
  return timeoutSeconds;
}

function mergeJsonNested(existing, newEntries, agentConfig) {
  const result = { ...existing };
  const mergeKey = agentConfig.merge_key || "hooks";
  if (!result[mergeKey]) result[mergeKey] = {};

  for (const [nativeEvent, entries] of Object.entries(newEntries)) {
    let existingList = result[mergeKey][nativeEvent] || [];
    // Strip prior marker entries (idempotent — no duplicates on re-install).
    existingList = existingList.filter((e) => !e || !e[EVENT_MARKER]);
    existingList.push(...entries);
    if (existingList.length > 0) {
      result[mergeKey][nativeEvent] = existingList;
    } else {
      delete result[mergeKey][nativeEvent];
    }
  }

  // Clean up empty hook objects.
  if (result[mergeKey] && Object.keys(result[mergeKey]).length === 0) {
    delete result[mergeKey];
  }
  return result;
}

// ── Copilot: dedicated JSON file ────────────────────────────────────────

function generateCopilotJson(projectRoot, resolvedEvents, skillsDir, agentConfig) {
  const configPath = join(projectRoot, agentConfig.config_file);
  validateSafeDestination(configPath, projectRoot);
  mkdirSync(dirname(configPath), { recursive: true });

  const copilotHooks = buildCopilotHooks(resolvedEvents, skillsDir, agentConfig);

  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = parseJsonPreserving(readFileSync(configPath, "utf-8"));
    } catch {
      return { path: agentConfig.config_file, merged: false, error: "parse-failed-preserved" };
    }
  }

  // Merge: strip marker entries, add fresh.
  const merged = mergeCopilotJson(existing, copilotHooks);
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return { path: agentConfig.config_file, merged: true };
}

function buildCopilotHooks(resolvedEvents, skillsDir, agentConfig) {
  const result = {};
  for (const [canonicalEvent, handlers] of Object.entries(resolvedEvents)) {
    const nativeEvent = agentConfig.canonical_to_native[canonicalEvent];
    const entries = [];
    for (const h of handlers) {
      const bashCmd = buildDispatcherCommand(canonicalEvent, h, skillsDir, "github-copilot");
      const envelope = resolveEnvelope(agentConfig, canonicalEvent);
      const envelopeArg = envelope ? " " + envelope : "";
      const psCmd = `node ${DISPATCHER_REL.replace(/\//g, "\\")} ${canonicalEvent} ${h.skill} ${skillsDir.replace(/\//g, "\\")} ${h.timeout || 60}${envelopeArg}`;
      entries.push({
        type: "command",
        bash: bashCmd,
        powershell: psCmd,
        timeoutSec: h.timeout || 60,
        [EVENT_MARKER]: true,
      });
    }
    if (entries.length > 0) result[nativeEvent] = entries;
  }
  return result;
}

function mergeCopilotJson(existing, newHooks) {
  const result = { ...existing };
  for (const [nativeEvent, entries] of Object.entries(newHooks)) {
    let existingList = result[nativeEvent] || [];
    existingList = existingList.filter((e) => !e || !e[EVENT_MARKER]);
    existingList.push(...entries);
    if (existingList.length > 0) {
      result[nativeEvent] = existingList;
    } else {
      delete result[nativeEvent];
    }
  }
  return result;
}

// ── Codex: TOML format (.codex/config.toml) ─────────────────────────────

function generateToml(projectRoot, resolvedEvents, skillsDir, agentConfig, agentKey) {
  const configPath = join(projectRoot, agentConfig.config_file);
  validateSafeDestination(configPath, projectRoot);
  mkdirSync(dirname(configPath), { recursive: true });

  // Build TOML fragment for our hooks.
  const tomlFragment = buildTomlFragment(resolvedEvents, skillsDir, agentConfig, agentKey);

  let existingContent = "";
  if (existsSync(configPath)) {
    try {
      existingContent = readFileSync(configPath, "utf-8");
    } catch {
      // Unreadable config (EACCES, EISDIR): preserve, never overwrite (spec-kit #3861).
      return { path: agentConfig.config_file, merged: false, error: "read-failed-preserved" };
    }
  }

  // Idempotent: strip prior marker blocks, then append fresh.
  const cleaned = stripTomlMarkerBlocks(existingContent);
  const newContent = cleaned + (cleaned && !cleaned.endsWith("\n") ? "\n\n" : cleaned ? "\n" : "") + tomlFragment;
  writeFileSync(configPath, newContent, "utf-8");
  return { path: agentConfig.config_file, merged: true };
}

function buildTomlFragment(resolvedEvents, skillsDir, agentConfig, agentKey) {
  const lines = [`# ${MARKER} — do not edit`];
  for (const [canonicalEvent, handlers] of Object.entries(resolvedEvents)) {
    const nativeEvent = agentConfig.canonical_to_native[canonicalEvent];
    for (const h of handlers) {
      const cmd = buildDispatcherCommand(canonicalEvent, h, skillsDir, agentKey);
      const timeout = nativeTimeout(agentConfig, h.timeout || 60);
      const matcher = h.matcher || "*";
      lines.push("");
      lines.push(`[[hooks.${nativeEvent}]]`);
      lines.push(`matcher = ${tomlQuote(matcher)}`);
      lines.push("");
      lines.push(`[[hooks.${nativeEvent}.hooks]]`);
      lines.push(`type = "command"`);
      lines.push(`command = ${tomlQuote(cmd)}`);
      lines.push(`timeout = ${timeout}`);
      lines.push(`adlc_skills_marker = true`);
    }
  }
  return lines.join("\n") + "\n";
}

function tomlQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function stripTomlMarkerBlocks(content) {
  // Remove [[hooks.*]] top-level blocks (and their [[hooks.*.hooks]] sub-blocks)
  // that contain adlc_skills_marker = true.
  const lines = content.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Match top-level hooks blocks: [[hooks.<Event>]] (no .hooks suffix)
    const isTopLevelHook = /^\[\[hooks\.\w+\]\]$/.test(line.trim());

    if (isTopLevelHook) {
      // Collect this block (top-level + sub-blocks) until the next top-level
      // [[hooks.<Event>]] or a non-[[ line.
      const blockLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (/^\[\[hooks\.\w+\]\]$/.test(nextLine)) break; // next top-level
        blockLines.push(lines[j]);
        j++;
      }

      // Check if this block has our marker (adlc_skills_marker = true on a hook entry).
      // Do NOT check for the comment MARKER — it's a file-level header that
      // can appear between blocks and would cause false positives.
      const hasMarker = blockLines.some((l) => l.includes("adlc_skills_marker = true"));

      if (hasMarker) {
        i = j; // skip the entire block
        continue;
      }
    }

    result.push(line);
    i++;
  }

  // Clean up excessive blank lines.
  return result.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trimEnd() + "\n";
}

// ── Devin: root-nested JSON (.devin/hooks.v1.json) ──────────────────────

function generateJsonRootNested(projectRoot, resolvedEvents, skillsDir, agentConfig, agentKey) {
  const configPath = join(projectRoot, agentConfig.config_file);
  validateSafeDestination(configPath, projectRoot);
  mkdirSync(dirname(configPath), { recursive: true });

  // Build root-level entries: { <NativeEvent>: [ {type, command, timeout, _adlc_skills_cli: true} ] }
  const newEntries = buildJsonNestedHooks(resolvedEvents, skillsDir, agentConfig, agentKey);

  let existing = {};
  if (existsSync(configPath)) {
    try {
      existing = parseJsonPreserving(readFileSync(configPath, "utf-8"));
    } catch {
      return { path: agentConfig.config_file, merged: false, error: "parse-failed-preserved" };
    }
  }

  // Merge at root level (no "hooks" wrapper).
  const merged = mergeJsonRootNested(existing, newEntries);
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return { path: agentConfig.config_file, merged: true };
}

function mergeJsonRootNested(existing, newEntries) {
  const result = { ...existing };
  for (const [nativeEvent, entries] of Object.entries(newEntries)) {
    let existingList = result[nativeEvent] || [];
    existingList = existingList.filter((e) => !e || !e[EVENT_MARKER]);
    existingList.push(...entries);
    if (existingList.length > 0) {
      result[nativeEvent] = existingList;
    } else {
      delete result[nativeEvent];
    }
  }
  return result;
}

// ── Teardown (surgical removal) ─────────────────────────────────────────

export function removeEvents(agentKey, projectRoot) {
  const agentConfig = EVENT_AGENTS[agentKey];
  if (!agentConfig) return null;

  const configPath = join(projectRoot, agentConfig.config_file);

  if (agentConfig.format === "ts-plugin") {
    // Dedicated file — delete if it has our marker.
    if (existsSync(configPath)) {
      validateSafeDestination(configPath, projectRoot);
      let content;
      try {
        content = readFileSync(configPath, "utf-8");
      } catch {
        // Unreadable plugin file: leave it alone (spec-kit #3861).
        return { path: agentConfig.config_file, action: "manual" };
      }
      if (content.includes(MARKER)) {
        rmSync(configPath);
        return { path: agentConfig.config_file, action: "deleted" };
      }
    }
    return null;
  }

  if (agentConfig.format === "copilot-json") {
    if (existsSync(configPath)) {
      validateSafeDestination(configPath, projectRoot);
      try {
        const data = parseJsonPreserving(readFileSync(configPath, "utf-8"));
        const cleaned = stripMarkerEntries(data);
        if (Object.keys(cleaned).length === 0) {
          return { path: agentConfig.config_file, action: "deleted" };
        }
        writeFileSync(configPath, JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
        return { path: agentConfig.config_file, action: "cleaned" };
      } catch {
        return { path: agentConfig.config_file, action: "manual" };
      }
    }
    return null;
  }

  if (agentConfig.format === "json-nested") {
    return removeNativeEventHooks(agentKey, projectRoot);
  }

  if (agentConfig.format === "json-root-nested") {
    return removeRootNestedEvents(agentKey, projectRoot);
  }

  if (agentConfig.format === "toml") {
    return removeTomlEvents(agentKey, projectRoot);
  }

  return null;
}

function removeNativeEventHooks(agentKey, projectRoot) {
  const agentConfig = EVENT_AGENTS[agentKey];
  const configPath = join(projectRoot, agentConfig.config_file);
  if (!existsSync(configPath)) return null;

  // Safe-destination validation on teardown too (spec-kit R3): a symlinked
  // config must not redirect rewrites outside the project.
  validateSafeDestination(configPath, projectRoot);

  try {
    const data = parseJsonPreserving(readFileSync(configPath, "utf-8"));
    const mergeKey = agentConfig.merge_key || "hooks";
    if (!data[mergeKey]) return { path: agentConfig.config_file, action: "no-hooks" };

    let removedAny = false;
    for (const event of Object.keys(data[mergeKey])) {
      const before = data[mergeKey][event].length;
      data[mergeKey][event] = data[mergeKey][event].filter((e) => !e || !e[EVENT_MARKER]);
      if (data[mergeKey][event].length < before) removedAny = true;
      if (data[mergeKey][event].length === 0) delete data[mergeKey][event];
    }
    if (Object.keys(data[mergeKey]).length === 0) delete data[mergeKey];

    if (removedAny) {
      writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      return { path: agentConfig.config_file, action: "cleaned" };
    }
    return { path: agentConfig.config_file, action: "no-hooks" };
  } catch {
    return { path: agentConfig.config_file, action: "manual" };
  }
}

function stripMarkerEntries(data) {
  const result = { ...data };
  for (const key of Object.keys(result)) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].filter((e) => !e || !e[EVENT_MARKER]);
      if (result[key].length === 0) delete result[key];
    }
  }
  return result;
}

function removeRootNestedEvents(agentKey, projectRoot) {
  const agentConfig = EVENT_AGENTS[agentKey];
  const configPath = join(projectRoot, agentConfig.config_file);
  if (!existsSync(configPath)) return null;

  validateSafeDestination(configPath, projectRoot);

  try {
    const data = parseJsonPreserving(readFileSync(configPath, "utf-8"));
    let removedAny = false;
    for (const event of Object.keys(data)) {
      if (!Array.isArray(data[event])) continue;
      const before = data[event].length;
      data[event] = data[event].filter((e) => !e || !e[EVENT_MARKER]);
      if (data[event].length < before) removedAny = true;
      if (data[event].length === 0) delete data[event];
    }

    if (removedAny) {
      if (Object.keys(data).length === 0) {
        rmSync(configPath);
        return { path: agentConfig.config_file, action: "deleted" };
      }
      writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
      return { path: agentConfig.config_file, action: "cleaned" };
    }
    return { path: agentConfig.config_file, action: "no-hooks" };
  } catch {
    return { path: agentConfig.config_file, action: "manual" };
  }
}

function removeTomlEvents(agentKey, projectRoot) {
  const agentConfig = EVENT_AGENTS[agentKey];
  const configPath = join(projectRoot, agentConfig.config_file);
  if (!existsSync(configPath)) return null;

  validateSafeDestination(configPath, projectRoot);

  let content;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    // Unreadable config: leave it alone, ask for manual removal (spec-kit #3861).
    return { path: agentConfig.config_file, action: "manual" };
  }
  if (!content.includes("adlc_skills_marker") && !content.includes(MARKER)) {
    return { path: agentConfig.config_file, action: "no-hooks" };
  }

  const cleaned = stripTomlMarkerBlocks(content);
  // If only our marker comment remains, delete the file.
  const trimmed = cleaned.trim();
  if (!trimmed || trimmed === `# ${MARKER} — do not edit`) {
    rmSync(configPath);
    return { path: agentConfig.config_file, action: "deleted" };
  }
  writeFileSync(configPath, cleaned, "utf-8");
  return { path: agentConfig.config_file, action: "cleaned" };
}

// ── Safety: JSONC preservation ──────────────────────────────────────────

function parseJsonPreserving(raw) {
  // Strip JSONC comments (// and /* */) before parsing.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(stripped);
}

// ── Safety: safe-destination validation (spec-kit #12) ──────────────────

function validateSafeDestination(targetPath, projectRoot) {
  // Canonicalize the root once (resolves symlinks, e.g. macOS /var → /private/var).
  let realRoot;
  try {
    realRoot = realpathSync(projectRoot);
  } catch {
    return; // can't validate, proceed
  }

  // Build the canonical target relative to the real root. This keeps both
  // sides on the same realpath basis so symlinked temp dirs (macOS /var)
  // don't produce false "outside project root" positives.
  const relTarget = relative(projectRoot, targetPath);
  let canonicalTarget = relTarget.startsWith("..")
    ? resolve(targetPath) // already escaping — keep absolute
    : resolve(realRoot, relTarget);

  // Walk existing ancestors of the target, realpath-ing each, to catch
  // genuine symlink redirects that point outside the project root (spec-kit #12).
  // We stop at the first existing ancestor so new-file paths validate against
  // their real parent rather than the (non-existent) target itself.
  let check = canonicalTarget;
  let realAncestor = null;
  while (check && check !== dirname(check)) {
    if (existsSync(check)) {
      try {
        realAncestor = realpathSync(check);
      } catch {
        realAncestor = check;
      }
      break;
    }
    check = dirname(check);
  }

  const base = realAncestor || canonicalTarget;
  const rel = relative(realRoot, base);

  // If the resolved ancestor escapes the project root, reject.
  if (rel.startsWith("..") || (isAbsolute(rel) && !base.startsWith(realRoot))) {
    throw new Error(`Unsafe destination: ${targetPath} resolves outside project root (possible symlink redirect)`);
  }
}
