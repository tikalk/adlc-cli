// CLI entry point — thin dispatch to skill/agent/version/help trees.

import { dispatch } from "./dispatch.mjs";

export async function main(argv = process.argv.slice(2), opts = {}) {
  const exitCode = await dispatch(argv, opts.mode ?? "legacy");
  return exitCode;
}

/**
 * Wait for queued stdout/stderr writes to reach the OS.
 *
 * `process.exit()` terminates immediately and drops writes still queued in
 * libuv. stdout connected to a pipe is asynchronous on POSIX, so a bin that
 * prints and exits can lose the tail of its output when the pipe buffer is
 * small — macOS truncated the last panels of `workflow help` in Publish run
 * 42608148983. Bins await this before calling `process.exit()`.
 */
export async function flushStdio() {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

function flushStream(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.writableLength === 0) return resolve();
    try {
      // The empty write queues behind pending chunks; its callback fires once
      // they have all been handed to the OS.
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}
