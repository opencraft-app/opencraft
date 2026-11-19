import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "fixture",
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/?")) return next();
          res.setHeader("content-type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>');
        });
      },
    },
  ],
});
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
await mkdir(".local/floating-overflow", { recursive: true });

// Real Composer and production styles; presentation states are controlled here
// to test geometry separately from the Shell focus/retained-view lifecycle.
try {
  for (const touch of [false, true])
    for (const mode of ["light", "dark"]) {
      const context = await browser.newContext({
        viewport: { width: touch ? 390 : 1000, height: 700 },
        hasTouch: touch,
      });
      const page = await context.newPage();
      await page.goto(server.resolvedUrls!.local[0] + "?addMenu&pickerFocus&composerBounds&mode=" + mode);
      await page.waitForFunction(() => typeof (window as any).setTouch === "function");
      await page.evaluate(async (value) => {
        await (window as any).setTouch(value);
      }, touch);
      await page.locator(".opencraft-composer-shell").waitFor();
      await page.evaluate(() => {
        const stack = document.querySelector(".opencraft-composer-stack")!;
        const wrap = document.createElement("div");
        wrap.className = "thread-composer-overlay__content";
        wrap.dataset.density = "compact";
        wrap.style.cssText = "position:fixed;left:48px;bottom:32px;width:224px";
        stack.parentNode!.insertBefore(wrap, stack);
        wrap.append(stack);
      });
      const add = page.locator(".opencraft-composer-footer__attachment > button").first();
      const bounds = async () => {
        const shell = await page.locator(".opencraft-composer-shell").boundingBox(),
          button = await add.boundingBox();
        assert.ok(shell && button);
        assert.ok(
          button.x >= shell.x && button.x + button.width <= shell.x + shell.width,
          JSON.stringify({ shell, button }),
        );
        assert.ok(button.y >= shell.y && button.y + button.height <= shell.y + shell.height);
      };
      await bounds();
      if (touch) await add.tap();
      else {
        await add.focus();
        await page.keyboard.press("Enter");
      }
      await page.locator(".opencraft-composer-add-menu").waitFor();
      await bounds();
      await page.screenshot({ path: ".local/floating-overflow/" + mode + "-" + touch + ".png" });
      await page.keyboard.press("Escape");
      await page.locator(".opencraft-composer-add-menu").waitFor({ state: "hidden" });
      await page.evaluate(() => {
        const w = document.querySelector<HTMLElement>(".thread-composer-overlay__content")!;
        w.dataset.density = "expanded";
        w.style.width = "min(600px,calc(100vw - 96px))";
      });
      assert.equal(
        await page.locator(".opencraft-composer-footer").evaluate((e) => getComputedStyle(e).containerType),
        "inline-size",
      );
      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".thread-composer-overlay__content")!.dataset.density = "compact";
      });
      await bounds();
      await context.close();
      console.log("PASS", touch ? "touch" : "keyboard", mode, "compact bounds, open menu, expand and collapse");
    }
} finally {
  await browser.close();
  await server.close();
}
