import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = "/tmp/opencraft-history-request-continuity";
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] }, cacheDir: "node_modules/.vite-history-request-continuity",
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "history-continuity-fixture", configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url !== "/") return next();
    res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/history-request-continuity.tsx"></script>');
  }); } }],
});
let browser: any;
try {
  await server.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1100, height: 844 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.message); });
    await page.goto(server.resolvedUrls!.local[0]!);
    const editor = page.locator(".opencraft-composer-editor"); await editor.waitFor();
    await editor.fill("Preserve my draft and selection");
    await page.evaluate(() => {
      (window as any).originalEditor = document.querySelector(".opencraft-composer-editor");
      const text = document.createTreeWalker((window as any).originalEditor, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
    });
    const bounds = await editor.boundingBox();
    await page.evaluate(() => (window as any).continuity.fail());
    await page.getByText("Could not confirm the continuation. Check the conversation before retrying.", { exact: true }).waitFor();
    assert.deepEqual(await editor.boundingBox(), bounds);
    assert.equal(await page.locator(".thread-composer-region [role=alert]").count(), 0);
    assert.equal(await page.getByText(/AppServer request thread\/resume/).count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement === (window as any).originalEditor), true);
    assert.equal(await page.evaluate(() => getSelection()!.toString()), "Preserve");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => (window as any).continuity.theme(theme), theme);
      await page.waitForFunction(() => {
        const toast = document.querySelector('[data-sonner-toast][data-mounted="true"]');
        return toast && getComputedStyle(toast).opacity === "1";
      });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
    }
    await page.evaluate(() => (window as any).continuity.locale("zh-CN"));
    assert.equal(await page.evaluate(() => document.querySelector(".opencraft-composer-editor") === (window as any).originalEditor), true);
    assert.equal(await editor.innerText(), "Preserve my draft and selection");
    await page.evaluate(() => { (window as any).continuity.clear(); });
    await page.waitForTimeout(20); await page.evaluate(() => (window as any).continuity.fail());
    await page.getByText("无法确认回复是否已继续，请查看会话后重试。", { exact: true }).waitFor();
    await page.evaluate(() => (window as any).continuity.setMode("tasks"));
    try { await page.locator(".tasks-card").first().waitFor({ timeout: 10000 }); }
    catch (error) { console.error(await page.locator("body").innerText()); await page.screenshot({ path: `${output}/tasks-failure.png` }); throw error; }
    await page.waitForFunction(() => (window as any).continuity.counters().active === 4);
    await page.clock.install();
    await page.clock.fastForward(20_000);
    for (let i = 0; i < 5; i++) { await page.evaluate(() => (window as any).continuity.hint()); await page.clock.runFor(200); }
    const during = await page.evaluate(() => (window as any).continuity.counters());
    assert.equal(during.calls, 4); assert.equal(during.peak, 4);
    await page.screenshot({ path: `${output}/tasks-held-${touch ? "touch" : "desktop"}.png` });
    await page.evaluate(() => (window as any).continuity.setMode("closed"));
    await page.waitForFunction(() => (window as any).continuity.counters().active === 0);
    const after = await page.evaluate(() => (window as any).continuity.counters());
    assert.equal(after.aborted, 4); assert.equal(after.calls, 4);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, output, cases: ["real floating Composer/notifications", "desktop/touch light/dark", "draft/focus/selection and editor identity", "live locale change", "real Tasks View with held reads across polls/notifications", "unmount cancels reads"], realHostWrites: false }));
} finally { await browser?.close(); await server.close(); }
