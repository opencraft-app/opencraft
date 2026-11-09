import assert from "node:assert/strict";
import test from "node:test";
import { modelChoiceFamilies, chooseFamilyModel } from "../../packages/composer-editor/src/model-choice-families";
import type { ComposerModelOption } from "../../packages/composer-editor/src/composer-editor";

function model(id: string, label: string): ComposerModelOption {
  return { id, value: id, label, description: null, isDefault: false, efforts: [], defaultEffort: null };
}
test("Codex effort variants become one model family without losing any concrete selection", () => {
  const entries = ["low", "medium", "high", "xhigh", "max", "ultra"].map(effort => model(`codex:gpt-one[${effort}]`, `Model One (${effort})`));
  const families = modelChoiceFamilies(entries);
  assert.equal(families.length, 1); assert.equal(families[0]!.label, "Model One");
  assert.deepEqual(families[0]!.variants.map(variant => variant.model.value), entries.map(entry => entry.value));
  assert.equal(chooseFamilyModel(families[0]!, "codex:gpt-one[xhigh]").value, "codex:gpt-one[xhigh]");
  assert.equal(chooseFamilyModel(families[0]!, "codex:gpt-other[high]").value, "codex:gpt-one[high]");
});
test("a new family resolves only an advertised variant, with its declared default preferred", () => {
  const family = modelChoiceFamilies([model("codex:a[low]", "A (low)"), { ...model("codex:a[high]", "A (high)"), isDefault: true }])[0]!;
  assert.equal(chooseFamilyModel(family, "codex:b[ultra]").value, "codex:a[high]");
  assert.equal(chooseFamilyModel(family, null).value, "codex:a[high]");
});
test("names alone never create capabilities or merge distinct provider models", () => {
  const entries = [model("api:one", "Same (high)"), model("api:two", "Same (high)"), model("cursor:one[high]", "Same (high)"),
    { ...model("codex:native[high]", "Native (high)"), efforts: [{ value: "low", label: "Low", description: null }] }];
  const families = modelChoiceFamilies(entries);
  assert.equal(families.length, 4); assert.ok(families.every(family => family.variants.length === 0));
  assert.deepEqual(families.map(family => family.label), entries.map(entry => entry.label));
});
