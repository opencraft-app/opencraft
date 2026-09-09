import assert from "node:assert/strict";
import test from "node:test";
import { DesktopLifecycle, type LifecycleWindow } from "../apps/workbench-electron/src/desktop-lifecycle";

function fixture() {
  const calls: string[] = [];
  let close: (event: { preventDefault(): void }) => void = () => {};
  const window: LifecycleWindow = {
    isDestroyed: () => false, isMinimized: () => true,
    hide: () => { calls.push("hide"); }, show: () => { calls.push("show"); },
    focus: () => { calls.push("focus"); }, restore: () => { calls.push("restore"); },
    on: (_, listener) => { close = listener; },
  };
  const ports = {
    getWindow: () => window as LifecycleWindow | null,
    createWindow: async () => { calls.push("create"); },
    showDock: async () => { calls.push("dock-show"); }, hideDock: () => { calls.push("dock-hide"); },
    stopRuntime: async () => { calls.push("stop"); }, destroyTray: () => { calls.push("tray-destroy"); },
    exit: (code: number) => { calls.push(`exit:${code}`); }, reportError: () => { calls.push("error"); },
  };
  const lifecycle = new DesktopLifecycle(ports);
  lifecycle.bindWindow(window);
  return { lifecycle, calls, ports, close: () => close({ preventDefault: () => calls.push("prevent") }) };
}
test("close hides window and Dock without stopping runtime; show restores the same window", async () => {
  const f = fixture(); f.close();
  assert.deepEqual(f.calls, ["prevent", "hide", "dock-hide"]);
  await f.lifecycle.show();
  assert.deepEqual(f.calls.slice(3), ["dock-show", "restore", "show", "focus"]);
});
test("repeated quit awaits one shutdown and destroys tray afterwards", async () => {
  const f = fixture(); let finish!: () => void;
  f.ports.stopRuntime = () => { f.calls.push("stop"); return new Promise(resolve => { finish = resolve; }); };
  const first = f.lifecycle.quit(); const second = f.lifecycle.quit();
  assert.equal(first, second);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.calls, ["stop"]);
  await f.lifecycle.show(); assert.deepEqual(f.calls, ["stop"]);
  finish(); await first;
  assert.deepEqual(f.calls, ["stop", "tray-destroy", "exit:0"]);
});
test("failed shutdown is reported before exit", async () => {
  const f = fixture(); f.ports.stopRuntime = async () => { throw new Error("failure"); };
  await f.lifecycle.quit(); assert.deepEqual(f.calls, ["error", "tray-destroy", "exit:1"]);
});
test("quit during Dock activation never creates or reveals a window", async () => {
  const f = fixture(); let finish!: () => void;
  f.ports.showDock = () => new Promise(resolve => { finish = resolve; });
  const opening = f.lifecycle.show(); await Promise.resolve();
  const stopping = f.lifecycle.quit(); finish(); await opening; await stopping;
  assert.deepEqual(f.calls, ["stop", "tray-destroy", "exit:0"]);
});
