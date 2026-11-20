import assert from "node:assert/strict";
import test from "node:test";
import { chatLinkOpensExternally } from "../../apps/workbench-web/src/browser/web-browser-runtime";

test("Web default respects recognized internal links and explicit user destinations", () => {
  assert.equal(chatLinkOpensExternally("web", undefined, false), true);
  assert.equal(chatLinkOpensExternally("web", undefined, true), false);
  for (const recognized of [true, false]) {
    assert.equal(chatLinkOpensExternally("web", { target: "in-app-browser", source: "context-menu", disposition: "current-tab" }, recognized), false);
    assert.equal(chatLinkOpensExternally("web", { target: "external-browser", source: "context-menu", disposition: "current-tab" }, recognized), true);
  }
});

test("Electron defaults and alternate-tab intents preserve their destination", () => {
  assert.equal(chatLinkOpensExternally("electron", undefined, false), false);
  for (const disposition of ["current-tab", "new-tab"] as const) {
    assert.equal(chatLinkOpensExternally("electron", { target: "default", source: "pointer", disposition }, false), false);
    assert.equal(chatLinkOpensExternally("web", { target: "default", source: "pointer", disposition }, false), true);
  }
});
