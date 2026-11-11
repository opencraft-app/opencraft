import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_MODEL_BROWSER_OUTPUT ?? "/tmp/opencraft-model-browser";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-model-browser", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "model-browser-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="width:min(700px,calc(100vw - 32px));margin:560px auto 20px"></div><script type="module" src="/tests/fixtures/composer-model-browser.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.setDefaultTimeout(20_000); const errors: string[] = []; p.on("pageerror", (error: Error) => errors.push(error.message));
    await p.goto(base); const editor = p.locator(".opencraft-composer-editor"); await editor.fill("Keep this model selection draft");
    await editor.evaluate(el => (window as any).originalModelBrowserEditor = el);
    const trigger = p.locator(".opencraft-composer-mode--intelligence");
    if (touch) await trigger.tap(); else { await trigger.focus(); await p.keyboard.press("Enter"); }
    const menu = p.locator(".opencraft-composer-model-browser-surface"); await menu.waitFor();
    if (!touch) assert.equal(await menu.getByRole("searchbox").evaluate(el => el === document.activeElement), true, "keyboard entry starts at model search");
    assert.equal(await p.getByRole("tab", { name: "Codex", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await menu.getByRole("menuitem", { name: "Model One", exact: true }).count(), 1, "six concrete variants appear as one model");
    assert.equal(await menu.getByRole("button", { name: "High", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.remembered.length), 0, "opening writes no defaults");
    const low = menu.getByRole("button", { name: "Low", exact: true }); if (touch) await low.tap(); else await low.click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[low]");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().effort), undefined, "variant selection adds no unsupported effort override");
    if (touch) assert.equal(await editor.evaluate(el => el === document.activeElement), true, "touch choices retain editor focus");
    const modelTwo = menu.getByRole("menuitem", { name: "Model Two", exact: true }); if (touch) await modelTwo.tap(); else await modelTwo.click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:two[low]");
    const search = menu.getByRole("searchbox", { name: "Search models" }); await search.fill("not-a-model");
    await menu.getByText("No models match your search.", { exact: true }).waitFor();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:two[low]");
    await search.fill("Model One"); await search.press("ArrowDown"); await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[low]");
    await search.fill("");
    await p.getByRole("tab", { name: "Cursor", exact: true }).click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[low]", "browsing another Agent cannot select it");
    await menu.getByRole("menuitem", { name: "Model One", exact: true }).click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "cursor:one");
    assert.equal(await menu.getByRole("group", { name: "Reasoning", exact: true }).count(), 0, "unsupported controls stay absent");
    const cursorThinking = menu.getByRole("menuitem", { name: "Cursor Thinking", exact: true });
    if (touch) await cursorThinking.tap(); else await cursorThinking.click();
    const cursorLow = menu.getByRole("button", { name: "Low", exact: true });
    if (touch) await cursorLow.tap(); else await cursorLow.click();
    const cursorFast = menu.getByRole("switch", { name: "Fast mode", exact: true });
    if (touch) await cursorFast.tap(); else { await cursorFast.focus(); await p.keyboard.press("Space"); }
    assert.deepEqual(await p.evaluate(() => { const s = (window as any).modelBrowserFixture.selections(); return { model: s.model, effort: s.effort, serviceTier: s.serviceTier }; }), { model: "cursor:thinking", effort: "low", serviceTier: "fast" });
    if (touch) await cursorFast.tap(); else await p.keyboard.press("Space");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().serviceTier), null, "Cursor Fast off is an explicit clear");
    await p.getByRole("tab", { name: "API models", exact: true }).click();
    await menu.getByRole("menuitem", { name: "Thinking model", exact: true }).click();
    await menu.getByRole("button", { name: "High", exact: true }).click();
    const fastSwitch = menu.getByRole("switch", { name: "Fast mode", exact: true });
    if (touch) await fastSwitch.tap(); else { await fastSwitch.focus(); await p.keyboard.press("Space"); }
    const reset = menu.getByRole("button", { name: "Reset reasoning to model default" });
    if (touch) await reset.tap(); else await reset.click();
    assert.deepEqual(await p.evaluate(() => { const s = (window as any).modelBrowserFixture.selections(); return { model: s.model, effort: s.effort, serviceTier: s.serviceTier }; }), { model: "api:thinking", effort: "medium", serviceTier: "fast" });
    await menu.getByRole("button", { name: "High", exact: true }).click();
    assert.deepEqual(await p.evaluate(() => { const s = (window as any).modelBrowserFixture.selections(); return { model: s.model, effort: s.effort, serviceTier: s.serviceTier }; }), { model: "api:thinking", effort: "high", serviceTier: "fast" });
    await p.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), "Keep this model selection draft");
    assert.equal(await editor.evaluate(el => el === (window as any).originalModelBrowserEditor), true);
    await p.locator('[data-composer-primary-action="send"]').click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.sent[0].model), "api:thinking");

    // Closing the selected Agent blocks both button and keyboard submission without losing the draft.
    await p.evaluate(() => (window as any).modelBrowserFixture.setDisabledAgents(["api"]));
    await p.waitForFunction(() => (document.querySelector('[data-composer-primary-action="send"]') as HTMLButtonElement)?.disabled === true);
    const sentBefore = await p.evaluate(() => (window as any).modelBrowserFixture.sent.length);
    await editor.focus(); await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.sent.length), sentBefore);
    assert.equal((await editor.innerText()).trimEnd(), "Keep this model selection draft");
    await editor.fill("Keep this model selection draft");
    await trigger.click();
    assert.equal(await p.getByRole("tab", { name: "API models", exact: true }).count(), 0);
    await p.keyboard.press("Escape");
    await p.evaluate(() => (window as any).modelBrowserFixture.setDisabledAgents(["api", "cursor", "codex"]));
    if (touch) await trigger.tap(); else { await trigger.focus(); await p.keyboard.press("Enter"); }
    await menu.getByText("No enabled agents have available models. Enable an agent or check its setup in settings.", { exact: true }).waitFor();
    await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-empty.png` });
    if (!touch) {
      assert.equal(await menu.getByRole("menuitem", { name: "Manage agents…" }).evaluate(el => el === document.activeElement), true, "keyboard opening of an empty picker focuses its recovery action");
      await p.keyboard.press("Enter");
    }
    else await menu.getByRole("menuitem", { name: "Manage agents…" }).tap();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.remembered.includes("agents")), true);
    await p.keyboard.press("Escape");
    await p.evaluate(() => (window as any).modelBrowserFixture.setDisabledAgents([]));

    // Theme and size changes keep the same draft, choices and menu ownership.
    for (const theme of ["light", "dark", "lavender"]) {
      await p.evaluate(theme => { const f = (window as any).modelBrowserFixture; f.setThemePreference(theme === "dark" ? "dark" : "light"); if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender"); }, theme);
      await trigger.click(); await menu.waitFor(); await p.getByRole("tab", { name: "Codex", exact: true }).click();
      await menu.getByRole("menuitem", { name: "Model One", exact: true }).click();
      assert.equal(await p.locator(".opencraft-composer-model-browser__models").evaluate(el => el.scrollHeight > el.clientHeight), true);
      assert.equal(await menu.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
      await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
      await p.keyboard.press("Escape");
    }
    assert.deepEqual(errors, []); await context.close();
  }
  console.log(`PASS model browser: concrete variant IDs, source isolation, native effort/Fast, search/empty, keyboard/touch, editor identity/draft, light/dark/lavender and bounded lists. Screenshots: ${output}. Inference boundary simulated.`);
} finally { await browser?.close(); await vite.close(); }
