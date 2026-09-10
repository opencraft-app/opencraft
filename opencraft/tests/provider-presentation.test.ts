import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSearchSelect } from "../packages/extension-react/src/settings-search-select";
import { presentationBrand } from "../plugins/builtin-agents/src/brand-presentation";

test("identical model IDs on different routes retain the selected provider", () => {
  const groups = ["Gateway A", "Gateway B"].map(id => ({ id, label: id, options: [
    { value: JSON.stringify([id, "shared-model"]), label: "Shared Model" },
  ] }));
  const html = renderToStaticMarkup(createElement(SettingsSearchSelect, {
    id: "model", label: "Models", value: JSON.stringify(["Gateway B", "shared-model"]), groups,
    onChange() { throw new Error("Rendering must not mutate the runtime"); },
  }));
  assert.match(html, /Gateway B/);
  assert.doesNotMatch(html, /Gateway A/);
});

test("provider logos match known identifiers, not arbitrary display-name substrings", () => {
  assert.equal(presentationBrand("openai"), "openai");
  assert.equal(presentationBrand("deepseek-official"), "deepseek");
  assert.equal(presentationBrand("company-openai-gateway"), undefined);
  assert.equal(presentationBrand("custom"), undefined);
});

test("model brand is separate from provider route and has a safe unknown fallback", () => {
  assert.equal(presentationBrand("anthropic/claude-sonnet-4", true), "claude");
  assert.equal(presentationBrand("openrouter"), undefined);
  assert.equal(presentationBrand("deepseek-v4-flash", true), "deepseek");
  assert.equal(presentationBrand("qwen3-coder", true), "qwen");
  assert.equal(presentationBrand("my-claude-proxy", true), undefined);
  assert.equal(presentationBrand("unknown-model", true), undefined);
});
