import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { installForAgent } from "../src/mcp/install.mjs";

// Minimal project sandbox: a temp dir plus helpers to lay out foreign configs.
function project() {
  const dir = mkdtempSync(join(tmpdir(), "adlc-mcp-install-"));
  return {
    dir,
    path: (rel) => join(dir, rel),
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    },
    read(rel) { return readFileSync(join(dir, rel), "utf-8"); },
    readBytes(rel) { return readFileSync(join(dir, rel)); },
    exists(rel) { return existsSync(join(dir, rel)); },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

const CONTEXT7 = {
  command: "npx",
  args: ["-y", "@upstash/context7-mcp"],
  env: { TOKEN: "${GITLAB_TOKEN}" },
};

// ── The brief's contract tests (values verbatim) ───────────────────────

it("adds entries in the target's shape and leaves foreign keys alone", () => {
  const p = project();
  try {
    p.write("opencode.json", JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: ["p@git+https://x/p.git"],
      mcp: { unrelated: { type: "local", command: ["x"] } },
    }, null, 2));

    const r = installForAgent({ projectRoot: p.dir, agent: "opencode", servers: { context7: CONTEXT7 } });

    const cfg = JSON.parse(p.read("opencode.json"));
    assert.equal(cfg.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(cfg.plugin, ["p@git+https://x/p.git"]);
    assert.equal(cfg.mcp.unrelated.type, "local");           // untouched
    assert.deepEqual(cfg.mcp.unrelated.command, ["x"]);
    assert.equal(cfg.mcp.context7.type, "local");            // translated
    assert.deepEqual(cfg.mcp.context7.command, ["npx", "-y", "@upstash/context7-mcp"]);
    assert.equal(cfg.mcp.context7.environment.TOKEN, "{env:GITLAB_TOKEN}");
    assert.equal(r.written.find((w) => w.name === "context7").action, "added");
    assert.equal(r.errors.length, 0);
  } finally {
    p.cleanup();
  }
});

it("a name in .mcp.json is tool-owned: a hand-edited body is overwritten and reported", () => {
  const p = project();
  try {
    p.write("opencode.json", JSON.stringify({
      mcp: { context7: { type: "local", command: ["hand", "edited"], environment: {} } },
    }, null, 2));

    const r = installForAgent({ projectRoot: p.dir, agent: "opencode", servers: { context7: CONTEXT7 } });

    assert.equal(r.written.find((w) => w.name === "context7").action, "updated");
    const cfg = JSON.parse(p.read("opencode.json"));
    assert.deepEqual(cfg.mcp.context7.command, ["npx", "-y", "@upstash/context7-mcp"]);
  } finally {
    p.cleanup();
  }
});

// ── Fix round 2 — Important 1: no bare off-switch exemption (ADR-455) ──
// A name in .mcp.json is tool-owned and regenerated every run. The user's
// off switch is `disabled: true` in .mcp.json itself; a bare
// {"enabled": <bool>} override in the target is regenerated like any other
// owned body and reported `updated` — keeping it would silently trap a
// disabled→re-enabled server in the off state while .mcp.json says on.

it("re-enabled in .mcp.json: the full entry is regenerated and the server would start (opencode, JSON)", () => {
  // The traced scenario, end to end: disabled → run (off-switch written) →
  // remove `disabled` from .mcp.json → re-run. The tool-owned name — whose
  // current body is exactly the bare off-switch the first run wrote — is
  // regenerated, not kept.
  const p = project();
  try {
    const spec = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-gitlab"],
      env: { GITLAB_TOKEN: "${GITLAB_TOKEN}" },
    };
    p.write("opencode.json", JSON.stringify({ mcp: {} }, null, 2));

    // disabled: true → the off switch is written: {"enabled": false}
    installForAgent({ projectRoot: p.dir, agent: "opencode", servers: { gitlab: { ...spec, disabled: true } } });
    assert.deepEqual(JSON.parse(p.read("opencode.json")).mcp.gitlab, { enabled: false });

    // the user removes `disabled` from .mcp.json — the source of truth says on
    const r = installForAgent({ projectRoot: p.dir, agent: "opencode", servers: { gitlab: spec } });

    assert.equal(r.written.find((w) => w.name === "gitlab").action, "updated");
    const entry = JSON.parse(p.read("opencode.json")).mcp.gitlab;
    assert.equal(entry.enabled, true); // the server would start
    assert.deepEqual(entry.command, ["npx", "-y", "@modelcontextprotocol/server-gitlab"]);
    assert.deepEqual(entry.environment, { GITLAB_TOKEN: "{env:GITLAB_TOKEN}" });
  } finally {
    p.cleanup();
  }
});

