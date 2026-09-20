// Fake sleeper for signal-forwarding test: writes PID to file (arg 2), sleeps 30s.
import { writeFileSync } from "node:fs";
const pidFile = process.argv[2];
writeFileSync(pidFile, String(process.pid));
setTimeout(() => {}, 30000);
