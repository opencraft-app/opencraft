import assert from "node:assert/strict";
import test from "node:test";
import { externalMobileUrl, isMobileContainerEvent, mobileNavigationDisposition, parseMobileContainerRequest, resolveMobileContainerTransport } from "@opencraft/client-product/mobile-container";
import { bindMobileContainer, mobileContainer, mobileContainerSupportsValdi, openMobileSourceSettings, reloadMobileWorkbench } from "../../apps/workbench-web/src/runtime/mobile-container";
import { requestMobileActionSheet, requestMobileConfirmDialog } from "../../apps/workbench-web/src/runtime/mobile-valdi-bridge";
import { readWindowPresentation } from "../../apps/workbench-web/src/runtime/window-presentation";

const identity = { version: 1, runtimeId: "current-document" };
test("source settings and onboarding reload use only the current native bridge", () => {
  const messages: unknown[] = [];
  const target = { opencraftMobile: identity, ReactNativeWebView: { postMessage(raw: string) { messages.push(JSON.parse(raw)); } } } as unknown as Window;
  openMobileSourceSettings(target);
  assert.equal(reloadMobileWorkbench(target), true);
  assert.deepEqual(messages, [{ ...identity, type: "source-settings" }, { ...identity, type: "reload" }]);
  assert.equal(reloadMobileWorkbench({} as Window), false);
});
test("packaged resources require active identities and fixed opaque IDs", () => {
  const request = { ...identity, type: "resource", requestId: "1", resourceId: "a".repeat(64) };
  assert.deepEqual(parseMobileContainerRequest(JSON.stringify(request), identity.runtimeId), request);
  for (const changed of [{ resourceId: "../../private" }, { resourceId: "https://example.org" }, { requestId: "constructor" }, { runtimeId: "retired" }]) {
    assert.equal(parseMobileContainerRequest(JSON.stringify({ ...request, ...changed }), identity.runtimeId), null);
  }
  assert.equal(parseMobileContainerRequest(JSON.stringify({ ...identity, type: "source-settings" }), identity.runtimeId)?.type, "source-settings");
});
test("native appearance is a typed projection from the current packaged document", () => {
  const appearance = { ...identity, type: "appearance", resolvedTheme: "dark", edgeBackgroundColor: "#171717" };
  assert.deepEqual(parseMobileContainerRequest(JSON.stringify(appearance), identity.runtimeId), appearance);
  for (const changed of [{ resolvedTheme: "automatic" }, { edgeBackgroundColor: "url(https://example.org)" }, { edgeBackgroundColor: "#12345" }, { runtimeId: "retired" }]) {
    assert.equal(parseMobileContainerRequest(JSON.stringify({ ...appearance, ...changed }), identity.runtimeId), null);
  }
});
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

test("host-neutral opencraftMobileHost transport and Valdi dialog delegation work without ReactNativeWebView", async () => {
  const valdiIdentity = { version: 1 as const, runtimeId: "native-valdi-doc", capabilities: { valdi: true } };
  const target = new EventTarget() as Window;
  const sent: Array<Record<string, unknown>> = [];
  Object.assign(target, {
    top: target,
    navigator: {},
    opencraftMobile: valdiIdentity,
    opencraftMobileHost: { postMessage(raw: string) { sent.push(JSON.parse(raw)); } },
  });
  assert.notEqual(resolveMobileContainerTransport(target), null);
  assert.equal(mobileContainerSupportsValdi(target), true);
  assert.equal(readWindowPresentation(target).host, "native-container");

  openMobileSourceSettings(target);
  assert.equal(parseMobileContainerRequest(JSON.stringify(sent.at(-1)), valdiIdentity.runtimeId)?.type, "source-settings");

  const confirmPromise = requestMobileConfirmDialog({
    title: "Switch workspace?",
    message: "Current session will close.",
    confirmLabel: "Switch",
    cancelLabel: "Cancel",
    destructive: true,
  }, target);
  assert.notEqual(confirmPromise, null);
  const confirmReq = parseMobileContainerRequest(JSON.stringify(sent.at(-1)), valdiIdentity.runtimeId);
  assert.equal(confirmReq?.type, "confirm-dialog");
  const confirmReply = new Event("opencraft-mobile");
  Object.assign(confirmReply, { detail: { ...valdiIdentity, type: "confirm-dialog-result", requestId: (sent.at(-1) as { requestId: string }).requestId, confirmed: true } });
  target.dispatchEvent(confirmReply);
  assert.equal(await confirmPromise, true);

  const sheetPromise = requestMobileActionSheet({
    title: "Workspace options",
    cancelLabel: "Cancel",
    actions: [{ id: "reload", label: "Reload" }, { id: "reset", label: "Reset", destructive: true }],
  }, target);
  assert.notEqual(sheetPromise, null);
  const sheetReq = parseMobileContainerRequest(JSON.stringify(sent.at(-1)), valdiIdentity.runtimeId);
  assert.equal(sheetReq?.type, "action-sheet");
  const sheetReply = new Event("opencraft-mobile");
  Object.assign(sheetReply, { detail: { ...valdiIdentity, type: "action-sheet-result", requestId: (sent.at(-1) as { requestId: string }).requestId, actionId: "reload" } });
  target.dispatchEvent(sheetReply);
  assert.equal(await sheetPromise, "reload");

  assert.equal(parseMobileContainerRequest(JSON.stringify({ ...valdiIdentity, type: "surface-state", surface: "welcome" }), valdiIdentity.runtimeId)?.type, "surface-state");
  assert.equal(isMobileContainerEvent({ ...valdiIdentity, type: "navigate-settings", section: "valdi-ui-kit" }, valdiIdentity.runtimeId), true);
  assert.equal(isMobileContainerEvent({ ...valdiIdentity, type: "theme-preference", preference: "dark" }, valdiIdentity.runtimeId), true);
});
