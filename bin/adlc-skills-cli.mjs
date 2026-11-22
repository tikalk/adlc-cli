#!/usr/bin/env node
import { main, flushStdio } from "../src/cli.mjs";

const exitCode = await main(process.argv.slice(2), { mode: "legacy" });
// process.exit() would drop writes still queued in libuv — stdout to a pipe
// is asynchronous on POSIX, so large output can be truncated (see src/cli.mjs).
await flushStdio();
process.exit(exitCode);
