import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdir } from "node:fs/promises";
import type { Browser, Page } from "playwright";

// Only the owner-supplied submit/queue command boundary is synthetic. This mounts
// the real controller, ProseMirror keymap, queue tray and complete Composer.
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: ["tests/fixtures/queue-steer-shortcut.jsx"] },
  cacheDir: "node_modules/.vite-queue-steer-shortcut",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "queue-steer-shortcut-probe",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/queue-steer-shortcut.jsx"></script>');
      });
    },
  }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright") as typeof import("playwright");
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
    page.on("pageerror", error => { errors.push(error.message); console.error("[queue-smoke]", error.message); });
    page.on("console", message => { if (message.type() === "error") console.error("[browser-console]", message.text()); });
    page.on("response", response => { if(response.status() >= 400) console.error("[browser-response]", response.status(), response.url()); });
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
    assert.deepEqual(await actions(page), [{ type: "queue-steer", id: "top" }]);
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
  // Real Composer, localized status, no modal or toast; only the command
  // boundary is synthetic. Exercise touch and keyboard with the draft intact.
  for (const touch of [false, true]) for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: touch ? {width:390,height:844} : {width:1100,height:800}, hasTouch:touch, isMobile:touch });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("[queue-smoke]", error.message); });
    await page.goto(origin + '?locale=zh-CN&mode=' + mode);
    const editor = page.locator('.opencraft-composer-editor');
    await editor.fill('保留我的草稿');
    await configure(page, {hold:true, retryFail:true});
    await page.evaluate(() => { const f=(window as any).fixture; f.replaceRows([{...f.item('claim','继续检查压缩问题'),actionable:false,reorderable:false,state:'unknown',unconfirmedTargetTurnId:'original-turn'}]); (window as any).retryEditor=document.querySelector('.opencraft-composer-editor'); });
    const retry = page.getByRole('button', {name:'重试',exact:true});
    await retry.waitFor();
    await page.getByText('未确认送达', {exact:true}).waitFor();
    const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? '.local/queue-delivery-retry';
    await mkdir(output, {recursive:true});
    const bounds = await retry.boundingBox();
    assert.ok(bounds && bounds.width >= (touch ? 44 : 22) && bounds.height >= (touch ? 44 : 22));
    assert.equal(await page.evaluate(() => document.documentElement.dataset.uiDensity), touch ? 'touch' : 'compact');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.screenshot({path:output+'/'+(touch?'touch':'desktop')+'-'+mode+'.png'});
    if(touch)await retry.tap(); else {await retry.focus();await page.keyboard.press('Enter');}
    await page.getByText('正在重试…', {exact:true}).waitFor();
    assert.equal(await retry.isDisabled(), true);
    assert.equal((await actions(page)).length,1);
    assert.equal(await page.getByRole('alertdialog').count(),0);
    await page.evaluate(() => (window as any).fixture.release());
    await page.getByText('重试失败', {exact:true}).waitFor();
    assert.equal(await retry.isEnabled(),true);
    await configure(page, {hold:false,retryFail:false});
    if(touch)await retry.tap();else {await retry.focus();await page.keyboard.press('Enter');}
    await page.waitForFunction(()=>!document.querySelector('.opencraft-composer-queue-item'));
    assert.deepEqual(await actions(page),[{type:'retry',id:'claim',turnId:'original-turn'},{type:'retry',id:'claim',turnId:'original-turn'}]);
    assert.equal(await editor.textContent(),'保留我的草稿');
    assert.equal(await page.evaluate(()=>(window as any).retryEditor===document.querySelector('.opencraft-composer-editor')),true);
    // Same row ID can acquire a new original-Turn identity after reconciliation.
    // A late rejected attempt must not decorate or lock that successor claim.
    await configure(page, {hold:true,retryFail:true});
    await page.evaluate(() => { const f=(window as any).fixture; f.replaceRows([{...f.item('claim','新的投递身份'),actionable:false,reorderable:false,state:'unknown',unconfirmedTargetTurnId:'old-turn'}]); });
    if(touch)await retry.tap();else {await retry.focus();await page.keyboard.press('Enter');}
    await page.getByText('正在重试…', {exact:true}).waitFor();
    await page.evaluate(() => { const f=(window as any).fixture; f.replaceRows([{...f.item('claim','新的投递身份'),actionable:false,reorderable:false,state:'unknown',unconfirmedTargetTurnId:'new-turn'}]); });
    await page.getByText('未确认送达', {exact:true}).waitFor();
    await page.evaluate(() => (window as any).fixture.release());
    await page.waitForTimeout(50);
    assert.equal(await page.getByText('重试失败', {exact:true}).count(), 0);
    assert.equal(await retry.isEnabled(), true);
    await configure(page, {hold:false,retryFail:false});
    if(touch)await retry.tap();else {await retry.focus();await page.keyboard.press('Enter');}
    await page.waitForFunction(()=>!document.querySelector('.opencraft-composer-queue-item'));
    assert.deepEqual((await actions(page)).slice(-2), [{type:'retry',id:'claim',turnId:'old-turn'},{type:'retry',id:'claim',turnId:'new-turn'}]);
    assert.equal(await editor.textContent(),'保留我的草稿');
    assert.equal(await page.evaluate(()=>(window as any).retryEditor===document.querySelector('.opencraft-composer-editor')),true);
    assert.equal(await page.getByRole('alertdialog').count(),0);
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log("Real Composer keyboard smoke passed on Mac Cmd+Enter / Linux Ctrl+Enter: Enter enqueue → head steer, text/attachment priority, processing assets, live policy/order, edit, blocked head/claim/capability/Host, in-flight lock, repeat, IME, focus, idle Send and late completion after thread switch. Submit/queue RPC boundaries synthetic; no real messages sent.");
} finally {
  await browser?.close();
  await vite.close();
}
