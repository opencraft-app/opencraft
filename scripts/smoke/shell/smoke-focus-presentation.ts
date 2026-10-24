import assert from "node:assert/strict";
import { createServer } from "vite";

// Isolated, real Composer and current app.scss; no account, Host or inference.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {createComposerController} from '@opencraft/composer-core';
import {createConversationKey} from '@opencraft/chat-core';
import {Button} from '/apps/workbench-web/src/components/ui/button.tsx';
import {SettingsButton} from '@opencraft/extension-react';
import * as Menu from '@opencraft/design-system-web/dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
import {buildOpenCraftThemeCssProperties,opencraftNeutralThemePalette,lavenderThemePalette} from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
bindTouchInteractionMode(document);
window.focusFixture={theme:(mode,family)=>{
 document.documentElement.dataset.theme=mode;
 const base=family==='custom'?lavenderThemePalette[mode]:opencraftNeutralThemePalette[mode];
 for(const [key,value] of Object.entries(buildOpenCraftThemeCssProperties(mode,base)))document.documentElement.style.setProperty(key,value);
}};
const controller=createComposerController({type:'existing-thread',key:createConversationKey('fixture','focus')},{now:Date.now,createId:()=>crypto.randomUUID()});
createIntlTestRoot(document.getElementById('root')).render(<main style={{padding:32,background:'var(--color-background-surface)',color:'var(--color-text)'}}>
 <button id="before">Before editor</button>
 <OpenCraftComposer controller={controller} onSubmit={()=>false} selectionCatalog={{models:[],permissionProfiles:[]}}/>
 <Button id="owned">Owned button</Button><button id="fallback">Unstyled button</button>
 <Menu.Root><Menu.Trigger asChild><SettingsButton id="menu-trigger">More</SettingsButton></Menu.Trigger>
 <Menu.Portal><Menu.Content><Menu.Item id="menu-one">One</Menu.Item><Menu.Item id="menu-two">Two</Menu.Item></Menu.Content></Menu.Portal></Menu.Root>
 <Dialog.Root><Dialog.Trigger asChild><Button id="dialog-trigger">Open dialog</Button></Dialog.Trigger>
 <Dialog.Portal><Dialog.Overlay/><Dialog.Content><Dialog.Title>Focus return</Dialog.Title><Dialog.Description>Isolated focus fixture</Dialog.Description><Dialog.Close asChild><Button id="dialog-close">Close</Button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>
 <input id="field" aria-label="Draft" defaultValue="saved draft"/>
 <dialog id="preview" data-opened-by-pointer="true"><button id="close">Close</button></dialog>
</main>);`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-focus-presentation", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "focus-presentation-fixture",
    resolveId: id => id === "/focus-probe.tsx" ? id : null,
    load: id => id === "/focus-probe.tsx" ? source : null,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/") return next();
        res.setHeader("content-type", "text/html");
        res.end('<html><head><title>Focus regression</title></head><body><div id="root"></div><script type="module" src="/focus-probe.tsx"></script></body></html>');
      });
    },
  }],
});
let browser: any;
const errors: string[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 900, height: 650 }, hasTouch: true });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("window.__name=value=>value");
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}`);
  const editor = page.locator(".opencraft-composer-editor");
  await editor.waitFor();
  const appearance = (selector: string) => page.locator(selector).evaluate((el: HTMLElement) => {
    const css = getComputedStyle(el);
    return { outline: css.outlineStyle, width: css.outlineWidth, color: css.outlineColor,
      shadow: css.boxShadow, focused: document.activeElement === el, visible: el.matches(":focus-visible") };
  });
  for (const family of ["neutral", "custom"]) for (const mode of ["light", "dark"]) {
    await page.evaluate(({ mode, family }: any) => (window as any).focusFixture.theme(mode, family), { mode, family });
    await editor.click();
    assert.equal((await appearance(".opencraft-composer-editor")).outline, "none", "mouse-clicked Composer must own no outline");
    await page.keyboard.insertText("input");
    assert.ok((await editor.textContent())?.includes("input"), "outline policy cannot break editing");
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    const keyboard = await appearance(".opencraft-composer-editor");
    assert.equal(keyboard.focused, true);
    assert.equal(keyboard.outline, "none", "zero-specificity fallback cannot override Composer on Tab either");
    for (const selector of ["#owned", "#fallback"]) {
      await page.locator(selector).focus();
      const focus = await appearance(selector);
      assert.equal(focus.outline, "solid");
      const rgb = focus.color.match(/[\d.]+/g)!.map(Number);
      assert.equal(rgb[0], rgb[1], "keyboard indicator must be achromatic");
      assert.equal(rgb[1], rgb[2]);
    }
    await editor.tap();
    assert.equal((await appearance(".opencraft-composer-editor")).outline, "none");
    await page.locator("#fallback").tap();
    assert.equal((await appearance("#fallback")).outline, "none", "touch gate remains authoritative");
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await page.locator("#fallback").focus();
    assert.equal((await appearance("#fallback")).outline, "solid", "hardware Tab restores keyboard presentation");
    // Current shared controls and real Radix portals, not a hand-rolled focus mock.
    for (let i = 0; i < 2; i++) {
      await page.locator("#menu-trigger").click();
      await page.locator("#menu-one").waitFor();
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.id === "menu-trigger");
      assert.equal((await appearance("#menu-trigger")).outline, "none", "mouse menu + Escape return stays quiet");
      await page.locator("#menu-trigger").click();
      await page.locator("#menu-one").waitFor();
      await page.mouse.click(8, 8);
      await page.waitForFunction(() => document.activeElement?.id === "menu-trigger");
      assert.equal((await appearance("#menu-trigger")).outline, "none", "outside pointer dismissal clears inherited ring");
    }
    await page.locator("#menu-trigger").click();
    await page.locator("#menu-one").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "menu-trigger");
    assert.equal((await appearance("#menu-trigger")).outline, "solid", "arrow navigation in a pointer-opened menu restores keyboard focus");
    await page.locator("#fallback").click();
    assert.equal((await appearance("#fallback")).outline, "none", "unstyled fallback also drops inherited pointer ring");
    await page.locator("#dialog-trigger").click();
    await page.locator("#dialog-close").waitFor();
    assert.equal((await appearance("#dialog-close")).outline, "none", "pointer dialog autofocus is quiet");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "dialog-trigger");
    assert.equal((await appearance("#dialog-trigger")).outline, "none");
    await page.locator("#field").click();
    await page.keyboard.insertText(" preserved");
    await page.keyboard.press("Space");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.pointerFocus), "true", "typing/Space does not claim navigation");
    const draft = await page.locator("#field").inputValue();
    assert.ok(draft.includes("saved draft"));
    await page.keyboard.press("Tab");
    await page.locator("#menu-trigger").focus();
    await page.keyboard.press("Enter");
    await page.locator("#menu-one").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "menu-trigger");
    assert.equal((await appearance("#menu-trigger")).outline, "solid", "keyboard menu return retains indicator");
    await page.mouse.move(8, 8);
    assert.equal((await appearance("#menu-trigger")).outline, "solid", "mouse movement does not erase keyboard focus");
    await page.locator("#dialog-trigger").focus();
    await page.keyboard.press("Enter");
    await page.locator("#dialog-close").waitFor();
    assert.equal((await appearance("#dialog-close")).outline, "solid", "keyboard-opened dialog retains focus indicator");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "dialog-trigger");
    assert.equal((await appearance("#dialog-trigger")).outline, "solid");
    await page.locator("#menu-trigger").focus();
    await page.emulateMedia({ forcedColors: "active" });
    assert.equal((await appearance("#menu-trigger")).outline, "solid");
    await page.emulateMedia({ forcedColors: "none" });
    assert.equal(await page.locator("#field").inputValue(), draft);
    console.log(`PASS ${family}/${mode}: Composer and shared/native buttons; Radix mouse Escape/outside/dialog returns quiet, keyboard/forced-colors visible, draft preserved`);
  }
  await page.evaluate(() => (document.getElementById("preview") as HTMLDialogElement).showModal());
  assert.equal((await appearance("#close")).outline, "none", "pointer-opened dialog auto-focus remains quiet");
  await page.evaluate(() => document.getElementById("preview")!.addEventListener("keydown", event => {
    if ((event as KeyboardEvent).key === "Tab") delete document.getElementById("preview")!.dataset.openedByPointer;
  }));
  await page.keyboard.press("Tab");
  await page.locator("#close").focus();
  assert.equal((await appearance("#close")).outline, "solid");
  await page.emulateMedia({ forcedColors: "active" });
  const forced = await appearance("#close");
  assert.equal(forced.outline, "solid");
  assert.equal(forced.width, "2px");
  assert.deepEqual(errors, []);
  console.log("PASS pointer-origin dialog/Tab/forced-colors; no page errors. Chromium only, not iOS or Electron acceptance.");
} finally {
  await browser?.close();
  await vite.close();
}
