import assert from "node:assert/strict";
import test from "node:test";
import { externalMobileUrl, isMobileContainerEvent, mobileNavigationDisposition, parseMobileContainerRequest } from "@opencraft/client-product/mobile-container";
import { bindMobileContainer, mobileContainer } from "../../apps/workbench-web/src/runtime/mobile-container";

const identity = { version: 1, runtimeId: "current-document" };
test("normal browser startup ignores an absent or malformed native bridge", () => {
  for (const ReactNativeWebView of [undefined, {}, { postMessage: "invalid" }]) {
    assert.equal(mobileContainer({ opencraftMobile: identity, ReactNativeWebView } as unknown as Window), null);
  }
});
test("only the initial local document can become the privileged top frame", () => {
  assert.equal(mobileNavigationDisposition("https://opencraft.invalid/", true, true), "allow");
  assert.equal(mobileNavigationDisposition("https://opencraft.invalid/", true, false), "reject");
  assert.equal(mobileNavigationDisposition("about:blank", true, false), "reject");
  assert.equal(mobileNavigationDisposition("https://example.org/", true, false), "external");
  assert.equal(mobileNavigationDisposition("https://example.org/", false, true), "reject");
  assert.equal(mobileNavigationDisposition("about:srcdoc", false, false), "allow");
  for (const url of ["javascript:alert(1)", "file:///private", "intent://anything", "data:text/html,content"]) assert.equal(mobileNavigationDisposition(url, true, true), "reject");
});
test("native boundary rejects old documents, unknown versions, malformed and oversized messages", () => {
  for (const value of [null, [], {}, { ...identity, version: 2, type: "ready" }, { ...identity, runtimeId: "retired-document", type: "ready" }, { ...identity, type: "navigation", canGoBack: "true" }, { ...identity, type: "execute", script: "anything" }]) {
    assert.equal(parseMobileContainerRequest(JSON.stringify(value), identity.runtimeId), null);
  }
  assert.equal(parseMobileContainerRequest("{", identity.runtimeId), null);
  assert.equal(parseMobileContainerRequest(" ".repeat(16385), identity.runtimeId), null);
  assert.equal(parseMobileContainerRequest(JSON.stringify({ ...identity, type: "ready" }), identity.runtimeId)?.type, "ready");
});
test("external navigation cannot execute code, open private files, pass URL credentials or replace the packaged origin", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,anything", "file:///private/data", "intent://anything", "https://opencraft.invalid/", "https://user:password@example.org/", "invalid"]) {
    assert.equal(externalMobileUrl(url), null);
    assert.equal(parseMobileContainerRequest(JSON.stringify({ ...identity, type: "external", url }), identity.runtimeId), null);
  }
  assert.equal(externalMobileUrl("https://example.org/docs"), "https://example.org/docs");
  assert.equal(externalMobileUrl("mailto:team@example.org"), "mailto:team@example.org");
});
test("visibility and back events require the active document identity and typed payload", () => {
  assert.equal(isMobileContainerEvent({ ...identity, type: "back" }, identity.runtimeId), true);
  assert.equal(isMobileContainerEvent({ ...identity, type: "visibility", active: false }, identity.runtimeId), true);
  assert.equal(isMobileContainerEvent({ ...identity, type: "visibility", active: "false" }, identity.runtimeId), false);
  assert.equal(isMobileContainerEvent({ ...identity, type: "back" }, "replacement"), false);
});
test("container events use the existing navigation owner and teardown rejects late events", () => {
  const target = new EventTarget() as Window;
  const document = new EventTarget();
  const messages: Array<Record<string, unknown>> = [];
  Object.assign(target, { document, opencraftMobile: identity, ReactNativeWebView: { postMessage(raw: string) { messages.push(JSON.parse(raw)); } } });
  let backs = 0;
  let canGoBack = false;
  let publish: (() => void) | null = null;
  const navigation = { getSnapshot: () => ({ canGoBack }), back: () => { backs++; }, subscribe(listener: () => void) { publish = listener; return () => { publish = null; }; } };
  const binding = bindMobileContainer(navigation as Parameters<typeof bindMobileContainer>[0], target);
  const send = (detail: unknown) => { const event = new Event("opencraft-mobile"); Object.assign(event, { detail }); target.dispatchEvent(event); };
  assert.deepEqual(messages.map(message => message.type), ["ready", "navigation"]);
  canGoBack = true;
  publish!();
  assert.equal(messages.at(-1)!.canGoBack, true);
  send({ ...identity, type: "visibility", active: false });
  assert.equal(binding.active(), false);
  send({ ...identity, runtimeId: "retired", type: "visibility", active: true });
  assert.equal(binding.active(), false);
  send({ ...identity, type: "back" });
  assert.equal(backs, 1);
  send({ ...identity, type: "visibility", active: true });
  assert.equal(binding.active(), true);
  binding.dispose();
  assert.equal(publish, null);
  send({ ...identity, type: "back" });
  assert.equal(backs, 1);
});
