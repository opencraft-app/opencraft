import assert from "node:assert/strict";
import { createServer } from "vite";

// Isolated, real Composer and current app.scss; no account, Host or inference.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React from 'react';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {CodexComposer} from '@opencraft/codex-composer';
import {createComposerController} from '@opencraft/composer-core';
import {createConversationKey} from '@opencraft/chat-core';
import {Button} from '/apps/workbench-web/src/components/ui/button.tsx';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
import {buildCodexThemeCssProperties,codexThemePalette,lavenderThemePalette} from '@opencraft/design-system/theme-engine';
import '/apps/workbench-web/src/styles/app.scss';
bindTouchInteractionMode(document);
window.focusFixture={theme:(mode,family)=>{
 document.documentElement.dataset.theme=mode;
 const base=family==='custom'?lavenderThemePalette[mode]:codexThemePalette[mode];
 for(const [key,value] of Object.entries(buildCodexThemeCssProperties(mode,base)))document.documentElement.style.setProperty(key,value);
}};
const controller=createComposerController({type:'existing-thread',key:createConversationKey('fixture','focus')},{now:Date.now,createId:()=>crypto.randomUUID()});
createIntlTestRoot(document.getElementById('root')).render(<main style={{padding:32,background:'var(--color-background-surface)',color:'var(--color-text)'}}>
 <button id="before">Before editor</button>
 <CodexComposer controller={controller} onSubmit={()=>false} selectionCatalog={{models:[],permissionProfiles:[]}}/>
 <Button id="owned">Owned button</Button><button id="fallback">Unstyled button</button>
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
  const editor = page.locator(".codex-composer-editor");
  await editor.waitFor();
  const appearance = (selector: string) => page.locator(selector).evaluate((el: HTMLElement) => {
    const css = getComputedStyle(el);
    return { outline: css.outlineStyle, width: css.outlineWidth, color: css.outlineColor,
      shadow: css.boxShadow, focused: document.activeElement === el, visible: el.matches(":focus-visible") };
  });
  for (const family of ["codex", "custom"]) for (const mode of ["light", "dark"]) {
    await page.evaluate(({ mode, family }: any) => (window as any).focusFixture.theme(mode, family), { mode, family });
    await editor.click();
    assert.equal((await appearance(".codex-composer-editor")).outline, "none", "mouse-clicked Composer must own no outline");
    await page.keyboard.insertText("input");
    assert.ok((await editor.textContent())?.includes("input"), "outline policy cannot break editing");
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    const keyboard = await appearance(".codex-composer-editor");
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
    assert.equal((await appearance(".codex-composer-editor")).outline, "none");
    await page.locator("#fallback").tap();
    assert.equal((await appearance("#fallback")).outline, "none", "touch gate remains authoritative");
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    await page.locator("#fallback").focus();
    assert.equal((await appearance("#fallback")).outline, "solid", "hardware Tab restores keyboard presentation");
    console.log(`PASS ${family}/${mode}: actual Composer click/Tab/touch has no outline; neutral button and fallback focus; input preserved`);
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
