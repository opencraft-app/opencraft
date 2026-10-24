import assert from "node:assert/strict";
import test from "node:test";
import { activateDesktopProduct, composeDesktopBridge } from "../../apps/workbench-electron/src/desktop-product-lifetime.js";
import type { DesktopProductFactory, DesktopProductPorts } from "../../apps/workbench-electron/src/product-contract.js";

const ports: Omit<DesktopProductPorts, "handle"> = {
  userDataDirectory: "/unused-fixture-profile", privateStorage: { read: () => null, write() {}, remove() {} },
  async openExternal() {}, async showWindow() {}, registerProtocol() {},
};
function ipcFixture() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return { handlers, handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) {
    if (handlers.has(channel)) throw new Error("Handler already exists");
    handlers.set(channel, handler);
  }, removeHandler(channel: string) { handlers.delete(channel); } };
}

test("public desktop does not activate a product or register account handlers", () => {
  const ipc = ipcFixture();
  assert.equal(activateDesktopProduct(null, ports, ipc, () => true), null);
  assert.equal(ipc.handlers.size, 0);
  assert.throws(() => activateDesktopProduct(undefined as unknown as DesktopProductFactory, ports, ipc, () => true), /Invalid desktop product factory/);
});

test("product handlers enforce the current Main trust decision and retire with their owner", async () => {
  const ipc = ipcFixture(), acceptedEvent = {}, trace: string[] = [];
  let trusted = true;
  const factory: DesktopProductFactory = api => {
    api.handle("example:profile", value => { trace.push("request"); return value; });
    return { receiveUrl: async url => url === "example://callback", cancelInteractions: () => trace.push("cancel"), dispose: () => trace.push("dispose") };
  };
  const session = activateDesktopProduct(factory, ports, ipc, event => trusted && event === acceptedEvent)!;
  const request = ipc.handlers.get("example:profile")!;
  assert.throws(() => request({}), /Untrusted/);
  assert.equal(request(acceptedEvent, "profile"), "profile");
  trusted = false;
  assert.throws(() => request(acceptedEvent), /Untrusted/);
  assert.equal(await session.receiveUrl("example://callback"), true);
  session.cancelInteractions();
  session.dispose(); session.dispose(); session.cancelInteractions();
  assert.equal(session.receiveUrl("example://callback"), null);
  assert.throws(() => request(acceptedEvent), /Untrusted/);
  assert.deepEqual(trace, ["request", "cancel", "dispose"]);
  assert.equal(ipc.handlers.size, 0);
});

test("activation failure removes acquired handlers and does not remove another owner's collision", () => {
  const ipc = ipcFixture();
  const existing = () => "core";
  ipc.handle("core:reserved", existing);
  assert.throws(() => activateDesktopProduct(api => {
    api.handle("example:temporary", () => null);
    api.handle("core:reserved", () => null);
    throw new Error("unreachable");
  }, ports, ipc, () => true), /already exists/);
  assert.deepEqual([...ipc.handlers.keys()], ["core:reserved"]);
  assert.equal(ipc.handlers.get("core:reserved"), existing);
});

test("throwing product disposal still retires every acquired handler", () => {
  const ipc = ipcFixture();
  const session = activateDesktopProduct(api => {
    api.handle("example:first", () => null); api.handle("example:second", () => null);
    return { receiveUrl: () => null, cancelInteractions() {}, dispose() { throw new Error("fixture cleanup"); } };
  }, ports, ipc, () => true)!;
  assert.throws(() => session.dispose(), /Desktop product disposal failed/);
  assert.equal(ipc.handlers.size, 0);
  session.dispose();
});

test("product preload contributes a namespace without replacing core privileges", () => {
  const bridge = composeDesktopBridge({ kind: "electron", browser: {} }, { exampleAccount: { signIn() {} } });
  assert.equal(bridge.kind, "electron"); assert.ok(bridge.exampleAccount); assert.equal(Object.isFrozen(bridge), true);
  assert.throws(() => composeDesktopBridge({ browser: {} }, { browser: {} }), /cannot replace/);
});
