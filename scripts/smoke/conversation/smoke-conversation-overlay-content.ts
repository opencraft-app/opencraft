import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-overlay-content";
await mkdir(output, { recursive: true });
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error", esbuild: { jsx: "automatic" },
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover", "@tanstack/react-query"] },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-overlay-content",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "overlay-content", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-overlay-content.tsx"></script>');
    });
  } }] });
await vite.listen();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  for (const touch of [false, true]) {
    console.log("overlay content", touch ? "touch" : "pointer");
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(vite.resolvedUrls!.local[0]! + (touch ? "?touch" : ""));
    await page.locator(".opencraft-composer-editor").fill("Same thread draft");
    const first = page.locator('[data-conversation-content-key]').first();
    await first.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.getByText("Thought 0", { exact: true }).waitFor();
    await page.evaluate(() => { (window as any).originalDraft = document.querySelector('.opencraft-composer-editor'); (window as any).overlayProbe.setOverlay(true); });
    if (touch) await page.getByRole('button', { name: 'Agent', exact: true }).tap();
    const summary = page.locator('.thread-composer-overlay__summary');
    await summary.waitFor();
    if (await summary.getAttribute('aria-expanded') !== 'true') { if (touch) await summary.tap(); else await summary.click(); }
    const response = page.locator('.thread-composer-overlay__response');
    await response.waitFor();
    await response.evaluate(element => { element.scrollTop = 0; });
    // The main timeline's observer root is not an ancestor of the portalled reply.
    // Its placeholders must not replace visible process rows in this scrollport.
    await response.getByText("Thought 0", { exact: true }).waitFor({ timeout: 5000 });
    assert(await response.getByText('Ran echo activity-0', { exact: true }).count() || await response.getByText(/activity-0/).count());
    for (let step = 0; step < 150 && !await response.getByText("Visible commentary in the same thread", { exact: true }).isVisible(); step++) {
      await response.evaluate(element => { element.scrollTop += element.clientHeight / 2; });
      await page.waitForTimeout(30);
    }
    await response.getByText("Visible commentary in the same thread", { exact: true }).waitFor();
    for (let step = 0; step < 10; step++) {
      await response.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.waitForTimeout(50);
    }
    await response.getByText("Ran echo activity-99", { exact: true }).waitFor();
    await page.evaluate(() => (window as any).overlayProbe.append());
    await response.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await response.getByText("Ran echo activity-100", { exact: true }).waitFor();
    await page.waitForTimeout(250);
    const bounds = await response.boundingBox();
    assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900, "reply stays inside the viewport");
    if (touch) assert.equal(await page.locator('.thread-composer-overlay-host').getAttribute('data-mobile-panel'), 'true');
    await page.screenshot({ path: `${output}/${touch ? "touch" : "pointer"}.png` });
    await page.evaluate(() => (window as any).overlayProbe.setOverlay(false));
    const draft = page.locator(".opencraft-composer-editor");
    assert.equal(await draft.innerText(), 'Same thread draft');
    assert(await draft.evaluate(element => element === (window as any).originalDraft));
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ result: "passed", sameThread: true, longActivity: true, streaming: true, draftPreserved: true }));
} finally { await browser.close(); await vite.close(); }
