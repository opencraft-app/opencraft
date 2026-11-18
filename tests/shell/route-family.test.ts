import assert from "node:assert/strict";
import test from "node:test";
import { routePresentationKey, currentRoutePresentationKey, projectRouteStack } from "../../apps/workbench-web/src/runtime/route-presentation-key";
import { asRouteScopeId } from "@opencraft/workbench-runtime";
const families = new Map([["inbox", "inbox-renderer"], ["chat", "inbox-renderer"]]);
const page = (viewId: string, resourceUri: string | null = null, scope = "scope") => ({ id: JSON.stringify([viewId, resourceUri]), routeScopeId: asRouteScopeId(scope), route: { kind: "extension-view" as const, viewId, resourceUri } });
test("collection and detail resources share a single explicitly opted-in owner", () => {
  const key = routePresentationKey(page("inbox"), families);
  assert.equal(key, routePresentationKey(page("chat", "channel:a"), families));
  assert.equal(key, routePresentationKey(page("chat", "channel:b#message=8"), families));
  assert.equal(key, currentRoutePresentationKey(page("chat", "channel:a").route, "scope", families));
});
test("default route retention identity is unchanged and unrelated roots remain separate", () => {
  const value = page("inbox"); assert.equal(routePresentationKey(value), JSON.stringify([value.id, value.routeScopeId]));
  assert.notEqual(routePresentationKey(value, families), routePresentationKey(page("agents"), families));
  assert.notEqual(routePresentationKey(page("chat", "channel:a")), routePresentationKey(page("chat", "channel:b")));
});
test("different route scope and renderer families cannot borrow retained content", () => {
  assert.notEqual(routePresentationKey(page("chat", "channel:a"), families), routePresentationKey(page("chat", "channel:a", "other-account-scope"), families));
  assert.notEqual(routePresentationKey(page("chat"), families), routePresentationKey(page("chat"), new Map([["chat", "other-renderer"]])));
});

test("motion retains semantic path/current across adjacent and re-entered families", () => {
  const a = page("inbox"), a2 = page("chat", "channel:a"), b = page("agents");
  for (const path of [[a,a2], [b,a,a2], [a,b,a2]]) {
    const leaf = path.at(-1)!;
    const projected = projectRouteStack({navigationPath:path, applicationRoute:leaf.route, routeScopeId:leaf.routeScopeId}, "account", families);
    assert.equal(projected.current,JSON.stringify([leaf.id,leaf.routeScopeId]));
    assert.equal(projected.path.length,path.length);
    assert.equal(projected.owner,routePresentationKey(leaf,families));
    for(let i=path.length-1;i>=0;i--){const leaf=path[i]!;const pop=projectRouteStack({navigationPath:path.slice(0,i+1),applicationRoute:leaf.route,routeScopeId:leaf.routeScopeId},"account",families);assert.equal(pop.current,JSON.stringify([leaf.id,leaf.routeScopeId]));}
  }
});
