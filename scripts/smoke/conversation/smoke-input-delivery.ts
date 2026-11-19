import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-input-delivery";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: ["tests/fixtures/input-delivery.tsx"] },
  cacheDir: "node_modules/.vite-input-delivery",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "input-delivery",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/input-delivery.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const evidence = [];
  for (const touch of [false, true])
    for (const mode of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: touch ? 390 : 1200, height: 844 },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript("window.__name=value=>value");
      await page.goto(
        `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?mode=${mode}${touch ? "&touch" : ""}`,
      );
      await page.getByText("已接收", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Draft" }).fill("保留这条草稿");
      const stop = page.getByRole("button", { name: "Stop turn" });
      if (touch) await stop.tap();
      else {
        await stop.focus();
        await page.keyboard.press("Enter");
      }
      await page.getByText("已接收，本轮已停止", { exact: true }).waitFor();
      assert.equal(await page.locator("main").getAttribute("data-active"), "none");
      await page.getByRole("button", { name: "Deliver late reply" }).click();
      assert.equal(await page.locator("main").getAttribute("data-active"), "none");
      assert.equal(await page.getByText("发送待确认", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "保留这条草稿");
      assert.equal(await page.getByText("继续", { exact: true }).count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({
        path: `${output}/${touch ? "touch" : "desktop"}-${mode}.png`,
      });
      assert.deepEqual(errors, []);
      evidence.push({
        touch,
        mode,
        received: true,
        stopped: true,
        lateReplyIgnored: true,
        draftPreserved: true,
        pageErrors: errors,
      });
      await context.close();
    }
  await writeFile(output + "/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  await vite.close();
}
