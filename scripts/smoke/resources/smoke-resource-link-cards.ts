import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = ".local/resource-link-cards";
await mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "resource-link-cards", configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/resource-link-cards.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
  for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 390,
      permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(60_000);
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as any).port}/?theme=${theme}`);
    await page.locator(".chat-resource-chip").first().waitFor();
    const chips = page.locator(".chat-resource-chip");
    assert.ok(await chips.count() >= 9);
    assert.equal(await chips.filter({ hasText: "/workspace/" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "main.ts L42", exact: true }).getAttribute("href"), "file:///workspace/project/src/main.ts#L42");
    await page.getByRole("link", { name: "main.ts L42", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).openedResources), ["file:///workspace/project/src/main.ts#L42"]);
    assert.equal(await page.locator("pre").textContent().then((text: string) => text.includes("/workspace/project/src/main.ts")), true);
    assert.equal(await page.getByRole("link", { name: "example.org", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.getByRole("link", { name: "main.ts L42", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem").click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "file:///workspace/project/src/main.ts#L42");
    await page.getByRole("link", { name: "刷新预览查看", exact: true }).hover();
    const tooltip = page.locator(".chat-external-link-tooltip");
    await tooltip.waitFor({ state: "visible" });
    const paint = await tooltip.evaluate(element => {
      const background = getComputedStyle(element).backgroundColor;
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!; context.fillStyle = background; context.fillRect(0, 0, 1, 1);
      return { alpha: context.getImageData(0, 0, 1, 1).data[3], background,
        arrow: getComputedStyle(element.querySelector(".chat-external-link-tooltip__arrow")!).fill };
    });
    assert.equal(paint.alpha, 255, `Tooltip must cover underlying text in ${theme}`);
    assert.equal(paint.arrow, paint.background);
    await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
    await context.close();
  }
  console.log("PASS resource types, compact names, original navigation/copy targets, line numbers, raw URLs, code preservation and narrow/light/dark layout");
} finally { await browser?.close(); await server.close(); }
