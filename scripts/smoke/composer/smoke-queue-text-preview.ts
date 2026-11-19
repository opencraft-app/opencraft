import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/queue-text-preview";
await mkdir(output, { recursive: true });
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-queue-preview",
  optimizeDeps: { include: ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"] },
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "queue-preview",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/?")) return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/composer-attached-rail.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
const reports = [];
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const width of [320, 390, 1280])
    for (const mode of ["light", "dark"]) {
      const touch = width < 1000;
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") console.error(m.text());
      });
      page.on("requestfailed", (r) => console.error(r.url(), r.failure()));
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error(e.message);
      });
      await page.addInitScript((touch) => {
        (window as any).__name = (v: unknown) => v;
        document.addEventListener(
          "DOMContentLoaded",
          () => (document.documentElement.dataset.uiDensity = touch ? "touch" : "compact"),
        );
      }, touch);
      await page.goto(vite.resolvedUrls!.local[0] + "?locale=zh-CN&navigation&mode=" + mode);
      const row = page.locator(".opencraft-composer-queue-item").first(),
        trigger = row.locator(".opencraft-composer-queue-item__preview-trigger"),
        editor = page.locator(".opencraft-composer-editor");
      await trigger.waitFor();
      await editor.fill("保留当前输入草稿");
      const original = await editor.elementHandle();
      const text =
        "**完整消息预览** 与 [文档](https://example.com) 和 `a_b`。\n\n| 名称 | 状态 |\n| --- | --- |\n| 服务 | 正常 |\n\n" +
        Array.from(
          { length: 35 },
          (_, i) => `第${i + 1}行：保留完整消息、换行和很长的路径 /packages/composer-editor/src/queue-tray.tsx`,
        ).join("\n");
      await page.evaluate((text) => (window as any).setRailMessage(text), text);
      await page.waitForTimeout(100);
      assert(
        await row.locator(".opencraft-composer-queue-item__preview").evaluate((n) => n.scrollWidth > n.clientWidth),
        "row is genuinely truncated",
      );
      const activate = () => (touch ? trigger.tap() : trigger.click());
      await activate();
      const preview = page.locator(".opencraft-composer-queue-message-text");
      await preview.waitFor();
      await preview.locator("strong").waitFor();
      assert.equal(await preview.locator("strong").textContent(), "完整消息预览");
      assert(await preview.locator("table").first().isVisible());
      assert.equal(await preview.locator("a").first().getAttribute("href"), "https://example.com");
      assert.equal(await preview.locator("code").first().textContent(), "a_b");
      assert((await preview.textContent())?.includes("第35行"));
      assert.doesNotMatch(await row.locator(".opencraft-composer-queue-item__preview").innerText(), /\*\*|\]\(|\| ---/);
      assert.equal(await page.evaluate(() => (window as any).steerCount ?? 0), 0);
      assert(
        await preview.evaluate((n) => {
          const r = n.getBoundingClientRect();
          return (
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            n.scrollHeight > n.clientHeight
          );
        }),
        "full text uses a bounded scrollport",
      );
      await page.screenshot({ path: output + "/" + width + "-" + mode + "-markdown.png" });
      if (touch) {
        const cdp = await context.newCDPSession(page),
          r = await preview.boundingBox();
        assert(r);
        const x = r.x + r.width / 2,
          y = r.y + r.height - 30;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
        for (const delta of [30, 60, 90])
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - delta, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(80);
        assert(await preview.evaluate((n) => n.scrollTop > 0), "native touch scroll reads long text");
      }
      await preview.evaluate((n) => (n.scrollTop = n.scrollHeight));
      assert(await preview.evaluate((n) => n.scrollTop > 0));
      assert(await preview.isVisible(), "scrolling full text does not dismiss it");
      await page.screenshot({ path: output + "/" + width + "-" + mode + ".png" });
      await activate();
      await preview.waitFor({ state: "hidden" });
      await activate();
      await preview.waitFor();
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
      await trigger.focus();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Enter");
      await preview.waitFor();
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
      if (touch) {
        const cdp = await context.newCDPSession(page),
          box = await trigger.boundingBox();
        assert(box);
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 65, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        assert.equal(await preview.count(), 0, "vertical drag does not activate preview");
      } else {
        await page.mouse.move(width - 10, 500);
        await trigger.hover();
        await preview.waitFor();
        await page.keyboard.press("Escape");
      }
      await activate();
      await preview.waitFor();
      await editor.click();
      await preview.waitFor({ state: "hidden" });
      assert.equal(await editor.innerText(), "保留当前输入草稿");
      assert(await editor.evaluate((n, old) => n === old, original));
      await row.locator("button.is-steer").click();
      assert.equal(await page.evaluate(() => (window as any).steerCount), 1, "steer remains independent");
      assert.deepEqual(errors, []);
      reports.push({
        width,
        mode,
        tapAndClick: true,
        fullText: true,
        boundedScroll: true,
        repeatDismiss: true,
        escape: true,
        keyboard: true,
        draftAndActionsPreserved: true,
      });
      await context.close();
    }
  await writeFile(output + "/report.json", JSON.stringify(reports, null, 2));
  console.log(JSON.stringify({ ok: true, reports }));
} finally {
  await browser?.close();
  await vite.close();
}
