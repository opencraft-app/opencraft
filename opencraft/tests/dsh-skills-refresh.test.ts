import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillCatalogRefresh } from "../apps/local-agent-host/src/skills/catalog-refresh.js";
import { DshProfileSkillsHandler } from "../apps/local-agent-host/src/dsh-profile-skills.js";

test("unsupported refresh never creates pending work or blocks execution", async () => {
  const refresh = new SkillCatalogRefresh(null);
  assert.equal(await refresh.changed(), "unsupported");
  assert.equal(await refresh.changed(), "unsupported");
  await refresh.ensureFresh();
});

test("commits arriving during refresh require a second acknowledgement", async () => {
  let calls = 0, release!: () => void;
  const refresh = new SkillCatalogRefresh(async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
  });
  await refresh.ensureFresh();
  assert.equal(calls, 0, "cold state requires no Agent activation");
  const first = refresh.changed();
  const second = refresh.changed();
  assert.equal(calls, 1);
  release(); await Promise.all([first, second]);
  assert.equal(calls, 2);
  await refresh.ensureFresh(); assert.equal(calls, 2);
});

test("failed application stays pending and is retried before use", async () => {
  let attempts = 0;
  const refresh = new SkillCatalogRefresh(async () => {
    if (++attempts === 1) throw new Error("Engine unavailable");
  });
  await assert.rejects(refresh.changed(), /unavailable/);
  await refresh.ensureFresh(); await refresh.ensureFresh();
  assert.equal(attempts, 2);
});

test("filesystem commit and runtime refresh have separate outcomes; replay never rewrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-skill-commit-"));
  let refreshCalls = 0;
  const handler = new DshProfileSkillsHandler(root, async () => {
    refreshCalls++;
    assert.match(await readFile(join(root, "fixture", "SKILL.md"), "utf8"), /Fixture/);
    throw new Error("Engine unavailable");
  });
  const params = { scope: { type: "local-dsh", root: "user" }, operationId: "fixture-install",
    artifact: { name: "fixture", files: [{ path: "SKILL.md", content: "---\nname: fixture\ndescription: Fixture\n---\nBody" }] } };
  try {
    const result = await handler.handle("skills/install", params);
    assert.equal(result.action.state, "succeeded");
    assert.match(result.action.logLines.at(-1)!, /refresh is pending/);
    assert.deepEqual(await handler.handle("skills/install", params), result);
    assert.equal(refreshCalls, 1);
    await assert.rejects(handler.handle("skills/install", { ...params, operationId: "invalid", artifact: { name: "bad", files: [] } }));
    assert.equal(refreshCalls, 1, "failed writes do not invalidate");
  } finally { await rm(root, { recursive: true, force: true }); }
});
