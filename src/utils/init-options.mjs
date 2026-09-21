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
  return writeInitOptions({ agent }, projectRoot);
}

export function readSkillsSource(projectRoot = process.cwd()) {
  return readInitOptions(projectRoot).skills_source || null;
}

export function writeSkillsSource(source, projectRoot = process.cwd()) {
  return writeInitOptions({ skills_source: source }, projectRoot);
}

export function readTeamAiDirectives(projectRoot = process.cwd()) {
  return readInitOptions(projectRoot).team_ai_directives || null;
}
