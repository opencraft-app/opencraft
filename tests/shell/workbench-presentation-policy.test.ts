import assert from "node:assert/strict";
import test from "node:test";
import { builtinThemeIds, normalizeBuiltinThemeId, parseWorkbenchPresentation, resolveWorkbenchPresentation } from "../../apps/workbench-web/src/workbench-presentation";
import { applyWorkbenchProductPresentation } from "../../apps/workbench-web/src/workbench-product";

test("presentation input is validated and detached from the product's mutable declaration", () => {
  const hidden = ["optional-theme"];
  const policy = resolveWorkbenchPresentation({iconStyle: "classic", defaultThemeId: "existing-theme", hiddenBuiltinThemeIds: hidden});
  hidden.push("another-theme");
  assert.deepEqual(policy.hiddenBuiltinThemeIds, ["optional-theme"]);
  assert(Object.isFrozen(policy)); assert(Object.isFrozen(policy.hiddenBuiltinThemeIds));
  for (const value of [null, [], 1, {iconStyle:"typo"}, {defaultThemeId:" "}, {defaultThemeId:3},
    {hiddenBuiltinThemeIds:"theme"}, {hiddenBuiltinThemeIds:[3]}, {defaultThemeId:"x",hiddenBuiltinThemeIds:["x"]}]) {
    assert.throws(() => parseWorkbenchPresentation(JSON.stringify(value)), TypeError);
  }
  assert.throws(() => parseWorkbenchPresentation("{"), SyntaxError);
  assert.equal(parseWorkbenchPresentation().iconStyle, "standard");
});

test("root presentation follows explicit options and resets obsolete classic overrides", () => {
  const properties = new Map<string,string>();
  const root = {dataset:{},style:{setProperty:(k:string,v:string)=>properties.set(k,v), removeProperty:(k:string)=>properties.delete(k)}} as unknown as HTMLElement;
  const classic = resolveWorkbenchPresentation({iconStyle:"classic"});
  applyWorkbenchProductPresentation(root, "independent-product", classic);
  assert.equal(properties.get("--size-product-navigation-icon"), "auto");
  assert.equal(properties.has("--padding-navigation-list-inline"), false, "icon style does not own navigation gutters");
  applyWorkbenchProductPresentation(root, "example-web", resolveWorkbenchPresentation());
  assert.equal(properties.has("--size-product-navigation-icon"), false);
  assert.equal(properties.get("--size-icon-navigation"), "14px");
  assert.equal(properties.has("--padding-navigation-list-inline"), false, "standard icons cannot remove navigation gutters");
});


test("current built-in aliases preserve policy constraints without renaming extensions", () => {
  const previousGraphiteId = "opencraft.core.zencode";
  assert.equal(normalizeBuiltinThemeId(previousGraphiteId), builtinThemeIds.graphite);
  assert.equal(resolveWorkbenchPresentation({defaultThemeId:previousGraphiteId}).defaultThemeId, builtinThemeIds.graphite);
  assert.deepEqual(resolveWorkbenchPresentation({hiddenBuiltinThemeIds:[previousGraphiteId,builtinThemeIds.graphite]}).hiddenBuiltinThemeIds,[builtinThemeIds.graphite]);
  for (const [selected,hidden] of [[previousGraphiteId,builtinThemeIds.graphite],[builtinThemeIds.graphite,previousGraphiteId]]) {
    assert.throws(()=>resolveWorkbenchPresentation({defaultThemeId:selected,hiddenBuiltinThemeIds:[hidden!]}), TypeError);
  }
  for (const extension of ["vendor.extension.paper", "vendor.core.web", "vendor.core.custom", builtinThemeIds.longing]) {
    assert.equal(normalizeBuiltinThemeId(extension), extension);
    assert.equal(resolveWorkbenchPresentation({defaultThemeId:extension}).defaultThemeId, extension);
  }
});
