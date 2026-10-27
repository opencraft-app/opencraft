import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium, expect } from "@playwright/test";

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-browser-todo-smoke",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "browser-todo-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><div id="overlay"></div><script type="module" src="/tests/fixtures/browser-compatible-todo.tsx"></script>');
    });
  } }] });
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const results = [];
  for (const touch of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 768, height: 1024 }, hasTouch: touch, reducedMotion: "reduce" });
    await page.addInitScript(() => {
      for (const name of ["showPopover", "hidePopover", "togglePopover"]) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: undefined });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    const trigger = page.locator(".thread-todo button");
    const popup = page.getByRole("dialog", { name: "Plan steps" });
    if (touch) await trigger.tap(); else { await trigger.focus(); await page.keyboard.press("Enter"); }
    await expect(popup).toBeVisible();
    await expect(popup.getByText("First plan step")).toBeVisible();
    assert.equal(await popup.evaluate(element => element.closest("#overlay")?.id), "overlay");
    const box = (await popup.boundingBox())!;
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 768 && box.y + box.height <= 1024);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(trigger).toBeFocused();
    if (touch) await trigger.tap(); else await page.keyboard.press("Enter");
    await expect(popup).toBeVisible();
    if (touch) await page.locator("#outside").tap(); else await page.locator("#outside").click();
    await expect(popup).toHaveCount(0);
    assert.deepEqual(errors, []);
    results.push({ touch, noNativePopover: true, keyboardAndOutsideDismiss: true, localPortal: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally { await browser?.close(); await vite.close(); }
