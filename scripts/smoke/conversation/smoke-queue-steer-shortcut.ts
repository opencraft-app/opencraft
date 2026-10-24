import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import type { Browser, Page } from "playwright";

// Only the owner-supplied submit/queue command boundary is synthetic. This mounts
// the real controller, ProseMirror keymap, queue tray and complete Composer.
const source = `
import React, {useState} from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {createConversationKey} from '@opencraft/chat-core';
import {createComposerController, composerDocumentToPlainText} from '@opencraft/composer-core';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {restoreQueuedInput,compileSubmitIntent} from '@opencraft/composer-appserver';
import '/apps/workbench-web/src/styles/app.scss';
const documentFor = text => ({version:1, blocks:[{type:'paragraph', children:text ? [{type:'text',text}] : []}]});
const makeController = id => createComposerController({type:'existing-thread',key:createConversationKey('probe',id)}, {now:Date.now,createId:()=>crypto.randomUUID()});
const item = (id, preview) => ({id,preview,state:'queued',operation:'idle',actionable:true,editableContent:{document:documentFor(preview),attachments:[],context:[]}});
const actions = [];
let release, editedInput;
function App() {
  const [controller,setController] = useState(()=>makeController('one'));
  const [rows,setRows] = useState(()=>[item('top','First queued message'),item('next','Second queued message')]);
  const [config,setConfig] = useState({mode:'queue',streaming:true,supported:true,disabled:false,submissionDisabled:false,hold:false});
  window.fixture = {
    controller, actions, config, configure: patch=>setConfig(c=>({...c,...patch})),
    replaceRows:setRows, item, release:()=>release?.(),
    nativeImage(){setRows([{...item('image','Queued image'),editableContent:restoreQueuedInput([{type:'image',fileId:'uploaded-image-1'}])}])},
    editedInput:()=>editedInput,
    switchThread:()=>{setController(makeController('two'));setRows([item('new-top','New thread queue')])},
    attachment:lifecycle=>controller.dispatch({type:'add-attachment',attachment:{id:'file',name:'notes.txt',mimeType:'text/plain',size:3,uri:lifecycle==='ready'?'data:text/plain,abc':null,lifecycle,error:null}}),
  };
  return <main style={{maxWidth:900,margin:'32px auto',padding:12}}><OpenCraftComposer
    controller={controller} placeholder='Write a message' isStreaming={config.streaming}
    defaultFollowUpAction={config.mode} supportsQueuedSteer={config.supported}
    disabled={config.disabled} submissionDisabled={config.submissionDisabled}
    queuedSubmissions={rows}
    onSubmit={(intent,context)=>{
      actions.push({type:'submit',action:context.followUpAction,text:composerDocumentToPlainText(intent.document),attachments:intent.attachments.length});
      if(context.followUpAction==='queue')setRows(previous=>[...previous,item('added',composerDocumentToPlainText(intent.document))]);
      return true;
    }}
    onUpdateQueuedSubmission={async(id,intent)=>{editedInput=compileSubmitIntent(intent).input;actions.push({type:'edit',id,text:composerDocumentToPlainText(intent.document)})}}
    onSteerQueuedSubmission={async id=>{
      actions.push({type:'queue-steer',id});
      if(config.hold)await new Promise(resolve=>release=resolve);
      setRows(previous=>previous.filter(row=>row.id!==id));
    }} onCancel={()=>actions.push({type:'cancel'})}/></main>;
}
createIntlTestRoot(document.getElementById('root')).render(<App/>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-queue-steer-shortcut",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "queue-steer-shortcut-probe",
    resolveId: id => id === "/queue-shortcut.tsx" ? id : null,
    load: id => id === "/queue-shortcut.tsx" ? source : null,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html");
        res.end('<div id="root"></div><script type="module" src="/queue-shortcut.tsx"></script>');
      });
    },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
let browser: Browser | undefined;
const actions = (page: Page) => page.evaluate(() => (window as any).fixture.actions);
const configure = async (page: Page, patch: Record<string, unknown>) => {
  await page.evaluate(value => (window as any).fixture.configure(value), patch);
  await page.waitForTimeout(30);
};
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const origin = vite.resolvedUrls!.local[0]!;
  for (const mac of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.addInitScript({content: `Object.defineProperty(navigator, "platform", {get: function () {return "${mac ? "MacIntel" : "Linux x86_64"}";}});`});
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const editor = page.locator(".opencraft-composer-editor");
    const shortcut = mac ? "Meta+Enter" : "Control+Enter";
    const reset = async () => {
      await page.goto(origin);
      await editor.waitFor();
      assert.equal(await page.evaluate(() => navigator.platform), mac ? "MacIntel" : "Linux x86_64");
      await editor.click();
    };
    const press = async () => { await editor.focus(); await page.keyboard.press(shortcut); await page.waitForTimeout(35); };

    // The requested sequence: Enter queues the draft; modified Enter consumes
    // exactly the visible head, preserving all following rows and empty input.
    await reset();
    await page.keyboard.insertText("A newly queued message");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window as any).fixture.actions.length === 1);
    assert.deepEqual(await actions(page), [{ type: "submit", action: "queue", text: "A newly queued message", attachments: 0 }]);
    assert.equal(await editor.textContent(), "");
    await press();
    assert.deepEqual((await actions(page))[1], { type: "queue-steer", id: "top" });
    assert.equal(await page.locator(".opencraft-composer-queue-item").count(), 2);
    assert.equal(await editor.textContent(), "");

    // Existing text and attachment-only drafts always win over the queue.
    await reset();
    await page.keyboard.insertText("Steer this draft");
    await press();
    assert.deepEqual(await actions(page), [{ type: "submit", action: "steer", text: "Steer this draft", attachments: 0 }]);
    assert.equal(await page.locator(".opencraft-composer-queue-item").count(), 2);
    await reset();
    await page.evaluate(() => (window as any).fixture.attachment("ready"));
    await press();
    assert.deepEqual(await actions(page), [{ type: "submit", action: "steer", text: "", attachments: 1 }]);
    await reset();
    await page.evaluate(() => (window as any).fixture.attachment("processing"));
    await press();
    assert.deepEqual(await actions(page), []);
    assert.equal(await page.evaluate(() => (window as any).fixture.controller.getSnapshot().draft.attachments.length), 1);

    // Mode changes use the live policy without rebuilding the physical editor.
    await reset();
    await page.evaluate(() => (window as any).originalEditor = document.querySelector(".opencraft-composer-editor"));
    await configure(page, { mode: "steer" });
    await press();
    assert.deepEqual(await actions(page), []);
    await page.keyboard.insertText("Inverse mode queues this draft");
    await press();
    assert.equal((await actions(page))[0].action, "queue");
    await configure(page, { mode: "queue" });
    await page.evaluate(() => { const f=(window as any).fixture; f.replaceRows([f.item('next','Second queued message'),f.item('top','First queued message')]); });
    await page.waitForTimeout(30);
    await press();
    assert.deepEqual((await actions(page))[1], { type: "queue-steer", id: "next" });
    assert.equal(await page.evaluate(() => (window as any).originalEditor === document.querySelector(".opencraft-composer-editor")), true);

    // A blocked head is never skipped, even when a later row is actionable.
    for (const patch of [{ actionable: false }, { operation: "starting" }, { pausedReason: "restored-after-host-restart" }]) {
      await reset();
      await page.evaluate(value => { const f=(window as any).fixture; f.replaceRows([{...f.item('top','Blocked head'),...value},f.item('next','Actionable later row')]); }, patch);
      await page.waitForTimeout(30);
      await press();
      assert.deepEqual(await actions(page), [], JSON.stringify(patch));
    }
    await reset();
    await page.evaluate(() => { const f=(window as any).fixture; f.replaceRows([f.item('top','Ordinary head'),{...f.item('claim','Delivery unknown'),unconfirmedTargetTurnId:'turn'}]); });
    await page.waitForTimeout(30);
    await press();
    assert.deepEqual(await actions(page), []);
    for (const patch of [{ supported: false }, { submissionDisabled: true }, { disabled: true }]) {
      await reset();
      await configure(page, patch);
      await press();
      assert.deepEqual(await actions(page), [], JSON.stringify(patch));
    }
    await reset();
    await page.evaluate(() => (window as any).fixture.replaceRows([]));
    await page.waitForFunction(() => !document.querySelector(".opencraft-composer-queue-item"));
    await press();
    assert.deepEqual(await actions(page), []);

    // An empty queue edit is not an empty ordinary draft; preserve edit mode.
    await reset();
    await page.locator(".opencraft-composer-queue-item").first().getByRole("button", { name: "Edit queued message", exact: true }).click();
    await page.getByRole("button", { name: "Cancel editing queued message", exact: true }).waitFor();
    await editor.fill("");
    await press();
    assert.deepEqual(await actions(page), []);
    await page.keyboard.insertText("Save this queue edit");
    await press();
    assert.deepEqual(await actions(page), [{ type: "edit", id: "top", text: "Save this queue edit" }]);

    // Opaque image handles remain editable without exposing an adapter prefix;
    // resubmission retains the native image ID rather than treating the locator as a URL.
    await reset();
    await page.evaluate(() => (window as any).fixture.nativeImage());
    await page.locator(".opencraft-composer-queue-item").getByRole("button", { name: "Edit queued message", exact: true }).click();
    await page.getByRole("button", { name: "Cancel editing queued message", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixture.controller.getSnapshot().draft.attachments[0].name), "uploaded-image-1");
    const imageAttachment = page.getByRole("group", { name: "uploaded-image-1", exact: true });
    await imageAttachment.waitFor();
    assert.equal(await imageAttachment.getAttribute("title"), "uploaded-image-1");
    assert.equal(await imageAttachment.getByRole("button", { name: "Open attached image", exact: true }).isDisabled(), true);
    await imageAttachment.getByRole("button", { name: "Remove uploaded-image-1", exact: true }).waitFor();
    if (process.env.OPENCRAFT_SMOKE_OUTPUT) {
      await mkdir(process.env.OPENCRAFT_SMOKE_OUTPUT, { recursive: true });
      await page.screenshot({ path: `${process.env.OPENCRAFT_SMOKE_OUTPUT}/queued-image-${mac ? "mac" : "linux"}.png` });
    }
    await press();
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.editedInput()), [{ type: "image", fileId: "uploaded-image-1" }]);

    // One physical press cannot drain a queue via autorepeat. Held callbacks
    // also block a second press before the external projection catches up.
    await reset();
    await configure(page, { hold: true });
    await press();
    await press();
    assert.equal((await actions(page)).length, 1);
    await page.evaluate(() => (window as any).fixture.release());
    await page.waitForTimeout(40);
    await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", repeat: true, metaKey: mac, ctrlKey: !mac });
    assert.equal((await actions(page)).length, 1);
    await configure(page, { hold: false });
    await press();
    assert.deepEqual((await actions(page))[1], { type: "queue-steer", id: "next" });

    // IME confirmation and non-editor focus never steer a queue.
    await reset();
    await editor.dispatchEvent("compositionstart");
    await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, metaKey: mac, ctrlKey: !mac });
    assert.deepEqual(await actions(page), []);
    await editor.dispatchEvent("compositionend");
    await page.locator(".opencraft-composer-queue-item__drag").first().focus();
    await page.keyboard.press(shortcut);
    assert.deepEqual(await actions(page), []);

    // Idle uses the same queue action as the row's Send button.
    await reset();
    await configure(page, { streaming: false, supported: false });
    await press();
    assert.deepEqual(await actions(page), [{ type: "queue-steer", id: "top" }]);
    await reset();
    await configure(page, { hold: true });
    await press();
    await page.evaluate(() => (window as any).fixture.switchThread());
    await page.waitForTimeout(40);
    await editor.fill("New conversation draft");
    await page.evaluate(() => (window as any).fixture.release());
    await page.waitForTimeout(40);
    assert.equal(await editor.textContent(), "New conversation draft");
    assert.equal(await page.locator(".opencraft-composer-queue-item__preview").first().textContent(), "New thread queue");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Real Composer keyboard smoke passed on Mac Cmd+Enter / Linux Ctrl+Enter: Enter enqueue → head steer, text/attachment priority, processing assets, live policy/order, edit, blocked head/claim/capability/Host, in-flight lock, repeat, IME, focus, idle Send and late completion after thread switch. Submit/queue RPC boundaries synthetic; no real messages sent.");
} finally {
  await browser?.close();
  await vite.close();
}
