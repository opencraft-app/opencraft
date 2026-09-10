import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveNavigation, projectNavigation } from "../packages/workbench-runtime/src/adaptive-navigation";

test("viewport projections never mutate the path or publish navigation", () => {
  const navigation = new AdaptiveNavigation({ id: "settings", minWidth: 220 });
  navigation.enter("settings", { id: "providers", minWidth: 220 });
  navigation.enter("providers", { id: "deepseek", minWidth: 360 });
  const path = navigation.getSnapshot(); let events = 0;
  navigation.subscribe(() => events++);
  assert.deepEqual(projectNavigation(path, 390), ["deepseek"]);
  assert.deepEqual(projectNavigation(path, 600), ["providers", "deepseek"]);
  assert.deepEqual(projectNavigation(path, 1000), ["settings", "providers", "deepseek"]);
  assert.deepEqual(projectNavigation(path, 0), ["deepseek"]);
  assert.equal(navigation.getSnapshot(), path); assert.equal(events, 0);
});
test("wide default preview does not become a compact route", () => {
  const navigation = new AdaptiveNavigation({ id: "providers", minWidth: 220 });
  const preview = { id: "deepseek", minWidth: 360 };
  assert.deepEqual(projectNavigation(navigation.getSnapshot(), 800, preview), ["providers", "deepseek"]);
  assert.deepEqual(projectNavigation(navigation.getSnapshot(), 390, preview), ["providers"]);
  assert.equal(navigation.back(), false);
});
test("selecting siblings replaces detail; back removes one semantic level", () => {
  const navigation = new AdaptiveNavigation({ id: "providers", minWidth: 220 });
  navigation.enter("providers", { id: "one", minWidth: 360 });
  navigation.enter("providers", { id: "two", minWidth: 360 });
  assert.equal(navigation.getSnapshot().length, 2);
  assert.equal(navigation.back(), true); assert.equal(navigation.back(), false);
  assert.throws(() => navigation.enter("missing", { id: "one", minWidth: 360 }));
});
