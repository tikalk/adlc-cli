#!/usr/bin/env node
import { main } from "../src/cli.mjs";

const exitCode = await main(process.argv.slice(2), { mode: "cli" });
process.exit(exitCode);
