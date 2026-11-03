// Node-version gate for the npx-dependent shell E2E (tests/e2e-workspace.sh).
//
// The chained `skills add` step shells out to `npx skills`, whose bundled
// @clack/prompts chunk does `import { styleText } from "node:util"` —
// `util.styleText` does not exist on Node 18 (added in Node 20). So the shell
// E2E cannot pass on Node 18 regardless of our code; skip it there with a
// clear message (exit 0) while unit tests keep running on all versions.
//
// Explicit direct runs (`bash tests/e2e-workspace.sh`) intentionally bypass
// this gate and still surface the real error.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pure + injectable for unit tests: "v18.20.8" | "18.0.0" -> 18.
export function majorOf(versionString) {
  const m = String(versionString).trim().match(/^v?(\d+)/);
  return m ? Number(m[1]) : NaN;
}

// True when the running Node cannot satisfy the npx `skills` floor.
export function shouldSkipE2E(versionString = process.version) {
  return majorOf(versionString) < 20;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // ADLC_FAKE_NODE_VERSION exists only so CI/maintainers can exercise the
  // skip path on newer Nodes; production path always reads process.version.
  const version = process.env.ADLC_FAKE_NODE_VERSION || process.version;
  if (shouldSkipE2E(version)) {
    console.log(
      `SKIP: e2e-workspace.sh requires Node >= 20 (npx skills uses util.styleText); running on ${version}`,
    );
    process.exit(0);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const child = spawnSync("bash", [join(here, "e2e-workspace.sh"), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}
