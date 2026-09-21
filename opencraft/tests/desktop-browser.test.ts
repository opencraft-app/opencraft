import assert from "node:assert/strict";
import test from "node:test";
import { isBrowserGuestUrl, installBrowserGuests } from "../apps/workbench-electron/src/browser-guests";
test("guest attachment cannot choose arbitrary partitions, preload or Node privileges", () => {
  const callbacks = new Map<string, Function>();
  installBrowserGuests({ on: (name: string, fn: Function) => callbacks.set(name, fn) } as never);
  for (const partition of ["persist:application", "", undefined]) {
    let prevented = false;
    callbacks.get("will-attach-webview")!({ preventDefault: () => prevented = true }, {}, { partition, src: "https://example.com" });
    assert.equal(prevented, true);
  }
  const prefs: any = { preload: "/untrusted", nodeIntegration: true, webSecurity: false };
  callbacks.get("will-attach-webview")!({ preventDefault: () => assert.fail("valid attachment rejected") }, prefs,
    { partition: "persist:opencraft-browser:browser-test", src: "https://example.com" });
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "opencraft://x", "https://user:password@example.com"]) assert.equal(isBrowserGuestUrl(url), false);
  assert.equal(isBrowserGuestUrl("about:blank"), true);
});
