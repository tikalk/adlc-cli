// src/utils/init-options.mjs — Read/write/merge .adlc/init-options.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const INIT_OPTIONS_PATH = ".adlc/init-options.json";

export function readInitOptions(projectRoot = process.cwd()) {
  const path = join(projectRoot, INIT_OPTIONS_PATH);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function writeInitOptions(updates, projectRoot = process.cwd()) {
  const dir = join(projectRoot, ".adlc");
  const path = join(dir, "init-options.json");
  const existing = readInitOptions(projectRoot);
  const merged = { ...existing, ...updates };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return merged;
}

export function readAgent(projectRoot = process.cwd()) {
  return readInitOptions(projectRoot).agent || null;
}

export function writeAgent(agent, projectRoot = process.cwd()) {
  // Never silently switch the workspace's primary agent: `skills add -a`
  // installs for a (possibly secondary) agent, so it must not retarget the
  // primary. First write wins; pass { force: true } to switch deliberately.
  const existing = readInitOptions(projectRoot).agent;
  if (existing && existing !== agent) return readInitOptions(projectRoot);
  return writeInitOptions({ agent }, projectRoot);
}

// `skills_source` is a string (one source) or an array of strings (several).
// Normalize to a de-duplicated array of non-empty strings.
export function normalizeSkillsSources(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter((s) => typeof s === "string" && s.trim() !== ""))];
}

// Returns the configured sources as an array, or null when none are configured.
export function readSkillsSource(projectRoot = process.cwd()) {
  const sources = normalizeSkillsSources(readInitOptions(projectRoot).skills_source);
  return sources.length > 0 ? sources : null;
}

// Adds `source` to the configured sources (never drops an existing one).
// A single source stays a plain string so existing files keep their format.
export function writeSkillsSource(source, projectRoot = process.cwd()) {
  const merged = normalizeSkillsSources([
    ...(readSkillsSource(projectRoot) ?? []),
    ...normalizeSkillsSources(source),
  ]);
  return writeInitOptions({ skills_source: merged.length === 1 ? merged[0] : merged }, projectRoot);
}

export function readTeamAiDirectives(projectRoot = process.cwd()) {
  return readInitOptions(projectRoot).team_ai_directives || null;
}
