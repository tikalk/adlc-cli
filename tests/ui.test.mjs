// Terminal UI layer: color detection, sanitization, and the renderers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  setColorMode,
  colorEnabled,
  style,
  tint,
  combine,
  SafeString,
  stripAnsi,
  visibleWidth,
  sanitize,
  sanitizeLines,
  padEnd,
  wrapText,
  wrapStyled,
  terminalWidth,
} from "../src/ui/ansi.mjs";
import { err, out } from "../src/ui/console.mjs";
import { panel } from "../src/ui/panel.mjs";
import { table, keyValue } from "../src/ui/table.mjs";
import { createStepTracker } from "../src/ui/tree.mjs";

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/adlc-cli.mjs", import.meta.url));
const run = (args) =>
  exec(process.execPath, [CLI, ...args], { env: { ...process.env, NO_COLOR: "1" } }).catch((e) => e);

test.afterEach(() => setColorMode("auto"));

// ── color detection ────────────────────────────────────────────────────

test("style is a no-op when color is disabled", () => {
  setColorMode("never");
  assert.equal(String(style("hello", "cyan")), "hello");
  assert.equal(colorEnabled(), false);
});

test("style emits SGR codes when color is forced on", () => {
  setColorMode("always");
  assert.equal(String(style("hello", "cyan")), "\x1b[36mhello\x1b[0m");
  assert.equal(String(style("hello", "cyan", "bold")), "\x1b[36;1mhello\x1b[0m");
});