it("a hand-written bare {\"enabled\": false} override is regenerated, not kept", () => {
  const p = project();
  try {
    p.write("opencode.json", JSON.stringify({ mcp: { gitlab: { enabled: false } } }, null, 2));

    const r = installForAgent({
      projectRoot: p.dir,
      agent: "opencode",
      servers: {
        gitlab: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-gitlab"],
          env: { GITLAB_TOKEN: "${GITLAB_TOKEN}" },
        },
      },
    });

    assert.equal(r.written.find((w) => w.name === "gitlab").action, "updated");
    const cfg = JSON.parse(p.read("opencode.json"));
    assert.equal(cfg.mcp.gitlab.enabled, true); // .mcp.json wins, not the stale override
    assert.deepEqual(cfg.mcp.gitlab.command, ["npx", "-y", "@modelcontextprotocol/server-gitlab"]);
  } finally {
    p.cleanup();
  }
});

it("a refused entry is not written, and names the server and the reason", () => {
  const p = project();
  try {
    const r = installForAgent({
      projectRoot: p.dir,
      agent: "codex",
      servers: { docs: { type: "http", url: "https://mcp.example/${TENANT}" } },
    });

    const w = r.written.find((x) => x.name === "docs");
    assert.equal(w.action, "refused");
    assert.match(w.detail, /url/);
    // The codex target is TOML and was never created (ruling 2: never JSON.parse a .toml).
    assert.equal(p.exists(".codex/config.toml"), false);
    // Refusals live in written[], never in errors[] (ruling 1).
    assert.equal(r.errors.length, 0);
  } finally {
    p.cleanup();
  }
});

it("disabled:true writes the off switch where one exists and skips where none does", () => {
  // opencode has an off switch -> {"enabled": false}; cursor has none -> omitted.
  const po = project();
  try {
    po.write("opencode.json", JSON.stringify({ mcp: {} }, null, 2));
    const ro = installForAgent({
      projectRoot: po.dir,
      agent: "opencode",
      servers: { foo: { command: "x", disabled: true } },
    });
    assert.deepEqual(JSON.parse(po.read("opencode.json")).mcp.foo, { enabled: false });
    const wo = ro.written.find((w) => w.name === "foo");
    assert.ok(wo.action === "added" || wo.action === "updated");
  } finally {
    po.cleanup();
  }

  const pc = project();
  try {
    pc.write(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }, null, 2));
    const rc = installForAgent({
      projectRoot: pc.dir,
      agent: "cursor",
      servers: { foo: { command: "x", disabled: true } },
    });
    assert.equal(JSON.parse(pc.read(".cursor/mcp.json")).mcpServers.foo, undefined);
    assert.equal(rc.written.find((w) => w.name === "foo").action, "disabled-skipped");
  } finally {
    pc.cleanup();
  }
});

it("is idempotent: a second run writes byte-identical files and reports kept", () => {
  const p = project();
  try {
    p.write("opencode.json", JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { unrelated: { type: "local", command: ["x"] } },
    }, null, 2));
    const servers = {
      context7: CONTEXT7,
      gitlab: { command: "y", disabled: true },
    };

    installForAgent({ projectRoot: p.dir, agent: "opencode", servers }); // first run
    const first = p.readBytes("opencode.json");
    const r2 = installForAgent({ projectRoot: p.dir, agent: "opencode", servers }); // second run

    assert.deepEqual(p.readBytes("opencode.json"), first);
    assert.ok(r2.written.every((w) => w.action === "kept"));
  } finally {
    p.cleanup();
  }
});

it("refuses a config that is not plain JSON instead of editing it", () => {
  const p = project();
  try {
    const original = '{\n  // a JSONC comment\n  "mcp": {}\n}\n';
    p.write("opencode.json", original);

    const r = installForAgent({ projectRoot: p.dir, agent: "opencode", servers: { context7: CONTEXT7 } });

    assert.ok(r.errors.some((e) => /not plain JSON/.test(e)));
    assert.equal(p.read("opencode.json"), original); // untouched
    assert.equal(r.written.length, 0);               // target-level failure, not per-server (ruling 1)
  } finally {
    p.cleanup();
  }
});

// ── Codex (TOML) merge: marker fragments, foreign preservation, ownership ──

