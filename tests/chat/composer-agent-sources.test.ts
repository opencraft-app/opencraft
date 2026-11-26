import assert from "node:assert/strict";
import test from "node:test";
import { composerAgentBrand } from "../../packages/composer-editor/src/agent-menu-sources";

test("known Agents use their brand marks", () => {
  assert.equal(composerAgentBrand("pi"), "pi");
  assert.equal(composerAgentBrand("codex"), "codex");
  assert.equal(composerAgentBrand("unknown"), undefined);
});
