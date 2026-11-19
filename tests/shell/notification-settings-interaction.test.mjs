import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { act } from "react";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("destination settings controls dispatch the correct master and target actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notification-settings-interaction-"));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "https://workbench.example",
  });
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
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const oldRaf = globalThis.requestAnimationFrame,
    oldCancel = globalThis.cancelAnimationFrame;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  let app;
  try {
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    const source = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {IntlProvider} from 'react-intl';
      import {AsyncNoticesContext} from './apps/workbench-web/src/components/async-notices-context';
      import {NotificationDestinationSettings} from './apps/workbench-web/src/components/notification-destination-settings';
      const config={actorId:'user',enabled:true,hosts:[],imTargets:[],destinations:[{id:'one',kind:'webhook',label:'receiver.example / ••••••',enabled:true,authorized:true}]};
      const snap={phase:'ready',configuration:config,busy:null};
      const notices={loading(){},info(){},success(){},warning(){},error(){},dismiss(){},dismissAll(){}};
      const local={supported:true,permission:'granted',enabled:true,busy:false,delivery:'page',backgroundAvailable:false,testSent:false,error:null};
      export function mount(element,calls){
        const owner={getSnapshot:()=>snap,subscribe:()=>()=>{},operation:async(...args)=>{calls.push(args);return {...config,savedId:"saved-target"}}};
        const root=createRoot(element);
        root.render(React.createElement(IntlProvider,{locale:'en'},React.createElement(AsyncNoticesContext.Provider,{value:notices},React.createElement(NotificationDestinationSettings,{controller:{destinations:owner,setEnabled:()=>{}},local,localDescription:'Local device'}))));
        return root;
      }
    `;
    const outfile = join(dir, "ui.mjs");
    await build({
      stdin: { contents: source, resolveDir: root, sourcefile: "notification-interaction-fixture.ts", loader: "tsx" },
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
    const { mount } = await import(pathToFileURL(outfile).href);
    const calls = [];
    await act(async () => {
      app = mount(document.getElementById("root"), calls);
    });
    const switches = [...document.querySelectorAll('[role="switch"]')];
    const master = switches.find((element) => element.getAttribute("aria-label") === "Notify when a response ends");
    const target = switches.find((element) => element.getAttribute("aria-label") === "Enable Webhook");
    assert.ok(master && target);
    await act(async () => {
      master.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(calls, [
      ["master", { enabled: false }],
      ["enable", { id: "one", enabled: false }],
    ]);
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
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(
      document.activeElement,
      dialog,
      "opening the sheet should focus its surface rather than the text input",
    );
    const input = dialog.querySelector("input");
    assert.ok(input);
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
    });
    assert.equal(calls[2][0], "save");
    assert.deepEqual(calls[2][1].target, { kind: "webhook", url: "https://receiver.example/hook", authorization: "" });
    assert.match(calls[2][1].creationId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(calls[3], ["test", { id: "saved-target" }]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    if (app) await act(async () => app.unmount());
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
