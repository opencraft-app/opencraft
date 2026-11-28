import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_USAGE_OUTPUT ?? "/tmp/opencraft-agent-usage";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-agent-usage", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "usage-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    const path = req.url?.split("?")[0]; if (path !== "/" && path !== "/feedback") return next(); res.setHeader("content-type", "text/html"); res.end(`<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/${path === "/feedback" ? "agent-feedback" : "agent-usage"}.tsx"></script>`);
  }); } }] });
let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 768 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const page = await context.newPage(), errors: string[] = []; page.setDefaultTimeout(30000); page.on("pageerror", (e: Error) => { errors.push(e.message); console.error(e.message); }); await page.goto(base);
    const editor = page.locator(".opencraft-composer-editor"); await editor.fill("preserved usage draft"); await editor.evaluate(el => (window as any).originalUsageEditor = el);

    // 1. Sidebar quota section: renamed "Agent limits", tightest quota in summary, no conversation context mixed in.
    const usage = page.locator("[data-agent-usage]"), disclosure = usage.locator('[aria-expanded]');
    await usage.getByText("Agent limits", { exact: true }).waitFor();
    await usage.locator(".agent-usage__summary").getByText("Plan 81%").waitFor();
    if (touch) await disclosure.tap(); else { await disclosure.focus(); await page.keyboard.press("Enter"); }
    await usage.getByRole("progressbar", { name: "5 hours" }).waitFor();
    assert.equal(await usage.getByRole("progressbar", { name: "Context window" }).count(), 0, "sidebar quota drawer excludes conversation context");
    // Duplicate machine names are disambiguated by sanitized endpoint details.
    await usage.getByText("9.135.102.192:10100", { exact: true }).waitFor();
    await usage.getByText("join.woa.com/mason", { exact: true }).waitFor();
    // Switching to disconnected machine hides ghost provider tabs cleanly.
    await usage.getByRole("tab", { name: /join\.woa\.com\/mason/ }).click();
    await usage.getByText("Mason Devbox is disconnected", { exact: true }).waitFor();
    assert.equal(await usage.getByRole("tab", { name: "Codex", exact: true }).count(), 0, "offline machine omits ghost provider tabs");
    await usage.getByRole("tab", { name: /9\.135\.102\.192:10100/ }).click();

    await usage.getByRole("tab", { name: "Cursor", exact: true }).click(); await usage.getByText("81%", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).usageFixture.calls.length), 1, "tab browsing sends no request or model change");
    const refresh = usage.getByRole("button", { name: "Refresh usage" });
    await page.evaluate(() => (window as any).usageFixture.defer()); await refresh.click();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')?.disabled);
    assert.equal(await usage.getByRole("progressbar").count(), 1, "refresh keeps quota rendered");
    await page.evaluate(() => (window as any).usageFixture.reject()); await usage.getByText("Could not refresh usage. Try again when connected.", { exact: true }).waitFor();
    assert.equal(await usage.getByRole("progressbar").count(), 1);
    assert.equal(await page.evaluate(() => (window as any).usageFixture.calls.at(-1).force), true);
    await refresh.click(); await usage.getByText("Could not refresh usage. Try again when connected.", { exact: true }).waitFor({ state: "hidden" });
    await usage.getByRole("tab", { name: "Cursor", exact: true }).focus(); await page.keyboard.press("ArrowLeft");
    assert.equal(await usage.getByRole("tab", { name: "Codex", exact: true }).getAttribute("aria-selected"), "true");
    await page.keyboard.press("Escape"); assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
    assert.equal(await disclosure.evaluate(el => el === document.activeElement), true);
    await disclosure.click();

    // 2. Composer context trigger + popover: shows context window & cumulative tokens, hides cleanly when unreported.
    const ctxTrigger = page.locator("[data-agent-context-trigger]");
    await ctxTrigger.waitFor();
    if (touch) await ctxTrigger.tap(); else await ctxTrigger.click();
    const ctxPopover = page.locator("[data-agent-context-popover]");
    await ctxPopover.waitFor();
    assert.equal(await ctxPopover.getByRole("progressbar", { name: "Context window" }).getAttribute("value"), "12345");
    await ctxPopover.getByText("Session cumulative tokens", { exact: true }).waitFor();
    await ctxPopover.getByText("Cache hit 85.7%", { exact: true }).waitFor();
    await ctxPopover.getByText("12.3K (90% cached)", { exact: true }).waitFor();
    await ctxPopover.getByRole("button", { name: "View all token usage in Settings" }).click();
    assert.equal(await page.evaluate(() => (window as any).usageFixture.getSettingsOpened()), 1);

    // Cursor conversation reports context only, without fabricated cumulative totals.
    await page.evaluate(() => (window as any).usageFixture.setThread("cursor_fixture"));
    await ctxTrigger.waitFor();
    if (touch) await ctxTrigger.tap(); else await ctxTrigger.click();
    await ctxPopover.getByText("Cursor reports context window only, without cumulative token breakdown.", { exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // Unknown/unreported context quietly hides the composer trigger instead of showing "Not reported".
    await page.evaluate(() => (window as any).usageFixture.setThread("unknown_fixture"));
    await ctxTrigger.waitFor({ state: "detached" });

    // Restore codex thread & open context popover for three-theme visual inspection.
    await page.evaluate(() => (window as any).usageFixture.setThread("codex_fixture"));
    await ctxTrigger.waitFor();
    if (touch) await ctxTrigger.tap(); else await ctxTrigger.click();
    await ctxPopover.waitFor();

    for (const theme of ["light", "dark", "lavender"]) {
      await page.evaluate(theme => { const f = (window as any).usageFixture; f.setThemePreference(theme === "dark" ? "dark" : "light"); if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender"); }, theme);
      assert.equal(await usage.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1; }), true);
      await page.screenshot({ path: `${output}/fixture-${touch ? "touch" : "desktop"}-${theme}.png` });
    }
    assert.equal(await editor.innerText(), "preserved usage draft"); assert.equal(await editor.evaluate(el => el === (window as any).originalUsageEditor), true);
    await page.goto(base + "/feedback" + (touch ? "?locale=zh-CN" : ""));
    await page.locator(".thread-todo button").click();
    await page.getByText("Check usage", { exact: true }).waitFor(); await page.getByText("Verify refresh", { exact: true }).waitFor();
    await page.screenshot({ path: `${output}/plan-${touch ? "touch" : "desktop"}.png` });
    await page.keyboard.press("Escape"); await page.evaluate(() => (window as any).feedbackFixture.fail());
    await page.getByRole("alert").waitFor();
    assert.ok(!(await page.getByRole("alert").innerText()).includes("acpPromptFailed"), "native failure codes are localized");
    const draft = page.getByRole("textbox", { name: "Unsent draft" }); await draft.fill("preserved while continuing"); await draft.evaluate(el => (window as any).originalFeedbackDraft = el);
    await page.screenshot({ path: `${output}/feedback-${touch ? "touch" : "desktop"}.png` });
    const resume = page.getByRole("button", { name: touch ? "继续" : "Continue", exact: true }); if (touch) await resume.tap(); else await resume.click();
    await page.getByText("CONTINUED_OK", { exact: true }).waitFor(); assert.equal(await draft.inputValue(), "preserved while continuing"); assert.equal(await draft.evaluate(el => el === (window as any).originalFeedbackDraft), true);
    assert.deepEqual(errors, []); await context.close();
  }
  console.log(`PASS usage and feedback: quotas/context split, duplicate-machine disambiguation, offline empty state, keyboard/touch, cached refresh/error, provider browsing, unknown values, editor identity/draft, three themes, native-plan presentation and localized explicit Continue. ${output}`);
} finally { await browser?.close(); await vite.close(); }
