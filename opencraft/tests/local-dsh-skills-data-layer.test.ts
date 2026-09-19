import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { AppServerProfileSkillsService } from "@opencraft/profile-skills-appserver";
import type { ProfileSkillAction, ProfileSkillsInstallParams } from "@opencraft/appserver-protocol";
import { createLocalDshSkillsDataLayer } from "../plugins/lightvela-hermes/src/settings/profile-skills-data-layer";

test("local DSH data layer resolves a public SkillHub artifact before AppServer install", async () => {
  const markdown = "---\nname: sample-skill\ndescription: Sample\n---\n\nUse it.\n";
  const sha256 = createHash("sha256").update(markdown).digest("hex");
  let installParams: Omit<ProfileSkillsInstallParams, "scope"> | null = null;
  const readinessOrder: string[] = [];
  const action: ProfileSkillAction = {
    actionId: "action-1",
    operationId: "operation-1",
    scope: { type: "local-dsh", root: "user" },
    kind: "install",
    target: "sample-skill",
    state: "succeeded",
    logLines: [],
  };
  const service = {
    waitForCapability: async () => { readinessOrder.push("capability"); return { version: 1 }; },
    install: async (_target: unknown, params: Omit<ProfileSkillsInstallParams, "scope">) => {
      installParams = params;
      return { action };
    },
  } as unknown as AppServerProfileSkillsService;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/files")) {
      return new Response(JSON.stringify({ files: [{ path: "SKILL.md", size: markdown.length, sha256 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/file?")) return new Response(markdown, { status: 200 });
    return new Response("not found", { status: 404 });
  };
  try {
    const dataLayer = createLocalDshSkillsDataLayer(service, {
      hostId: "local",
      scope: { type: "local-dsh", root: "user" },
    }, {
      ensureReady: async () => { readinessOrder.push("runtime"); },
    });
    const result = await dataLayer.install({
      registry: "skillhub",
      rawId: "sample-skill",
      slug: "sample-skill",
      name: "Sample Skill",
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(readinessOrder, ["runtime", "capability"]);
    assert.equal(installParams?.identifier, "sample-skill");
    assert.deepEqual(installParams?.artifact, {
      name: "sample-skill",
      files: [{ path: "SKILL.md", content: markdown, sha256 }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
