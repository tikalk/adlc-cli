// Windows-safe launcher spawn.
//
// npm bin shims (npx, claude, gemini, ...) are .cmd/.bat scripts on Windows;
// CreateProcess cannot exec them directly, so spawnSync("npx", ...) fails
// with ENOENT even though the same command works in cmd/PowerShell and a
// real Linux npx binary works in WSL/Git Bash (spec-kit-style launchers —
// same class of bug as Node's CVE-2024-27980 EINVAL for shell-less .cmd
// spawns). shell: true hands the command line to cmd.exe, which resolves
// the shim through PATHEXT. POSIX spawns stay shell-less and unchanged.

import { spawn, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

// With shell enabled, node joins [file, ...args] into one command line
// verbatim and does NOT quote for us — quote anything containing whitespace
// or a cmd.exe metacharacter so it survives as a single token.
// NB: do not combine shell: true with detached: true on Windows — the
// DETACHED_PROCESS flag drops the child's stdout pipe (verified: child runs
// and exits, but zero bytes reach the parent).
function quoteWinArg(arg) {
  const s = String(arg);
  return /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function spawnCompatSync(file, args, options = {}) {
  if (!isWindows) return spawnSync(file, args, options);
  return spawnSync(quoteWinArg(file), args.map(quoteWinArg), { ...options, shell: true });
}

export function spawnCompat(file, args, options = {}) {
  if (!isWindows) return spawn(file, args, options);
  return spawn(quoteWinArg(file), args.map(quoteWinArg), { ...options, shell: true });
}

// The npm-executed entry point: every `spawnSync("npx", ...)` call site goes
// through this so Windows resolves npx.cmd instead of ENOENT-ing.
export function spawnNpxSync(args, options = {}) {
  return spawnCompatSync("npx", args, options);
}

// Version-aware `skills` package spec for npx.
//
// skills >= 1.5.19 declares engines node >= 22.20 (it imports the
// fs/promises `glob` export, absent on older Nodes → hard SyntaxError
// crash), so 1.5.18 is the newest release that runs on Node 18/20. A bare
// `skills` spec cannot be trusted there either: a cold npx cache fetches
// latest (1.7.2 → crash), so pin the newest engine-compatible release
// explicitly. On capable Nodes keep skills@latest to defeat the stale npx
// cache (it served 1.5.18 days after 1.7.2 shipped). Unparseable versions
// fall back to the pinned spec — it runs on every supported Node.
// Pure function of the version string so unit tests can inject versions
// (no live-network assertions).
export function resolveSkillsPackageSpec(version = process.version) {
  const m = /^v?(\d+)\.(\d+)\.\d+/.exec(String(version || ""));
  if (m) {
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (major > 22 || (major === 22 && minor >= 20)) return "skills@latest";
  }
  return "skills@1.5.18";
}

// Kept from the pre-rebase main line (PR #32): human-readable summary of a
// spawn result's error, used by the skills installer failure paths.
export function describeSpawnError(result) {
  const err = result?.error;
  if (!err) return null;
  const message = err.message || String(err);
  return err.code ? `${err.code}: ${message}` : message;
}
