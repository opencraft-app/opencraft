import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
const output = await mkdtemp(join(tmpdir(), "conversation-history-refresh-"));
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl", "@tanstack/react-query"] },
  optimizeDeps: { include: ["react", "react-dom/client", "react/jsx-runtime", "react-intl", "sonner"] }, esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-conversation-refresh", server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "conversation-refresh-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-history-refresh.tsx"></script>');
    });
  } }],
});
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
try {
  await vite.listen();
  const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on("pageerror", (e: Error) => { errors.push(e.message); console.error("FIXTURE_PAGE_ERROR", e.message); });
    let navigations = 0; page.on("framenavigated", () => { navigations++; });
    await page.clock.install(); await page.goto(`${url}?theme=${theme}`);
    await page.locator(".thread-header-heading__subtitle").getByText("外部会话 · 示例", { exact: true }).waitFor();
    await page.locator("[data-presentation-before]").waitFor();
    await page.locator("[data-presentation-after]").waitFor();
    const heading = page.locator(".thread-header-heading__main");
    const subtitle = page.locator(".thread-header-heading__subtitle");
    const [headingBox, subtitleBox] = await Promise.all([heading.boundingBox(), subtitle.boundingBox()]);
    assert.ok(headingBox && subtitleBox && subtitleBox.y >= headingBox.y + headingBox.height, "subtitle follows title");
    const draft = page.getByRole("textbox", { name: "待发送草稿" });
    await draft.waitFor(); await draft.fill("继续保留我的草稿");
    const draftNode = await draft.elementHandle();
    const scroll = page.getByLabel("聊天内容"); await scroll.evaluate(el => { el.scrollTop = 120; });
    await page.evaluate(() => (window as unknown as { externalConversationFixture: { append(): void } }).externalConversationFixture.append());
    await page.clock.runFor(5100);
    await page.getByText("新的回复", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "继续保留我的草稿");
    assert.equal(await draft.evaluate((node: Element, original: Element) => node === original, draftNode), true);
    assert.equal(await scroll.evaluate(el => el.scrollTop), 120, "reading old messages is not forced to the bottom");
    assert.equal(navigations, 1, "no page reload");
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    const titleInput = page.getByRole("textbox", { name: "会话名称" });
    await titleInput.fill("保留标题编辑"); await titleInput.press("Enter");
    await heading.getByText("保留标题编辑", { exact: true }).waitFor();
    assert.equal(await subtitle.textContent(), "外部会话 · 示例");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no viewport overflow");
    await page.evaluate(() => (window as any).externalConversationFixture.park(false));
    await page.clock.runFor(1);
    const parkedReads = await page.evaluate(() => (window as any).externalConversationFixture.reads);
    await page.clock.runFor(20000);
    assert.equal(await page.evaluate(() => (window as any).externalConversationFixture.reads), parkedReads, "parked parent stops polling without unmounting the draft");
    await page.evaluate(() => (window as any).externalConversationFixture.park(true));
    await page.clock.runFor(5100);
    assert.ok(await page.evaluate(() => (window as any).externalConversationFixture.reads) > parkedReads);
    assert.equal(await draft.evaluate((node: Element, original: Element) => node === original, draftNode), true);
    await page.screenshot({ path: join(output, `${width}-${theme}-active.png`) });
    await page.getByRole("button", { name: "离开外部会话" }).click();
    await subtitle.waitFor({ state: "detached" });
    const reads = await page.evaluate(() => (window as unknown as { externalConversationFixture: { reads: number } }).externalConversationFixture.reads);
    await page.clock.runFor(20000);
    assert.equal(await page.evaluate(() => (window as unknown as { externalConversationFixture: { reads: number } }).externalConversationFixture.reads), reads);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `${width}-${theme}.png`) }); await page.close();
  }
  console.log(`PASS real Shell/Header/refresh hook (synthetic lease): external messages, retained draft DOM and scroll, no reload, stop on leave. Synthetic metadata only. Evidence: ${output}`);
} finally { await browser.close(); await vite.close(); }
