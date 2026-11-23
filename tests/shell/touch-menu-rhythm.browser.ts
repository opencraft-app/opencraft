// Context menu, toolbar select and choice select rhythm across touch and mouse
// presentation, themes and widths. Synthetic Playwright input, not physical devices.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = process.env.OPENCRAFT_TOUCH_MENU_OUTPUT ?? ".local/touch-menu-rhythm";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  publicDir: process.cwd() + "/apps/workbench-web/public",
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-touch-menu-rhythm",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "touch-menu-rhythm-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-menu-rhythm.tsx"></script>',
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
  for (const [width, touch] of [
    [320, true],
    [390, true],
    [1200, true],
    [390, false],
    [1200, false],
  ] as const)
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width, height: 850 },
        hasTouch: touch,
        isMobile: touch && width < 500,
      });
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
      await page.waitForFunction(
        (expected) => document.documentElement.dataset.uiDensity === (expected ? "touch" : "compact"),
        touch,
      );
      const act = async (locator: any) => (touch ? locator.tap() : locator.click());
      const open = page.getByRole("button", { name: "Conversation actions", exact: true });
      await act(open);
      const menu = page.locator(".workbench-context-menu");
      await menu.waitFor();
      await menu.evaluate(settled);
      const metrics = await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const items = [...element.querySelectorAll('[role="menuitem"]')];
        return {
          radius: parseFloat(style.borderRadius),
          gap: parseFloat(style.rowGap),
          padding: parseFloat(style.paddingTop),
          inside: rect.left >= 0 && rect.right <= innerWidth,
          heights: items.map((item) => item.getBoundingClientRect().height),
          font: parseFloat(getComputedStyle(items[0]!).fontSize),
          icon: items[0]!.querySelector("svg")!.getBoundingClientRect().width,
          scrollable: element.scrollHeight > element.clientHeight,
        };
      });
      assert.equal(metrics.radius, touch ? 16 : 12);
      assert.equal(metrics.font, touch ? 15 : 13);
      assert.equal(metrics.gap, touch ? 0 : 2);
      assert.ok(metrics.inside);
      assert.ok(metrics.heights.every((height) => height >= (touch ? 44 : 28)));
      assert.equal(metrics.icon, touch ? 18 : 14);
      if (touch) {
        const last = menu.getByRole("menuitem").last();
        assert.ok(
          await last.evaluate((element) => {
            const container = element.closest(".workbench-context-menu")!;
            return element.getBoundingClientRect().bottom <= container.getBoundingClientRect().bottom;
          }),
          "available tall viewport should expose the final action",
        );
      }
      await page.screenshot({ path: `${output}/${width}-${touch ? "touch" : "mouse"}-${theme}.png` });
      const archive = page.getByRole("menuitem", { name: "Archive", exact: true });
      await archive.scrollIntoViewIfNeeded();
      await act(archive);
      await menu.waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(() => (window as any).invoked), "Archive");

      const service = page.getByRole("button", { name: "Choose service", exact: true });
      await act(service);
      const option = page.getByRole("menuitemradio", { name: "GitHub", exact: true });
      assert.equal(await option.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)), touch ? 15 : 13);
      await act(option);
      assert.match(await service.innerText(), /GitHub/);
      await page.locator(".ui-choice-select__menu").waitFor({ state: "hidden" });

      if (!touch) {
        await open.focus();
        await page.keyboard.press("Enter");
        await menu.waitFor();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Conversation actions");
      }

      // Nested toolbar glyphs and choice semantics follow the menu, not the trigger.
      const hostTrigger = page.getByRole("button", { name: "Choose environment", exact: true });
      await act(hostTrigger);
      const hostMenu = page.locator(".app-shell-toolbar-menu");
      await hostMenu.waitFor();
      await hostMenu.evaluate(settled);
      const local = page.getByRole("menuitemradio", { name: "Current server", exact: true });
      const remote = page.getByRole("menuitemradio", { name: "Dedicated cloud environment", exact: true });
      assert.equal(await local.getAttribute("aria-checked"), "true");
      assert.equal(
        await page.getByRole("menuitemradio", { name: "Unavailable", exact: true }).getAttribute("aria-disabled"),
        "true",
      );
      const glyphs = await local
        .locator("svg")
        .evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).width)));
      assert.deepEqual(glyphs, [touch ? 18 : 14, touch ? 18 : 14]);
      // Move focus away so persistent checked styling is not confused with highlight.
      await remote.focus();
      assert.notEqual(await local.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
      await page.screenshot({ path: `${output}/${width}-${touch ? "touch" : "mouse"}-${theme}-toolbar.png` });
      await act(remote);
      await hostMenu.waitFor({ state: "hidden" });
      assert.match(await hostTrigger.innerText(), /Dedicated cloud environment/);
      await act(hostTrigger);
      assert.equal(
        await page
          .getByRole("menuitemradio", { name: "Dedicated cloud environment", exact: true })
          .getAttribute("aria-checked"),
        "true",
      );
      await page.keyboard.press("Escape");
      await hostMenu.waitFor({ state: "hidden" });

      // Short viewports still clip within available space; native touch pan reaches the last action.
      if (touch && width < 500) {
        await page.setViewportSize({ width, height: 300 });
        await act(open);
        await menu.waitFor();
        await menu.evaluate(settled);
        const box = (await menu.boundingBox())!;
        assert.ok(box.y >= 0 && box.y + box.height <= 300);
        assert.ok(await menu.evaluate((element) => element.scrollHeight > element.clientHeight));
        const cdp = await context.newCDPSession(page);
        const x = box.x + box.width / 2;
        const start = box.y + box.height - 20;
        const end = box.y + 20;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start }] });
        for (let step = 1; step <= 8; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y: start + ((end - start) * step) / 8 }],
          });
          await page.waitForTimeout(20);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForFunction(() => document.querySelector(".workbench-context-menu")!.scrollTop > 0);
        await page.screenshot({ path: `${output}/${width}-${theme}-short.png` });
        await page.keyboard.press("End");
        await page.waitForFunction(() => {
          const container = document.querySelector(".workbench-context-menu");
          const last = container?.querySelector('[role="menuitem"]:last-child');
          return last && last.getBoundingClientRect().bottom <= container!.getBoundingClientRect().bottom + 1;
        });
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        await page.setViewportSize({ width, height: 850 });
        await cdp.detach();
      }

      // Input preference changes preserve the mounted draft and are not viewport breakpoints.
      const input = page.getByRole("textbox", { name: "Draft" });
      const handle = await input.elementHandle();
      await page.evaluate((current) => (window as any).fixture.setTouch(current ? "off" : "on"), touch);
      await page.waitForFunction(
        (current) => document.documentElement.dataset.uiDensity === (current ? "compact" : "touch"),
        touch,
      );
      assert.ok(await handle!.evaluate((element) => element.isConnected));
      assert.equal(await input.inputValue(), "Unsaved content");
      assert.deepEqual(errors, []);
      results.push({ width, touch, theme, ...metrics, selection: true, keyboard: !touch, draftRetained: true });
      await context.close();
    }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(`PASS touch menu rhythm: ${results.length} scenes`);
} finally {
  await browser?.close();
  await vite.close();
}