it("codex writes a marker-paired TOML fragment and preserves foreign TOML", () => {
  const p = project();
  try {
    p.write(".codex/config.toml", 'model = "gpt"\n\n[mcp_servers.foreign]\ncommand = "keep"\n');

    const r = installForAgent({
      projectRoot: p.dir,
      agent: "codex",
      servers: { context7: { command: "npx", args: ["-y", "x"] } },
    });

    const text = p.read(".codex/config.toml"); // read as text, never JSON.parse a .toml
    assert.match(text, /\[mcp_servers\.context7\]/);
    assert.match(text, /adlc-mcp-begin context7/);
    assert.match(text, /adlc-mcp-end context7/);
    assert.match(text, /model = "gpt"/);                 // foreign root preserved
    assert.match(text, /\[mcp_servers\.foreign\]/);      // foreign server preserved
    assert.match(text, /command = "keep"/);
    assert.equal(r.written.find((w) => w.name === "context7").action, "added");
    assert.equal(r.errors.length, 0);
  } finally {
    p.cleanup();
  }
});

it("codex is idempotent and regenerates a hand-edited owned block", () => {
  const p = project();
  try {
    p.write(".codex/config.toml", 'model = "gpt"\n');
    const servers = { context7: { command: "npx", args: ["-y", "x"] } };

    installForAgent({ projectRoot: p.dir, agent: "codex", servers }); // first run
    const first = p.readBytes(".codex/config.toml");
    const r2 = installForAgent({ projectRoot: p.dir, agent: "codex", servers }); // second run
    assert.deepEqual(p.readBytes(".codex/config.toml"), first);
    assert.ok(r2.written.every((w) => w.action === "kept"));

    // Hand-edit the owned block: ownership is the name, so it is regenerated.
    p.write(".codex/config.toml",
      p.read(".codex/config.toml").replace('command = "npx"', 'command = "hand-edited"'));
    const r3 = installForAgent({ projectRoot: p.dir, agent: "codex", servers });
    assert.equal(r3.written.find((w) => w.name === "context7").action, "updated");
    assert.match(p.read(".codex/config.toml"), /command = "npx"/); // regenerated
    assert.match(p.read(".codex/config.toml"), /model = "gpt"/);   // foreign still preserved
  } finally {
    p.cleanup();
  }
});

// ── Target-level failures (ruling 1): wrong shape, reported and untouched ──

it("refuses a target whose section is the wrong shape instead of editing it", () => {
  const p = project();
  try {
    const original = JSON.stringify({ mcp: ["not", "an", "object"] }, null, 2) + "\n";
    p.write("opencode.json", original);

    const r = installForAgent({ projectRoot: p.dir, agent: "opencode", servers: { context7: CONTEXT7 } });

    assert.ok(r.errors.length > 0);
    assert.equal(p.read("opencode.json"), original);
    assert.equal(r.written.length, 0);
  } finally {
    p.cleanup();
  }
});

// ── Security: a server named __proto__ must not pollute the prototype ──

it("writes a server named __proto__ as a normal key without prototype pollution", () => {
  const p = project();
  try {
    p.write("opencode.json", "{}");
    const servers = JSON.parse('{ "__proto__": { "command": "x" } }'); // own key, as JSON.parse produces

    const r = installForAgent({ projectRoot: p.dir, agent: "opencode", servers });

    assert.equal(r.written.find((w) => w.name === "__proto__").action, "added");
    const cfg = JSON.parse(p.read("opencode.json"));
    assert.ok(Object.hasOwn(cfg.mcp, "__proto__"));       // stored as a normal key
    assert.equal(({}).polluted, undefined);               // the prototype is untouched
  } finally {
    p.cleanup();
  }
});

// ── disabled-skipped actually disables: a stale owned entry is removed ──

it("disabled:true with no off switch removes a stale owned entry to actually disable", () => {
  const p = project();
  try {
    p.write(".cursor/mcp.json", JSON.stringify({
      mcpServers: { foo: { type: "stdio", command: "stale" } },
    }, null, 2));

    const r = installForAgent({
      projectRoot: p.dir,
      agent: "cursor",
      servers: { foo: { command: "x", disabled: true } },
    });

    assert.equal(r.written.find((w) => w.name === "foo").action, "disabled-skipped");
    assert.equal(JSON.parse(p.read(".cursor/mcp.json")).mcpServers.foo, undefined);
  } finally {
    p.cleanup();
  }
});

// ── Fix round 1 — Important 1: .mcp.json is the source, never written ──

