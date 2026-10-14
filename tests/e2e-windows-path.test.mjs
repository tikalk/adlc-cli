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

function runSnippet({ ostype, binDir }) {
  const block = extractBlock();
  const prog = `ROOT="/tmp/adlc-e2e-ws.TEST"\n${block}\necho "ROOT=$ROOT"\n`;
  const out = execFileSync("bash", ["-c", prog], {
    env: { ...process.env, OSTYPE: ostype, PATH: `${binDir}${path.delimiter}/usr/bin:/bin` },
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

test("msys + cygpath: ROOT normalized to Windows C:/ form", () => {
  const bin = makeBinDir({ withCygpath: true });
  assert.equal(runSnippet({ ostype: "msys", binDir: bin }), "C:/fake/tmp/adlc-e2e-ws.TEST");
});

test("cygwin + cygpath: ROOT normalized to Windows C:/ form", () => {
  const bin = makeBinDir({ withCygpath: true });
  assert.equal(runSnippet({ ostype: "cygwin_nt-10.0", binDir: bin }), "C:/fake/tmp/adlc-e2e-ws.TEST");
});

test("linux: ROOT untouched", () => {
  const bin = makeBinDir({ withCygpath: true });
  assert.equal(runSnippet({ ostype: "linux-gnu", binDir: bin }), "/tmp/adlc-e2e-ws.TEST");
});

test("msys without cygpath: falls back, exit 0, ROOT untouched", () => {
  const bin = makeBinDir({ withCygpath: false });
  assert.equal(runSnippet({ ostype: "msys", binDir: bin }), "/tmp/adlc-e2e-ws.TEST");
});
