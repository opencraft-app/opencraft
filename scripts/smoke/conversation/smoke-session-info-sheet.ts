import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";

const output = process.env.OPENCRAFT_INFO_REPORT ?? ".local/session-info-sheet";
const source = `
import React,{useState} from 'react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createIntlTestRoot} from '/tests/fixtures/intl-root.tsx';
import {ConversationTaskMenu} from '/apps/workbench-web/src/components/conversation-task-menu.tsx';
import {initializeAppearanceTheme,setThemePreference,setAppearanceThemeId} from '/apps/workbench-web/src/appearance-theme.ts';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
import '/apps/workbench-web/src/styles/app.scss';
initializeAppearanceTheme();bindTouchInteractionMode(document);
function Demo(){const [metadata,setMetadata]=useState({project:'data',workspaceDirectory:'/data'});
window.fixture={setMetadata,setThemePreference,setAppearanceThemeId};
return <main><p>Conversation fixture</p><textarea aria-label='Draft' defaultValue='Keep this conversation draft'/>
<ConversationTaskMenu scope='fixture' serverId='fixture' threadId='fixture' {...metadata} verifyConversation={async()=>{throw new Error('read-only info must not execute')}} onOpenTasks={()=>{throw new Error('must not open tasks')}}/></main>}
createIntlTestRoot(document.getElementById('root'),undefined,new URLSearchParams(location.search).get('locale')??'en-US').render(<QueryClientProvider client={new QueryClient()}><Demo/></QueryClientProvider>);`;
const vite = await createServer({ root: process.cwd(), configFile: false, appType: "custom", logLevel: "error",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "session-info-fixture",
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("Content-Type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>');
    }); }, resolveId(id) { if (id === "/probe.tsx") return id; }, load(id) { if (id === "/probe.tsx") return source; },
  }] });
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const executablePath = process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
assertBrowserRuntimeDependencies(executablePath);
await mkdir(output, { recursive: true });
const results: unknown[] = [], errors: string[] = [];
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const width of [320, 390, 430, 640, 641, 768, 820, 1024, 1180, 1440]) {
    for (const theme of ["light", "dark", "lavender"]) {
      const touch = width < 1200;
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: touch, reducedMotion: "reduce" });
      await context.addInitScript(() => { (window as any).__name = (target: unknown) => target; });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => !!(window as any).fixture);
      await page.evaluate(theme => {
        (window as any).fixture.setThemePreference(theme === "lavender" ? "light" : theme);
        if (theme === "lavender") (window as any).fixture.setAppearanceThemeId("opencraft.core.lavender");
      }, theme);
      const trigger = page.getByRole("button", { name: "Conversation actions", exact: true });
      const open = async () => { await trigger.click(); await page.getByRole("menuitem", { name: "Conversation info", exact: true }).click(); };
      await open();
      const dialog = page.getByRole("dialog"), close = dialog.getByRole("button", { name: "Close", exact: true });
      await dialog.waitFor();
      const measure = () => dialog.evaluate(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom,
          rows: el.querySelectorAll("dt").length, background: style.backgroundColor, color: style.color,
          blur: getComputedStyle(document.querySelector(".modal-surface__scrim")!).backdropFilter,
          overflow: el.scrollWidth > el.clientWidth, animation: style.animationName };
      });
      const metrics = await measure();
      assert.equal(metrics.rows, 2);
      assert.equal(metrics.overflow, false);
      assert.equal(metrics.blur, "none");
      assert.equal(metrics.animation, "none");
      assert.ok(metrics.height < 260, JSON.stringify(metrics));
      assert.equal(await dialog.locator(".settings-panel__footer").count(), 0);
      if (width <= 640) {
        assert.equal(metrics.x, 0); assert.equal(metrics.width, width); assert.equal(metrics.bottom, 900);
      } else {
        assert.ok(metrics.width <= 420); assert.ok(Math.abs(metrics.x + metrics.width / 2 - width / 2) < 1);
        assert.ok(Math.abs(metrics.y + metrics.height / 2 - 450) < 1);
        assert.equal(await dialog.locator(".modal-surface__sheet-handle").isVisible(), false);
      }
      if (touch) for (const button of [close, dialog.getByRole("button", { name: "Copy working directory" })]) {
        const bounds = await button.boundingBox(); assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44, JSON.stringify(bounds));
      }
      assert.equal(await dialog.locator("dd").nth(1).locator(".information-panel__value").textContent(), "/data");
      // The insecure-origin fallback copies inside Radix's focus boundary.
      await page.evaluate(() => { (window as any).copied = null; document.execCommand = command => {
        if (command !== "copy") return false;
        (window as any).copied = (document.activeElement as HTMLTextAreaElement)?.value; return true;
      }; });
      await dialog.getByRole("button", { name: "Copy working directory" }).click();
      await dialog.getByRole("status").filter({ hasText: "Copied" }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).copied), "/data");
      assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)));
      if ([390, 820, 1180].includes(width)) await page.screenshot({ path: `${output}/${width}-${theme}.png` });
      await page.keyboard.press("Tab"); assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)));
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.activeElement?.classList.contains("chrome-button"));
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "Keep this conversation draft");
      await open(); await close.click(); await dialog.waitFor({ state: "detached" });
      await open(); await page.mouse.click(4, 4); await dialog.waitFor({ state: "detached" });
      results.push({ width, theme, touch, ...metrics });
      console.log(JSON.stringify({ width, theme, ok: true }));
      await context.close();
    }
  }
  // Long values, denied clipboard, live rotation/split resize, handle cancellation and dismissal.
  const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
  await context.addInitScript(() => { (window as any).__name = (target: unknown) => target; });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => !!(window as any).fixture);
  const path = "/data/很长的工作目录/" + "long-unbroken-path-".repeat(18);
  await page.evaluate(path => (window as any).fixture.setMetadata({ project: "Long-project-".repeat(16), workspaceDirectory: path }), path);
  const open = async () => { await page.getByRole("button", { name: "Conversation actions" }).click(); await page.getByRole("menuitem", { name: "Conversation info" }).click(); };
  await open(); const dialog = page.getByRole("dialog");
  await dialog.evaluate(el => { (window as any).originalDialog = el; });
  await page.setViewportSize({ width: 820, height: 1180 });
  assert.equal(await dialog.evaluate(el => el === (window as any).originalDialog), true);
  assert.ok((await dialog.boundingBox())!.width <= 420);
  await page.setViewportSize({ width: 320, height: 310 });
  await page.waitForTimeout(220);
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  assert.ok((await dialog.boundingBox())!.y >= 0);
  assert.equal(await dialog.locator("dd").nth(1).locator(".information-panel__value").textContent(), path);
  await dialog.getByRole("button", { name: "Copy working directory" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => { document.execCommand = () => false; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
  await dialog.getByRole("button", { name: "Copy working directory" }).click();
  await dialog.getByRole("status").filter({ hasText: "Could not copy" }).waitFor();
  await page.setViewportSize({ width: 390, height: 800 });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => (window as any).fixture.setMetadata({ project: "data", workspaceDirectory: "/data" }));
  await open(); await page.waitForTimeout(220);
  const handle = dialog.locator(".modal-surface__sheet-handle"), rect = (await handle.boundingBox())!;
  await page.mouse.move(195, rect.y + 12); await page.mouse.down(); await page.mouse.move(195, rect.y + 32);
  assert.ok((await dialog.boundingBox())!.y > 600);
  await page.mouse.up(); await page.waitForTimeout(220); assert.equal(await dialog.count(), 1);
  await page.mouse.move(195, rect.y + 12); await page.mouse.down();
  await handle.dispatchEvent("pointercancel", { pointerId: 1 }); await page.mouse.up();
  assert.equal(await dialog.getAttribute("data-dragging"), null);
  await page.mouse.move(195, rect.y + 12); await page.mouse.down(); await page.mouse.move(195, rect.y + 112); await page.mouse.up();
  await dialog.waitFor({ state: "detached" });
  for (const metadata of [{ project: "data" }, { workspaceDirectory: "/data" }]) {
    await page.evaluate(metadata => (window as any).fixture.setMetadata(metadata), metadata); await open();
    assert.equal(await dialog.locator("dt").count(), 1); await page.keyboard.press("Escape");
  }
  await page.evaluate(() => (window as any).fixture.setMetadata({}));
  await page.getByRole("button", { name: "Conversation actions" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Conversation info" }).count(), 0);
  await context.close();
  for (const [locale, width] of [["zh-CN", 390], ["zh-CN", 820], ["zh-CN", 1180], ["ms-MY", 390], ["th-TH", 390]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${url}/?locale=${locale}`); await page.locator(".chrome-button").click();
    await page.getByRole("menuitem").last().click();
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("dialog").locator("dt").count(), 2);
    assert.equal(await page.getByRole("dialog").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    if (locale === "zh-CN") await page.screenshot({ path: `${output}/${width}-zh-CN.png` });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ ok: true, results, errors, longPath: true, clipboardDenied: true, resizeSameDOM: true, swipeCancelAndDismiss: true, optionalMetadata: true, locales: 4 }, null, 2));
  console.log(JSON.stringify({ ok: true, scenarios: results.length, output }));
} finally { await browser?.close(); await vite.close(); }