it("claude is a no-op: .mcp.json is never rewritten and every server reports kept", () => {
  const p = project();
  try {
    const original = JSON.stringify({
      mcpServers: { context7: CONTEXT7, gitlab: { command: "y", disabled: true } },
    }, null, 2) + "\n";
    p.write(".mcp.json", original);
    const servers = { context7: CONTEXT7, gitlab: { command: "y", disabled: true } };

    const before = p.readBytes(".mcp.json");
    const r = installForAgent({ projectRoot: p.dir, agent: "claude", servers });

    assert.deepEqual(p.readBytes(".mcp.json"), before);           // byte-identical
    assert.equal(r.written.find((w) => w.name === "context7").action, "kept");
    const gw = r.written.find((w) => w.name === "gitlab");
    assert.equal(gw.action, "kept");
    assert.match(gw.detail, /no effect in claude/);               // disabled does not delete
    assert.match(gw.detail, /delete the entry/);
    assert.equal(r.errors.length, 0);
  } finally {
    p.cleanup();
  }
});

// ── Fix round 2 — Important 1 (TOML path): a bare off-switch override is
// regenerated, never kept (ADR-455) ────────────────────────────────────

it("re-enabled in .mcp.json: the full entry is regenerated and the server would start (codex, TOML)", () => {
  // The traced scenario, end to end, on the TOML target: disabled → run
  // (off-switch written) → remove `disabled` from .mcp.json → re-run.
  const p = project();
  try {
    const spec = { command: "npx", args: ["-y", "x"] };

    // disabled: true → the off switch is written: enabled = false, no command
    installForAgent({ projectRoot: p.dir, agent: "codex", servers: { gitlab: { ...spec, disabled: true } } });
    let text = p.read(".codex/config.toml");
    assert.match(text, /enabled = false/);
    assert.doesNotMatch(text, /command =/);

    // the user removes `disabled` from .mcp.json — the source of truth says on
    const r = installForAgent({ projectRoot: p.dir, agent: "codex", servers: { gitlab: spec } });

    assert.equal(r.written.find((w) => w.name === "gitlab").action, "updated");
    text = p.read(".codex/config.toml");
    assert.match(text, /command = "npx"/);        // the full entry is back
    assert.match(text, /enabled = true/);         // the server would start
    assert.doesNotMatch(text, /enabled = false/); // the stale off switch is gone
  } finally {
    p.cleanup();
  }
});

it("codex regenerates a hand-written bare off-switch override into a full entry", () => {
  const p = project();
  try {
    p.write(".codex/config.toml", '[mcp_servers.gitlab]\nenabled = false\n');

    const r = installForAgent({
      projectRoot: p.dir,
      agent: "codex",
      servers: { gitlab: { command: "npx", args: ["-y", "x"] } },
    });

    const text = p.read(".codex/config.toml");
    assert.match(text, /command = "npx"/);        // rebuilt into a full entry
    assert.match(text, /enabled = true/);         // .mcp.json wins, not the stale override
    assert.match(text, /adlc-mcp-begin gitlab/);  // marker-paired like any owned block
    assert.doesNotMatch(text, /enabled = false/);
    assert.equal(r.written.find((w) => w.name === "gitlab").action, "updated");
  } finally {
    p.cleanup();
  }
});

// ── Fix round 1 — Important 3: malformed marker pairs lose no data ──

it("an unterminated marker block is reported and the file is left untouched", () => {
  const p = project();
  try {
    const original = '# adlc-mcp-begin context7\n[mcp_servers.context7]\ncommand = "x"\n'
      + '[mcp_servers.foreign]\ncommand = "keep"\n';
    p.write(".codex/config.toml", original);

    const r = installForAgent({
      projectRoot: p.dir,
      agent: "codex",
      servers: { context7: { command: "npx", args: ["-y", "x"] } },
    });

    assert.ok(r.errors.some((e) => /unterminated/.test(e)));   // reported
    assert.equal(p.read(".codex/config.toml"), original);       // untouched, foreign kept
    assert.equal(r.written.length, 0);                          // target-level failure
  } finally {
    p.cleanup();
  }
});

it("an orphan end marker is reported and the file is left untouched", () => {
  const p = project();
  try {
    const original = '# adlc-mcp-end context7\nmodel = "gpt"\n';
    p.write(".codex/config.toml", original);

    const r = installForAgent({
      projectRoot: p.dir,
      agent: "codex",
      servers: { context7: { command: "npx", args: ["-y", "x"] } },
    });

    assert.ok(r.errors.some((e) => /orphan/.test(e)));
    assert.equal(p.read(".codex/config.toml"), original);
    assert.equal(r.written.length, 0);
  } finally {
    p.cleanup();
  }
});
