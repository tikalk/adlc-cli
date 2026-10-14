// src/utils/spawn.mjs — Portable spawn options for console-shim commands.
//
// On win32, npm-installed CLIs (npx, agent binaries) exist only as .cmd
// shims; a raw CreateProcess("npx") fails ENOENT instantly with no output.
// Spawning through the shell lets cmd.exe resolve the shim. On POSIX the
// returned options are empty, preserving today's exact spawn behavior
// (no shell, no quoting changes).

export function portableSpawnOptions(command, platform = process.platform) {
  void command;
  if (platform === "win32") return { shell: true };
  return {};
}

export function describeSpawnError(result) {
  const err = result?.error;
  if (!err) return null;
  const message = err.message || String(err);
  return err.code ? `${err.code}: ${message}` : message;
}