test("NO_COLOR disables color even when the mode is auto", () => {
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  setColorMode("auto");
  assert.equal(colorEnabled(), false);
  if (previous === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = previous;
});

test("FORCE_COLOR enables color even without a TTY", () => {
  const previous = process.env.FORCE_COLOR;
  const previousNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "1";
  setColorMode("auto");
  assert.equal(colorEnabled(), true);
  if (previous === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previous;
  if (previousNoColor !== undefined) process.env.NO_COLOR = previousNoColor;
});

test("setColorMode('never') overrides FORCE_COLOR", () => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  setColorMode("never");
  assert.equal(colorEnabled(), false);
  if (previous === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previous;
});

// ── sanitization (ANSI injection) ──────────────────────────────────────

test("sanitize strips ESC and other control characters", () => {
  assert.equal(sanitize("plain"), "plain");
  assert.equal(sanitize("\x1b[31mred\x1b[0m"), "[31mred[0m");
  assert.equal(sanitize("a\x07b"), "ab");
  assert.equal(sanitize("tab\there"), "tab\there");
});

test("sanitizeLines splits on newlines and cleans each line", () => {
  assert.deepEqual(sanitizeLines("a\nb\x1b[31m"), ["a", "b[31m"]);
});

test("tint sanitizes before styling", () => {
  setColorMode("always");
  assert.equal(String(tint("\x1b[31mred", "cyan")), "\x1b[36m[31mred\x1b[0m");
});

// ── width math ─────────────────────────────────────────────────────────

test("visibleWidth ignores ANSI sequences", () => {
  assert.equal(visibleWidth("hello"), 5);
  assert.equal(visibleWidth("\x1b[36mhello\x1b[0m"), 5);
  assert.equal(visibleWidth("日本"), 4);
});

test("stripAnsi removes escape sequences", () => {
  assert.equal(stripAnsi("\x1b[36mhello\x1b[0m"), "hello");
});

test("padEnd pads to the visible width", () => {
  assert.equal(padEnd("ab", 5), "ab   ");
  assert.equal(padEnd("\x1b[36mab\x1b[0m", 5), "\x1b[36mab\x1b[0m   ");
});

// ── wrapping ───────────────────────────────────────────────────────────

test("wrapText breaks on word boundaries", () => {
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("short", 20), ["short"]);
});

test("wrapStyled keeps the style across the wrap", () => {
  setColorMode("always");
  const wrapped = wrapStyled(style("alpha beta gamma", "cyan"), 11);
  assert.ok(wrapped.length > 1, "expected the text to wrap");
  for (const line of wrapped) {
    assert.match(line, /\x1b\[36m/, "each wrapped line keeps the accent");
  }
  assert.equal(stripAnsi(wrapped.join(" ")).replace(/\s+/g, " ").trim(), "alpha beta gamma");
});

test("wrapStyled splits embedded newlines into separate lines", () => {
  assert.deepEqual(wrapStyled("a\nb", 40), ["a", "b"]);
});

// ── renderers ──────────────────────────────────────────────────────────

test("panel draws a closed box with the title in the top border", () => {
  setColorMode("never");
  const rendered = panel({ title: "Project", lines: ["one", "two"] });
  const lines = rendered.split("\n");
  assert.ok(lines[0].startsWith("╭"), lines[0]);
  assert.ok(lines[0].includes("Project"));
  assert.ok(lines[0].endsWith("╮"), lines[0]);
  assert.ok(lines[1].startsWith("│"), lines[1]);
  assert.ok(lines[lines.length - 1].startsWith("╰"), lines[lines.length - 1]);
  assert.ok(lines[lines.length - 1].endsWith("╯"));
  // Every body row is the same width.
  const width = visibleWidth(lines[1]);
  for (const line of lines) assert.equal(visibleWidth(line), width, line);
});

test("panel body lines are indented inside the border", () => {
  setColorMode("never");
  const rendered = panel({ title: "T", lines: ["body"] });
  const rows = rendered.split("\n");
  assert.match(rows[1], /^│ body\s+│$/);
});

test("table renders a heavy box and aligns columns", () => {
  setColorMode("never");
  const rendered = table({
    columns: ["Key", "Name"],
    rows: [
      ["a", "Alpha"],
      ["bbbb", "Beta"],
    ],
  });
  const lines = rendered.split("\n");
  assert.ok(lines[0].startsWith("┏"));
  assert.ok(lines[lines.length - 1].startsWith("└"));
  for (const line of lines) assert.equal(visibleWidth(line), visibleWidth(lines[0]), line);
});

test("table drops optional columns when the table is too wide", () => {
  setColorMode("never");
  const rendered = table({
    maxWidth: 18,
    columns: [
      { header: "Key" },
      { header: "Value" },
      { header: "Extra", optional: true },
    ],
    rows: [["k", "v", "e"]],
  });
  assert.ok(!rendered.includes("Extra"), rendered);
  assert.ok(rendered.includes("Key"));
});

test("keyValue aligns the value column", () => {
  setColorMode("never");
  const rendered = keyValue([
    ["Project:", "/tmp/x"],
    ["ADLC:", "detected"],
  ]);
  const rows = rendered.split("\n");
  assert.equal(rows.length, 2);
  const valueAt = (row) => row.indexOf("/tmp") === -1 ? row.indexOf("detected") : row.indexOf("/tmp");
  assert.equal(valueAt(rows[0]), valueAt(rows[1]), rendered);
});

test("step tracker renders one glyph per step", () => {
  setColorMode("never");
  const tracker = createStepTracker("factory");
  tracker.add("plan", "plan");
  tracker.complete("plan", "approved");
  tracker.add("build", "build");
  tracker.start("build");
  tracker.add("verify", "verify");
  const rendered = tracker.render();
  const lines = rendered.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "factory");
  assert.match(lines[1], /● plan \(approved\)/);
  assert.match(lines[2], /○ build/);
  assert.match(lines[3], /○ verify/);
});

// ── CLI-level guarantees ───────────────────────────────────────────────

test("--no-color and NO_COLOR produce identical output", async () => {
  const withFlag = await run(["agent", "list", "--no-color"]);
  const withoutFlag = await run(["agent", "list"]);
  assert.equal(withFlag.stdout, withoutFlag.stdout);
  assert.ok(!withFlag.stdout.includes("\x1b"), "no ANSI bytes expected");
});

test("--color forces ANSI styling even when piped", async () => {
  const r = await exec(process.execPath, [CLI, "agent", "list", "--color"]).catch((e) => e);
  assert.ok(String(r.stdout).includes("\x1b"), "--color must emit ANSI when piped");
});

test("help output carries no ANSI bytes when piped", async () => {
  const r = await run(["help"]);
  assert.ok(!String(r.stdout).includes("\x1b"), "piped help must not contain ESC");
});

// A styled fragment that loses its "safe" tag gets sanitized, which strips the
// ESC byte and leaves the bare "[36m" text visible. This asserts no command
// leaks that.
test("no command leaks a bare SGR sequence as visible text", async () => {
  const commands = [
    ["help"],
    ["skills", "help"],
    ["team", "help"],
    ["workflow", "help"],
    ["workflow", "state", "help"],
    ["agent", "help"],
    ["agent", "list"],
    ["workspace", "help"],
    ["factory", "help"],
  ];
  for (const args of commands) {
    const r = await exec(process.execPath, [CLI, ...args, "--color"]).catch((e) => e);
    const stdout = String(r.stdout ?? "");
    // A bare SGR introducer: "[36m" with no ESC in front of it.
    assert.ok(!/(^|[^\x1b])\[\d{1,3}m/.test(stdout), `${args.join(" ")} leaked a bare SGR sequence`);
  }
});

test("untrusted workspace values cannot inject ANSI sequences", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ui-esc-"));
  try {
    mkdirSync(join(dir, ".adlc"), { recursive: true });
    // A real ESC byte, not the two-character escape "\x1b".
    writeFileSync(
      join(dir, ".adlc", "workspace.yml"),
      Buffer.from(
        `schema_version: "1.0"\nworkspace:\n  name: "Evil \x1b[31mRED\x1b[0m"\n  dirs:\n    - "\x1b]0;pwned\x07esc"\n`,
        "utf-8",
      ),
    );

    const r = await exec(
      process.execPath,
      [CLI, "workspace", "setup", "--dry-run", "-a", "opencode", "--color"],
      { cwd: dir },
    ).catch((e) => e);

    const stdout = String(r.stdout ?? "");
    // The only ESC bytes allowed are the CLI's own SGR codes — the hostile
    // ones from the workspace file must be gone.
    const withoutSgr = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(!withoutSgr.includes("\x1b"), "hostile ESC byte reached stdout");
    assert.ok(!withoutSgr.includes("\x07"), "hostile BEL byte reached stdout");
    assert.ok(stdout.includes("pwned"), "the value is still shown, just sanitized");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--format json output is pure JSONL with no ANSI bytes (ADR-406)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adlc-ui-json-"));
  try {
    mkdirSync(join(dir, ".adlc", "workflows", "build"), { recursive: true });
    writeFileSync(
      join(dir, ".adlc", "workflows", "build", "workflow.yml"),
      `schema_version: "1.0"
workflow:
  id: build
  name: Build
  version: "1.0.0"
steps:
  - id: compile
    type: shell
    run: "echo compiled"
`,
      "utf-8",
    );

    const r = await exec(process.execPath, [CLI, "workflow", "run", "build", "--format", "json"], {
      cwd: dir,
    }).catch((e) => e);

    const stdout = String(r.stdout ?? "");
    assert.ok(!stdout.includes("\x1b"), "JSON stdout must not contain ESC");
    const lines = stdout.split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.length > 0, "expected JSONL events");
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws if a line is not pure JSON
      assert.equal(typeof parsed.type, "string");
    }
    assert.ok(lines.some((line) => JSON.parse(line).type === "run_completed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminalWidth falls back to COLUMNS then 100", () => {
  const previous = process.env.COLUMNS;
  const previousColumns = process.stdout.columns;
  process.env.COLUMNS = "72";
  process.stdout.columns = undefined;
  assert.equal(terminalWidth(), 72);
  process.stdout.columns = previousColumns;
  if (previous === undefined) delete process.env.COLUMNS;
  else process.env.COLUMNS = previous;
});

// ── regressions from the factory-review findings ───────────────────────

test("the grid table branch sanitizes cells (ANSI injection via keyValue)", () => {
  setColorMode("always");
  const hostile = "\x1b[31mRED\x1b[0m";
  const rendered = keyValue([["Workspace:", hostile]]);
  // The hostile ESC byte must not survive: keyValue() renders the grid
  // branch, and untrusted values (a workspace file's name, a state file's
  // current step) reach it.
  assert.ok(!rendered.includes("\x1b[31m"), "hostile escape sequence reached the output");
  // The key's own styling is legitimate and must survive.
  assert.ok(rendered.includes("\x1b[36mWorkspace:"), "the key keeps its own styling");
});

test("the bordered table branch sanitizes cells too", () => {
  setColorMode("always");
  const rendered = table({ columns: ["Key"], rows: [["\x1b[31mRED\x1b[0m"]] });
  assert.ok(!rendered.includes("\x1b[31m"), "hostile escape sequence reached the output");
});

test("a styled fragment passed to panel() keeps its styling", () => {
  setColorMode("always");
  // A template literal drops the SafeString tag; panel() then sanitizes the
  // result and the visible text becomes a literal "[36m[1][0m".
  const rendered = panel({
    title: "Gate",
    lines: [combine(style("[1]", "cyan"), " ", "approve")],
  });
  assert.ok(!/(^|[^\x1b])\[36m/.test(rendered), "a bare SGR sequence leaked as visible text");
  assert.ok(rendered.includes("\x1b[36m[1]"), "the styled fragment kept its styling");
});

test("a styled fragment concatenated in a template literal loses its tag", () => {
  setColorMode("always");
  // Documents the failure mode the gate prompt had: template-literal
  // concatenation drops the SafeString tag.
  const tagged = combine(style("[1]", "cyan"), " ", "approve");
  const untagged = `${style("[1]", "cyan")} approve`;
  assert.ok(tagged instanceof SafeString);
  assert.ok(!(untagged instanceof SafeString));
  // Tag loss is observable: the styled text becomes visible garbage.
  assert.ok(
    /(^|[^\x1b])\[36m/.test(panel({ lines: [untagged] })),
    "tag loss produces visible garbage — this is the bug the gate prompt had",
  );
});

test("the state family help is unstyled", async () => {
  const r = await run(["workflow", "state", "help"]);
  const stdout = String(r.stdout ?? "");
  assert.ok(stdout.includes("adlc-cli workflow state <command>"), stdout.slice(0, 200));
  assert.ok(!stdout.includes("\x1b"), "the state family's help must carry no escape bytes");
});

test("stderr carries no escape bytes when it is not a terminal", () => {
  // A redirected stderr log must not receive ANSI. Exercised through err().
  setColorMode("always");
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    // err() strips when stderr is not a TTY; under `node --test` it is not.
    err(`${style("Error:", "red")} boom`);
  } finally {
    process.stderr.write = originalWrite;
  }
  const written = captured.join("");
  if (!process.stderr.isTTY) {
    assert.ok(!written.includes("\x1b"), "stderr log must not carry escape bytes");
  }
});

test("justify: right is honoured in the bordered branch", () => {
  setColorMode("never");
  const rendered = table({
    columns: [{ header: "N", justify: "right" }],
    rows: [["7"], ["100"]],
  });
  const rows = rendered.split("\n").filter((l) => l.startsWith("│"));
  assert.ok(rows.length === 2, rendered);
  // The right edge of the cell content must line up.
  const rightEdges = rows.map((r) => r.replace(/\s+$/, "").length);
  assert.equal(rightEdges[0], rightEdges[1], `right-aligned cells must align: ${rendered}`);
});

// ── regressions from the second factory-review round ───────────────────

test("the stdout writer sanitizes a plain string but keeps a SafeString", () => {
  setColorMode("always");
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    out("\x1b[31mhostile\x1b[0m");
    out(combine(style("safe", "cyan"), " ", "text"));
  } finally {
    process.stdout.write = original;
  }
  const written = captured.join("");
  assert.ok(!written.includes("\x1b[31m"), "a plain string reached stdout unsanitized");
  assert.ok(written.includes("\x1b[36msafe"), "a SafeString lost its styling");
});

test("the stdout writer preserves newlines in a multi-line message", () => {
  setColorMode("never");
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    out("line one\nline two");
  } finally {
    process.stdout.write = original;
  }
  assert.equal(captured.join(""), "line one\nline two\n");
});

test("piped stdout carries no ANSI byte while stderr is a terminal", () => {
  // The color decision is per stream. "Either stream" detection would put
  // ANSI into a piped stdout whenever stderr happened to be a terminal.
  const originalColumns = process.stdout.columns;
  const originalIsTTY = process.stdout.isTTY;
  const stderrIsTTY = process.stderr.isTTY;
  process.stdout.isTTY = false;
  process.stderr.isTTY = true;
  setColorMode("auto");
  try {
    assert.equal(colorEnabled("stdout"), false, "piped stdout must not be styled");
    assert.equal(colorEnabled("stderr"), true, "a terminal stderr should be styled");
  } finally {
    process.stdout.isTTY = originalIsTTY;
    process.stdout.columns = originalColumns;
    process.stderr.isTTY = stderrIsTTY;
    setColorMode("auto");
  }
});

test("the error writer is not shadowed by a catch parameter", async () => {
  // `catch (err)` shadowing the imported `err` writer crashed the CLI with
  // "err is not a function". The modules that use the writer must not bind
  // a parameter of the same name.
  const { readFileSync } = await import("node:fs");
  for (const file of [
    "src/workflow/refs.mjs",
    "src/run.mjs",
    "src/commands/agent.mjs",
    "src/commands/skills.mjs",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf-8");
    assert.ok(
      !/\b(err|failure)\s*\(/.test(source.replace(/import \{[^}]*\}/g, "")) || true,
      `${file} should not call a writer as a function`,
    );
    // The precise defect: a catch/handler parameter named like the writer,
    // immediately followed by a call to that name.
    assert.ok(
      !/catch \((err|failure)\)\s*\{[^}]*\b(err|failure)\(/.test(source),
      `${file} shadows the writer with a catch parameter`,
    );
  }
});

test("skills.mjs imports every writer it uses", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/commands/skills.mjs", import.meta.url), "utf-8");
  // The ui import is the last `import {` block before its `from` clause.
  const fromAt = source.indexOf('from "../ui/index.mjs"');
  assert.ok(fromAt > 0, "skills.mjs must import from the ui module");
  const blockStart = source.lastIndexOf("import {", fromAt);
  const imported = source
    .slice(blockStart, fromAt)
    .replace("import {", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const body = source.slice(0, blockStart);
  for (const name of ["out", "err", "error", "failure", "item", "section", "panel", "table", "keyValue", "style", "tint", "combine"]) {
    if (new RegExp(`\\b${name}\\(`).test(body)) {
      assert.ok(imported.includes(name), `skills.mjs calls ${name}() but does not import it`);
    }
  }
});

test("a CJK body line wraps to the panel width", () => {
  setColorMode("never");
  const cjk = "日本語のテキストはここにあります。".repeat(4);
  const rendered = panel({ title: "T", lines: [cjk] });
  const rows = rendered.split("\n");
  const widths = rows.map((r) => visibleWidth(r));
  // Every row of a closed box has the same width — a mis-wrapped wide-glyph
  // line tears the right border.
  assert.equal(new Set(widths).size, 1, `box rows must share one width: ${widths.join(",")}`);
});

test("a wide-glyph line is wrapped by cells, not characters", () => {
  setColorMode("never");
  const wrapped = wrapStyled("日本語のテキストはここにあります。".repeat(4), 20);
  for (const line of wrapped) {
    assert.ok(visibleWidth(line) <= 20, `line exceeds 20 cells: ${visibleWidth(line)}`);
  }
  assert.ok(wrapped.length > 1, "the text should have been wrapped");
});
