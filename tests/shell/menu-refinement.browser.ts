// The real conversation header and sidebar row menus on phone widths: touch rhythm,
// section separators, viewport containment, action dispatch and draft retention.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_MENU_REFINEMENT_OUTPUT ?? ".local/menu-refinement";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  publicDir: process.cwd() + "/apps/workbench-web/public",
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-menu-refinement",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "menu-refinement-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/menu-refinement.tsx"></script>',
          );
        });
      },
    },
  ],
});
const settled = (element: Element) => Promise.all(element.getAnimations().map((animation) => animation.finished));
let browser;
const results: unknown[] = [];
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: process.env.OPENCRAFT_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : [],
  });
  for (const theme of ["light", "dark"])
    for (const width of [320, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(60000);
      await page.addInitScript(() => {
        (window as any).__name = (value: unknown) => value;
      });
      await page.goto(vite.resolvedUrls!.local[0]!);
      await page.waitForFunction(() => (window as any).fixture);
      await page.evaluate((value) => (window as any).fixture.setTheme(value), theme);
      await page.waitForFunction(() => document.documentElement.dataset.uiDensity === "touch");
      await page.getByRole("button", { name: "Conversation actions", exact: true }).tap();
      const menu = page.locator(".workbench-context-menu");
      await menu.waitFor();
      await menu.evaluate(settled);
      const metrics = await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const items = [...element.querySelectorAll('[role="menuitem"]')];
        return {
          width: rect.width,
          height: rect.height,
          inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          sections: element.querySelectorAll('[role="separator"]').length,
          font: getComputedStyle(items[0]!).fontSize,
          weight: getComputedStyle(items[0]!).fontWeight,
          shadow: getComputedStyle(element).boxShadow,
          heights: items.map((item) => item.getBoundingClientRect().height),
        };
      });
      assert.equal(metrics.font, "15px");
      assert.equal(metrics.weight, "400");
      assert.ok(metrics.sections >= 3, JSON.stringify(metrics));
      assert.ok(metrics.inside, JSON.stringify(metrics));
      assert.ok(
        metrics.heights.every((height) => height >= 44),
        JSON.stringify(metrics),
      );
      assert.ok(!metrics.shadow.includes("80px"), metrics.shadow);
      await page.screenshot({ path: `${output}/${width}-${theme}-chat.png` });
      const pin = page.getByRole("menuitem", { name: "Pin", exact: true });
      await pin.scrollIntoViewIfNeeded();
      await pin.tap();
      await menu.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => (window as any).invoked), "pin");
      assert.equal(await page.getByRole("textbox", { name: "Draft" }).inputValue(), "Unsent draft");

      await page.evaluate(() => (window as any).fixture.setKind("sidebar"));
      await page.getByRole("button", { name: "Actions for Container distribution", exact: true }).tap();
      await menu.waitFor();
      await menu.evaluate(settled);
      assert.equal(await menu.locator('[role="separator"]').count(), 2);
      await page.screenshot({ path: `${output}/${width}-${theme}-sidebar.png` });
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
      results.push({
        width,
        theme,
        ...metrics,
        conversationMenu: true,
        sidebarMenu: true,
        actionAndDraftPreserved: true,
      });
      await context.close();
    }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS menu refinement: ${results.length} scenes`);
} finally {
  await browser?.close();
  await vite.close();
}
