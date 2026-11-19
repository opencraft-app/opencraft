import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/resource-refresh";
await mkdir(output, { recursive: true });
const children = new Map<string, { id: string; text: string }>();
const calls: { method: string; id?: string }[] = [];
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  optimizeDeps: { include: ["@opencraft/browser-core/metadata-limits", "@opencraft/browser-core/metadata-merge"] },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-resource-refresh",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "resource-refresh-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/resource-refresh.tsx"></script>',
            );
            return;
          }
          if (req.url === "/resource-refresh/document") {
            res.setHeader("content-type", "text/html");
            res.end("<h1>Original browser document</h1>");
            return;
          }
          if (req.url !== "/resource-refresh/rpc") return next();
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString());
          calls.push(request);
          let result: any = {};
          if (request.method === "fork") {
            assert.equal(request.options.ephemeral, false);
            assert.equal(request.local.deduplicate, false);
            result = { id: "child-" + children.size, text: "Original side answer retained across reload" };
            children.set(result.id, result);
          }
          if (request.method === "acquire") {
            await new Promise((r) => setTimeout(r, 100));
            result = children.get(request.id);
            if (!result) res.statusCode = 404;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result ?? {}));
        });
      },
    },
  ],
});
let browser;
const reports: unknown[] = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const touch of [true, false])
    for (const alias of [false, true]) {
      children.clear();
      calls.length = 0;
      const context = await browser.newContext({
        viewport: { width: touch ? 390 : 1280, height: 844 },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage(),
        errors: string[] = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
        console.error(e.message);
      });
      await page.addInitScript(
        ({ touch }) => {
          (window as any).__name = (v: unknown) => v;
          document.addEventListener(
            "DOMContentLoaded",
            () => (document.documentElement.dataset.uiDensity = touch ? "touch" : "compact"),
          );
        },
        { touch },
      );
      await page.goto(server.resolvedUrls!.local[0]);
      await page.getByTestId("new-sidechat").click();
      await page
        .getByText("Original side answer retained across reload", { exact: true })
        .waitFor()
        .catch(async (error) => {
          console.error(
            JSON.stringify({
              calls,
              body: await page.locator("body").innerText(),
              state: await page.evaluate(() => (window as any).fixture.inspect()),
            }),
          );
          await page.screenshot({ path: output + "/failure.png" });
          throw error;
        });
      await page.evaluate(() => (window as any).fixture.newBrowser());
      await page.frameLocator("iframe").getByText("Original browser document").waitFor();
      const before = await page.evaluate(() => (window as any).fixture.inspect());
      assert.equal(before.tabs.length, 2);
      assert.equal(before.sessions.length, 1);
      assert.equal(before.pages.length, 1);
      if (alias) await page.evaluate(() => history.replaceState(null, "", "?promoted=1"));
      await page.reload();
      await page.getByTestId("show-tools").click();
      await page.waitForFunction(
        () =>
          (window as any).fixture.inspect().tabs.length === 2 &&
          (window as any).fixture.inspect().sessions.length === 1,
      );
      const after = await page.evaluate(() => (window as any).fixture.inspect());
      assert.deepEqual(after.sessions, before.sessions);
      assert.deepEqual(after.pages, before.pages);
      assert.deepEqual(after.tabs.map((t: any) => t.id).sort(), before.tabs.map((t: any) => t.id).sort());
      await page.evaluate(() => (window as any).fixture.activate("sidechat"));
      await page.getByText("Original side answer retained across reload", { exact: true }).waitFor();
      await page.screenshot({
        path: `${output}/${touch ? "touch" : "pointer"}-${alias ? "alias" : "same"}-sidechat.png`,
      });
      await page.evaluate(() => (window as any).fixture.activate("browser"));
      await page.frameLocator("iframe").getByText("Original browser document").waitFor();
      await page.screenshot({
        path: `${output}/${touch ? "touch" : "pointer"}-${alias ? "alias" : "same"}-browser.png`,
      });
      await page.evaluate(() => (window as any).fixture.closeAll());
      await page.waitForFunction(() => (window as any).fixture.inspect().tabs.length === 0);
      await page.reload();
      await page.getByTestId("show-tools").click();
      await page.waitForTimeout(300);
      assert.deepEqual(await page.evaluate(() => (window as any).fixture.inspect()), {
        tabs: [],
        records: [],
        sessions: [],
        pages: [],
      });
      assert.equal(calls.filter((c) => c.method === "fork").length, 1);
      assert.equal(calls.filter((c) => c.method === "inject").length, 1);
      assert.equal(calls.filter((c) => c.method === "interrupt").length, 0);
      assert.equal(calls.filter((c) => c.method === "unsubscribe").length, 1);
      assert.deepEqual(errors, []);
      reports.push({ touch, alias, before, after });
      await context.close();
      console.log(`passed touch=${touch} alias=${alias}`);
    }
  await writeFile(output + "/report.json", JSON.stringify(reports, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
