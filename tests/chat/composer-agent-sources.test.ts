import assert from "node:assert/strict";
import test from "node:test";
import { composerAgentBrand, omitDuplicateHostAgents } from "../../packages/composer-editor/src/agent-menu-sources";

test("Pi uses its brand mark, and a built-in Codex host is not a second Codex tab", () => {
  assert.equal(composerAgentBrand("pi"), "pi");
  assert.equal(composerAgentBrand("codex"), "codex");
  const visible = omitDuplicateHostAgents([
    { agentId: "codex", label: "Codex · OpenCraft", brand: composerAgentBrand("codex") },
    { agentId: "pi", label: "Pi · OpenCraft", brand: composerAgentBrand("pi") },
    { agentId: "host", label: "Codex" },
    { agentId: "api", label: "Codex" },
    { agentId: "api", label: "API models" },
  ]);
  assert.deepEqual(visible.map(source => source.label), ["Codex · OpenCraft", "Pi · OpenCraft", "API models"]);
});

test("the built-in Codex catalog stays when no signed-in Codex Agent is listed", () => {
  const visible = omitDuplicateHostAgents([
    { agentId: "pi", label: "Pi · OpenCraft", brand: composerAgentBrand("pi") },
    { agentId: "host", label: "Codex" },
  ]);
  assert.deepEqual(visible.map(source => source.label), ["Pi · OpenCraft", "Codex"]);
});
