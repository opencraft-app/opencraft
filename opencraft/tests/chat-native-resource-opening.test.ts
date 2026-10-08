import assert from "node:assert/strict";
import test from "node:test";

import { nativeLinkOpenRoute } from "../packages/chat-render-native/src/renderers/resource-opening";

test("native links respect Host denial before considering system URL opening", () => {
  const website = { allowed: true, target: "https://example.com/page" };
  assert.equal(nativeLinkOpenRoute({ ...website, hasHostOpener: true, hostAllowsOpen: true }), "host");
  assert.equal(nativeLinkOpenRoute({ ...website, hasHostOpener: true, hostAllowsOpen: false }), null);
  assert.equal(nativeLinkOpenRoute({ ...website, hasHostOpener: false, hostAllowsOpen: false }), null);
  assert.equal(nativeLinkOpenRoute({ ...website, hasHostOpener: false, hostAllowsOpen: true }), "system");
  assert.equal(nativeLinkOpenRoute({ ...website, allowed: false, hasHostOpener: false, hostAllowsOpen: true }), null);
});

test("native links require a Host for non-system resource targets", () => {
  const file = { allowed: true, target: "workspace://project/readme.md", hostAllowsOpen: true };
  assert.equal(nativeLinkOpenRoute({ ...file, hasHostOpener: false }), null);
  assert.equal(nativeLinkOpenRoute({ ...file, hasHostOpener: true }), "host");
});
