import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-content-window";
await mkdir(output, { recursive: true });
const vite = await createServer({ root: process.cwd(), configFile: false, logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-content-window",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "content-window", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-content-window.tsx"></script>');
    });
  } }] });
await vite.listen();
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results: unknown[] = [];
try {
  for (const touch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: touch ? 430 : 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultNavigationTimeout(120_000); await page.goto(vite.resolvedUrls!.local[0]!, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll('[data-conversation-content-key]').length >= 1000);
    await page.waitForTimeout(1000);
    const metrics = () => page.evaluate(() => ({ placeholders: document.querySelectorAll('[data-conversation-content-key]').length,
      mounted: document.querySelectorAll('[data-content-mounted]').length, activities: document.querySelectorAll('.thread-activity-item').length, nodes: document.querySelectorAll('*').length }));
    const initial = await metrics();
    assert(initial.mounted < 200, JSON.stringify(initial));
    assert(initial.activities < 200, JSON.stringify(initial));
    const first = page.locator('[data-conversation-content-key]').first();
    await first.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.getByText("Thought 0", { exact: true }).waitFor();
    await page.waitForTimeout(500);
    const thought = page.getByText("Thought 0", { exact: true });
    const row = thought.locator('xpath=ancestor::*[@data-conversation-row="activity"][1]');
    await row.getByRole("button").first().click();
    await page.getByText("Reasoning detail 0", { exact: true }).waitFor();
    const draft = page.getByRole("textbox", { name: "Draft" });
    await draft.fill("Preserved while streaming");
    await draft.focus();
    await page.evaluate(() => (window as any).append());
    await page.waitForTimeout(500);
    assert.equal(await draft.inputValue(), "Preserved while streaming");
    assert(await draft.evaluate(element => element === document.activeElement));
    const last = page.locator('[data-conversation-content-key]').last();
    await last.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(500);
    assert((await last.innerText()).length > 0, "new tail must be rendered");
    assert.equal(await page.getByText("Reasoning detail 0", { exact: true }).count(), 1);
    await first.evaluate(element => element.scrollIntoView({ block: "center" }));
    await page.getByText("Reasoning detail 0", { exact: true }).waitFor();
    const anchorBefore = await first.evaluate(element => element.getBoundingClientRect().top);
    await page.evaluate(() => (window as any).restore());
    await page.getByText("Reasoning detail 0", { exact: true }).waitFor();
    await page.waitForTimeout(500);
    const anchorAfter = await first.evaluate(element => element.getBoundingClientRect().top);
    assert(Math.abs(anchorAfter - anchorBefore) <= 2, `Reading anchor moved: ${anchorBefore} -> ${anchorAfter}`);
    const after = await metrics();
    assert(after.mounted < 220, JSON.stringify(after));
    await page.evaluate(() => (window as any).grouped());
    const group = page.locator(".thread-agent-activity__group-disclosure").first();
    await group.scrollIntoViewIfNeeded();
    await group.locator(".thread-activity-item__hit-target").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".thread-activity-window-row").length >= 500);
    await page.waitForTimeout(500);
    const grouped = await metrics();
    assert(grouped.mounted < 220, JSON.stringify(grouped));
    const oldestCommand = page.locator(".thread-activity-window-row").first();
    await oldestCommand.evaluate(element => element.scrollIntoView({ block: "center" }));
    await oldestCommand.locator(".thread-activity-item").waitFor();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${output}/content-window-${touch}.png` });
    results.push({ touch, initial, after, grouped, errors });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }));
} finally { await browser.close(); await vite.close(); }
