// CLI entry point — thin dispatch to skill/agent/version/help trees.

import { dispatch } from "./dispatch.mjs";

export async function main(argv = process.argv.slice(2), opts = {}) {
  const exitCode = await dispatch(argv, opts.mode ?? "legacy");
  return exitCode;
}
