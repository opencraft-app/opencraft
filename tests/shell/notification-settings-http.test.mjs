import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act } from "react";
import { openPushStore, TurnPushService } from "@opencraft/web-push-node";
import { createWorkbenchWebServer } from "../../apps/headless-server/src/serve-workbench-web.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("notification editor saves and tests through real HTTP and the SQLite worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notification-settings-http-"));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1" });
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "MutationObserver",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "CustomEvent",
    "getComputedStyle",
  ];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "getComputedStyle" ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key],
    });
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT,
    oldRaf = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  let server, push, app, owner;
  try {
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    const sent = [];
    const store = await openPushStore(join(dir, "push.sqlite"));
    const binding = {
      context: { actorId: "human-a", credentialId: null, generation: 1, expiresAt: Date.now() + 60_000 },
    };
    push = new TurnPushService(store, {
      authenticate: () => binding,
      current: () => true,
      trustedOrigin: () => null,
      hosts: [],
      read: async () => ({}),
      sendExternal: async (target, message) => {
        sent.push({ target, message });
      },
    });
    server = await createWorkbenchWebServer({ root: dir, appServerTarget: null, turnPushService: push });
    const base = `http://127.0.0.1:${(await server.listen({ host: "127.0.0.1", port: 0 })).port}`;
    const source = `
      import React from 'react'; import {createRoot} from 'react-dom/client'; import {IntlProvider} from 'react-intl';
      import {AsyncNoticesContext} from './apps/workbench-web/src/components/async-notices-context';
      import {NotificationDestinationSettings} from './apps/workbench-web/src/components/notification-destination-settings';
      import {NotificationDestinationsController} from './apps/workbench-web/src/runtime/notification-destinations';
      const notices={loading(){},info(){},success(){},warning(){},error(){},dismiss(){},dismissAll(){}};
      const local={supported:true,permission:'granted',enabled:true,busy:false,delivery:'page',backgroundAvailable:false,testSent:false,error:null};
      const messages={completed:'Done',failed:'Failed',interrupted:'Stopped',body:'Return',test:'Test'};
      export async function prepare(base){
        const owner=new NotificationDestinationsController((url,init={})=>fetch(base+url,{...init,headers:{...init.headers,origin:base}}));
        owner.configure('en-US',messages); await owner.refresh(); return owner;
      }
      export function mount(element,owner){const root=createRoot(element);root.render(React.createElement(IntlProvider,{locale:'en'},React.createElement(AsyncNoticesContext.Provider,{value:notices},React.createElement(NotificationDestinationSettings,{controller:{destinations:owner,setEnabled:()=>{}},local,localDescription:'Local device'}))));return root;}
    `;
    const outfile = join(dir, "ui.mjs");
    await build({
      stdin: { contents: source, resolveDir: root, sourcefile: "notification-http-fixture.ts", loader: "tsx" },
      outfile,
      banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node26",
      logLevel: "silent",
      external: ["react", "react/*", "react-dom", "react-dom/*", "react-intl"],
      loader: { ".scss": "empty", ".css": "empty" },
    });
    const ui = await import(pathToFileURL(outfile).href);
    owner = await ui.prepare(base);
    assert.equal(owner.getSnapshot().phase, "ready");
    await act(async () => {
      app = ui.mount(document.getElementById("root"), owner);
    });
    const add = [...document.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === "Add notification method",
    );
    assert.ok(add);
    await act(async () => {
      add.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const webhook = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === "Webhook",
    );
    assert.ok(webhook);
    await act(async () => {
      webhook.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    const dialog = document.querySelector('[role="dialog"]'),
      input = dialog?.querySelector("input");
    assert.ok(dialog && input);
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(
        input,
        "https://receiver.example/hook",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll("button")].find((element) => element.textContent === "Save and test");
    assert.ok(save);
    await act(async () => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const deadline = Date.now() + 5000;
      while (!sent.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.url, "https://receiver.example/hook");
    assert.equal(sent[0].message.event, "notification.test");
    assert.equal((await store.devices("human-a")).length, 1);
    assert.match(document.body.textContent, /receiver\.example/);
  } finally {
    if (app) await act(async () => app.unmount());
    owner?.dispose();
    await server?.close();
    await push?.close();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
    globalThis.requestAnimationFrame = oldRaf;
    globalThis.cancelAnimationFrame = oldCancel;
    await rm(dir, { recursive: true, force: true });
  }
});
