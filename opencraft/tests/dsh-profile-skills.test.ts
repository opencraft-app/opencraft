import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DshProfileSkillsHandler } from "../apps/local-agent-host/src/dsh-profile-skills.js";

const scope = { type: "local-dsh", root: "user" } as const;
const markdown = "---\nname: example-skill\ndescription: Example local Skill\n---\n\nDo the thing.\n";
const digest = createHash("sha256").update(markdown).digest("hex");

test("local DSH Skill install is bounded, idempotent, visible and recoverably uninstallable", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-dsh-skills-"));
  const handler = new DshProfileSkillsHandler(root);
  try {
    const installed = await handler.handle("skills/install", {
      scope,
      identifier: "example-skill",
      operationId: "install-example",
      artifact: {
        name: "example-skill",
        files: [
          { path: "SKILL.md", content: markdown, sha256: digest },
          { path: "references/example.md", content: "Example\n" },
        ],
      },
    });
    assert.equal(installed.action.state, "succeeded");
    assert.equal(await readFile(join(root, "example-skill", "SKILL.md"), "utf8"), markdown);

    const replay = await handler.handle("skills/install", {
      scope,
      identifier: "example-skill",
      operationId: "install-example",
      artifact: { name: "example-skill", files: [{ path: "SKILL.md", content: markdown }] },
    });
    assert.equal(replay.action.actionId, installed.action.actionId);

    const listed = await handler.handle("skills/installed/list", { scope });
    assert.deepEqual(listed.data.map((skill) => skill.name), ["example-skill"]);
    const content = await handler.handle("skills/installed/content/read", { scope, name: "example-skill" });
    assert.equal(content.content, markdown);

    const removed = await handler.handle("skills/uninstall", {
      scope,
      name: "example-skill",
      operationId: "uninstall-example",
    });
    assert.equal(removed.action.state, "succeeded");
    await assert.rejects(access(join(root, "example-skill")));
    assert.equal((await handler.handle("skills/installed/list", { scope })).data.length, 0);
    assert.match(removed.action.logLines[0], /recoverable Skill trash/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local DSH Skill install rejects traversal and non-local scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-dsh-skills-policy-"));
  const handler = new DshProfileSkillsHandler(root);
  try {
    await assert.rejects(handler.handle("skills/install", {
      scope,
      identifier: "example-skill",
      operationId: "traversal",
      artifact: { name: "example-skill", files: [{ path: "../SKILL.md", content: markdown }] },
    }), /invalid/u);
    await assert.rejects(handler.handle("skills/installed/list", {
      scope: { type: "profile", profileId: "default" },
    }), /Local DSH Skills requires/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
