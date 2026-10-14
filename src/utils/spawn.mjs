// src/utils/spawn.mjs — Portable spawn options for console-shim commands.
//
// On win32, npm-installed CLIs (npx, agent binaries) exist only as .cmd
// shims; a raw CreateProcess("npx") fails ENOENT instantly with no output.
// Spawning through the shell lets cmd.exe resolve the shim. On POSIX the
// returned options are empty, preserving today's exact spawn behavior
// (no shell, no quoting changes).

export function portableSpawnOptions(command, platform = process.platform) {
  if (platform !== "win32") return {};
  // Narrowed: shell only for bare console-shim names (no path separators,
  // no .exe suffix). Absolute-path binaries (e.g. node.exe) and relative
  // script paths spawn directly — shell would lose their stdout on win32.
  if (typeof command !== "string" || command.length === 0) return {};
  if (command.includes("/") || command.includes("\\")) return {};
  if (command.toLowerCase().endsWith(".exe")) return {};
  return { shell: true };
}

export function describeSpawnError(result) {
  const err = result?.error;
  if (!err) return null;
  const message = err.message || String(err);
  return err.code ? `${err.code}: ${message}` : message;
}
