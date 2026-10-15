import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { findInstalledSkills } from "../src/source.mjs";

describe("Frontmatter parsing", () => {
  it("parses simple key-value frontmatter", () => {
    const content = `---
name: team-setup
description: Clone, scaffold, or configure a team AI directives repository
---

# Team Setup

Body text here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter.name, "team-setup");
    assert.equal(frontmatter.description, "Clone, scaffold, or configure a team AI directives repository");
    assert.ok(body.startsWith("# Team Setup"));
  });

  it("parses quoted values", () => {
    const content = `---
name: "my-skill"
description: 'A skill with: a colon'
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter.name, "my-skill");
    assert.equal(frontmatter.description, "A skill with: a colon");
  });

  it("parses disable-model-invocation field", () => {
    const content = `---
name: team-setup
description: A skill
disable-model-invocation: true
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter["disable-model-invocation"], "true");
  });

  it("returns null frontmatter for content without frontmatter", () => {
    const content = "# Just markdown\n\nNo frontmatter.";
    const { frontmatter, body } = parseFrontmatter(content);
    assert.equal(frontmatter, null);
    assert.equal(body, content);
  });

  it("returns null frontmatter for unclosed frontmatter", () => {
    const content = "---\nname: broken\nNo closing delimiter";
    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter, null);
  });

  it("handles empty description", () => {
    const content = `---
name: minimal
---

Body`;

    const { frontmatter } = parseFrontmatter(content);
    assert.equal(frontmatter.name, "minimal");
    assert.equal(frontmatter.description, undefined);
  });

  it("parses CRLF frontmatter identically to LF", () => {
    const lf = "---\nname: workspace\n" + 'description: "Do work: things"\n---\n\nBody';
    const crlf = lf.replaceAll("\n", "\r\n");

    const { frontmatter } = parseFrontmatter(crlf);
    assert.equal(frontmatter.name, "workspace");
    assert.equal(frontmatter.description, "Do work: things");
    assert.deepEqual(frontmatter, parseFrontmatter(lf).frontmatter);
  });

  it("discovers a CRLF SKILL.md via findInstalledSkills", async () => {
    const root = await mkdtemp(join(tmpdir(), "adlc-crlf-"));
    try {
      const skillDir = join(root, "skills", "workspace");
      await mkdir(skillDir, { recursive: true });
      const lf = "---\nname: workspace\ndescription: Workspace skill\n---\n\n# Workspace\n";
      await writeFile(join(skillDir, "SKILL.md"), lf.replaceAll("\n", "\r\n"), "utf-8");

      const skills = await findInstalledSkills(join(root, "skills"), root);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].name, "workspace");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
