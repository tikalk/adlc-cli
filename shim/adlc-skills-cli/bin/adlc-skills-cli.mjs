#!/usr/bin/env node
// Deprecated shim — forwards to adlc-cli's legacy bin.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let target;
try {
  target = require.resolve("adlc-cli/bin/adlc-skills-cli.mjs");
} catch {
  console.error("[deprecated] adlc-skills-cli is now adlc-cli — install adlc-cli: npm install -g adlc-cli");
  process.exit(1);
}

console.error("[deprecated] adlc-skills-cli is now adlc-cli — forwarding to adlc-cli.");

const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
