// Windows msys-path normalization guard for tests/e2e-workspace.sh.
//
// On Git Bash, `mktemp -d /tmp/...` yields an msys-virtual path. Bash-side git
// works (msys translates), but Node-spawned native git.exe cannot resolve it.
// The E2E script therefore normalizes ROOT via `cygpath -m` on msys/cygwin.
// These tests drive the real normalization block extracted from the script
// with faked OSTYPE and a stub cygpath — no Windows runner needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "e2e-workspace.sh");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");

function extractBlock() {
  const start = SCRIPT.indexOf('if [[ "${OSTYPE');
  assert.ok(
    start !== -1,
    "e2e-workspace.sh must contain an OSTYPE msys/cygwin normalization block",
  );
  const end = SCRIPT.indexOf("\nfi", start);
  assert.ok(end !== -1, "unterminated OSTYPE normalization block");
  return SCRIPT.slice(start, end + "\nfi".length);
}

function resolveBash() {
  // 1. Bare `bash` via PATH lookup — preserves Linux/macOS behavior exactly.
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return "bash";
  } catch {
    // Not on PATH (e.g. Node-spawned process on windows-latest, where
    // Git's bin dir is only on PATH inside Git Bash shells).
  }
  // 2. Well-known Git-for-Windows locations.
  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]) {
      if (!base) continue;
      const exe = path.join(base, "Git", "bin", "bash.exe");
      try {
        fs.accessSync(exe, fs.constants.X_OK);
        return exe;
      } catch {
        // Try the next location.
      }
    }
  }
  // 3. No bash — callers SKIP instead of failing.
  return null;
}

const BASH = resolveBash();
// Fail-open SKIP convention on Windows: never fail when bash is unavailable.
const SKIP_NO_BASH = BASH ? {} : { skip: "bash not found on PATH (Windows Node-spawned process has no Git bin on PATH)" };
// Faked-OSTYPE/stub-cygpath tests are not portable to Windows: the
// extensionless stub script is not executable-resolvable there, so bash
// skips it and finds the REAL /usr/bin/cygpath.exe, which translates the
// REAL temp path (hence C:/Users/RUNNER~1/... vs C:/fake/tmp/...).
// Irony worth noting: on real Windows runners the real cygpath does exactly
// what the snippet wants, so the snippet logic is almost certainly correct —
// only the faked unit tests can't run there. Real msys coverage comes from
// the windows-20/22 E2E jobs, which execute the shell script for real.
const SKIP_WIN32_FAKED = process.platform === "win32"
  ? { skip: "faked OSTYPE/stub-cygpath not portable to Windows; real msys coverage comes from the windows-20/22 E2E jobs" }
  : {};
// First skip reason wins; {} when neither applies (mirrors the existing
// { skip } options-object convention, Node >= 18 compatible).
function combineSkips(...opts) {
  for (const o of opts) if (o.skip) return o;
  return {};
}
const SKIP_FAKED = combineSkips(SKIP_NO_BASH, SKIP_WIN32_FAKED);

function runSnippet({ ostype, binDir }) {
  const block = extractBlock();
  const prog = `ROOT="/tmp/adlc-e2e-ws.TEST"\n${block}\necho "ROOT=$ROOT"\n`;
  const out = execFileSync(BASH, ["-c", prog], {
    env: {
      ...process.env,
      OSTYPE: ostype,
      // Stub bin dir first so the faked cygpath wins; keep the real PATH
      // so a bare `bash` (and the stub's `#!/usr/bin/env bash` shebang)
      // still resolves — the old hardcoded /usr/bin:/bin is meaningless
      // on Windows.
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });
  const line = out.trim().split("\n").pop();
  return line.replace(/^ROOT=/, "");
}

function makeBinDir({ withCygpath }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-winpath-"));
  if (withCygpath) {
    const stub = path.join(dir, "cygpath");
    fs.writeFileSync(
      stub,
      '#!/usr/bin/env bash\nif [ "$1" = "-m" ]; then echo "C:/fake/tmp/adlc-e2e-ws.TEST"; else echo "$2"; fi\n',
    );
    fs.chmodSync(stub, 0o755);
  }
  return dir;
}

test("msys + cygpath: ROOT normalized to Windows C:/ form", SKIP_FAKED, () => {
  const bin = makeBinDir({ withCygpath: true });
  assert.equal(runSnippet({ ostype: "msys", binDir: bin }), "C:/fake/tmp/adlc-e2e-ws.TEST");
});

test("cygwin + cygpath: ROOT normalized to Windows C:/ form", SKIP_FAKED, () => {
  const bin = makeBinDir({ withCygpath: true });
  assert.equal(runSnippet({ ostype: "cygwin_nt-10.0", binDir: bin }), "C:/fake/tmp/adlc-e2e-ws.TEST");
});

test("linux: ROOT untouched", SKIP_NO_BASH, () => {
  const bin = makeBinDir({ withCygpath: true });
  assert.equal(runSnippet({ ostype: "linux-gnu", binDir: bin }), "/tmp/adlc-e2e-ws.TEST");
});

test("msys without cygpath: falls back, exit 0, ROOT untouched", SKIP_FAKED, () => {
  const bin = makeBinDir({ withCygpath: false });
  assert.equal(runSnippet({ ostype: "msys", binDir: bin }), "/tmp/adlc-e2e-ws.TEST");
});
