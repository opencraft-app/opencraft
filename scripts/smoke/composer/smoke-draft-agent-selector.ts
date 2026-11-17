import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import("playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-draft-agents";
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "draft-agents", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/home-composer-focus.tsx"></script>');
    });
  } }] });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
try {
  for (const touch of [false, true]) for (const theme of ["light", "dark", "lavender"]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(12000);
    page.on("response", response => { if(response.status() >= 400) console.error("HTTP", response.status(), response.url()); });
    page.on("requestfailed", request => console.error("REQUESTFAILED", request.url(), request.failure()));
    page.on("pageerror", error => { errors.push(error.message); console.error("PAGEERROR", error.message); });
    page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
    await page.goto(`${vite.resolvedUrls!.local[0]}?toolbar&agents&theme=${theme}${touch ? "" : "&desktop"}`);
    const editor = page.locator(".opencraft-composer-editor"), send = page.locator(".opencraft-composer-submit");
    await editor.waitFor().catch(async error => { console.error((await page.locator("body").innerText()).slice(0,1000)); throw error; });
    const header = page.locator(".opencraft-composer-chrome-header");
    assert.equal(await header.getByRole("button").count(), 3);
    assert.equal(await page.locator(".draft-setup-notice").count(), 0);
    assert(await send.isDisabled(), "empty input cannot send");
    await editor.fill("保留草稿和选区");
    assert(await send.isEnabled(), "text plus a ready model enables Send");
    await editor.evaluate(element => { (window as any).keptEditor = element; });
    const click = async (locator: ReturnType<typeof page.locator>) => { if (touch) await locator.tap(); else await locator.click(); };
    const chooseAgent = async (name: string) => {
      await click(header.getByRole("button", { name: "Agent", exact: true }));
      await page.getByRole("menu").waitFor().catch(async error => { await page.screenshot({ path: `${output}/failure.png` }); console.error("BODY", await page.locator("body").innerText()); throw error; });
      await click(page.getByRole("menuitem", { name, exact: true }));
    };
    await click(page.locator(".opencraft-composer-mode--intelligence"));
    const menu = page.locator(".opencraft-composer-model-browser-surface");
    assert.equal(await menu.getByRole("tab").count(), 0, "no second Agent selector in model menu");
    await menu.getByRole("menuitem", { name: "Codex Two", exact: true }).waitFor();
    assert.equal(await menu.getByRole("menuitem", { name: "Cursor One", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await chooseAgent("Pi");
    await page.waitForFunction(() => (window as any).fixture.controller.getSnapshot().draft.selections.model === "pi-cli:one");
    assert.equal(await editor.innerText(), "保留草稿和选区");
    await page.waitForFunction(() => document.activeElement?.matches(".opencraft-composer-editor"));
    assert(await send.isEnabled());
    assert.equal(await page.locator(".opencraft-composer-mode--intelligence").innerText(), "Claude Fable 5.2");
    await page.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
    await page.evaluate(() => (window as any).fixture.setAgentState("selection-error"));
    await chooseAgent("Cursor");
    await page.getByRole("status").filter({ hasText: "切换 Agent 失败" }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).fixture.controller.getSnapshot().draft.selections.model), "pi-cli:one");
    assert.equal(await editor.innerText(), "保留草稿和选区");
    await page.evaluate(() => { (window as any).fixture.setAgentState("ready"); (window as any).fixture.setModelDelay(true); });
    await chooseAgent("Codex");
    assert(await send.isDisabled(), "selection in progress cannot send using the previous Agent");
    await chooseAgent("Cursor");
    await page.evaluate(() => (window as any).fixture.releaseChoice());
    assert(await send.isDisabled(), "late earlier choice cannot unlock the newer transaction");
    await page.evaluate(() => (window as any).fixture.releaseChoice());
    await page.waitForFunction(() => (window as any).fixture.controller.getSnapshot().draft.selections.model === "cursor:one");
    assert(await send.isEnabled());
    await page.evaluate(() => (window as any).fixture.setRecovering(true));
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".opencraft-composer-submit")?.disabled);
    await page.getByRole("status").filter({ hasText: "等待执行端" }).waitFor();
    await page.evaluate(() => (window as any).fixture.setRecovering(false));
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".opencraft-composer-submit")?.disabled);
    await page.evaluate(() => (window as any).fixture.setAgentState("empty"));
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".opencraft-composer-submit")?.disabled);
    assert.equal(await editor.innerText(), "保留草稿和选区");
    await page.evaluate(() => (window as any).fixture.setAgentState("ready"));
    await header.getByRole("button", { name: "Agent", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Pi", exact: true }).focus();
    await page.keyboard.press("Enter");
    // Resolve the keyboard choice without submitting a model request.
    await page.evaluate(() => (window as any).fixture.releaseChoice());
    await page.waitForFunction(() => (window as any).fixture.controller.getSnapshot().draft.selections.model === "pi-cli:one");
    await editor.focus();
    await editor.evaluate(element => {
      const range = document.createRange(); range.setStart(element.firstChild!.firstChild!, 2); range.setEnd(element.firstChild!.firstChild!, 4);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    const selection = await page.evaluate(() => window.getSelection()?.toString());
    await page.evaluate(() => (window as any).fixture.setLocale("en-US"));
    await page.waitForFunction(() => document.documentElement.lang === "en-US");
    assert.equal(await editor.innerText(), "保留草稿和选区");
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selection);
    assert(await editor.evaluate(element => element === document.activeElement));
    await page.setViewportSize({ width: 320, height: 700 });
    const bounds = await header.evaluate(element => {
      const r = element.getBoundingClientRect();
      return [...element.querySelectorAll("button")].map(button => { const b = button.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 1; });
    });
    assert.deepEqual(bounds, [true, true, true], "all three selectors fit a narrow container");
    assert(await editor.evaluate(element => element === (window as any).keptEditor), "same mounted editor survives selection and resizing");
    assert.deepEqual(errors, []);
    console.log("PASS", touch ? "touch" : "desktop", theme);
    await context.close();
  }
} finally { await browser.close(); await vite.close(); }
