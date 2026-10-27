import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "../../runtime/dsh/node_modules/@deepseek-ai/cordis/lib/index.js";
import { SkillRegistry } from "../../runtime/dsh/node_modules/@deepseek-ai/dsh-skill/lib/index.js";
import { createDshSkillCatalog } from "../../apps/local-agent-host/src/dsh-skill-catalog.mjs";

test("native Skill discovery switches project roots without leaking another workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-skill-discovery-"));
  const ctx = new Context();
  const previous = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME };
  process.env.DSH_HOME = join(root, "dsh-home"); process.env.DSH_AGENTS_HOME = join(root, "agents-home");
  try {
    const userRoot = join(root, "user-skills"), a = join(root, "a"), b = join(root, "b");
    for (const [directory, name] of [[userRoot, "shared-example"], [join(a, ".opencraft", "skills"), "workspace-a"], [join(b, ".opencraft", "skills"), "workspace-b"]]) {
      const path = join(directory, name); await mkdir(path, { recursive: true });
      await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Isolated catalog regression\n---\n${name}\n`);
    }
    await ctx.plugin(SkillRegistry);
    let catalog;
    await ctx.plugin({ inject: ["skills"], async apply(owner) {
      catalog = await createDshSkillCatalog(owner, {
        toolsModuleUrl: new URL("../../runtime/dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js", import.meta.url).href,
        persistentSkillsRoot: userRoot,
      });
    } });
    const names = async cwd => (await ctx.skills.list({ cwd, scope: catalog.discoveryKey })).map(skill => skill.name);
    const first = await names(a); assert.ok(first.includes("workspace-a")); assert.ok(first.includes("shared-example")); assert.ok(!first.includes("workspace-b"));
    const second = await names(b); assert.ok(second.includes("workspace-b")); assert.ok(second.includes("shared-example")); assert.ok(!second.includes("workspace-a"));
    assert.ok(!(await names("relative-workspace")).includes("workspace-a"));
    assert.equal((await ctx.skills.get("workspace-a", { cwd: a, scope: catalog.discoveryKey })).source, "project-opencraft");
  } finally { await ctx.fiber.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true }); }
});
