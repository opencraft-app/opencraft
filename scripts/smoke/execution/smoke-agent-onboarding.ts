import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_ONBOARDING_OUTPUT ?? "/tmp/opencraft-agent-onboarding";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-agent-onboarding", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "onboarding-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/agent-onboarding.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("Onboarding browser error:", error.message); });
  const waitCall = (key: string, count = 1) => page.waitForFunction(({ key, count }) => (window as any).onboardingFixture?.calls.filter((call: string) => call === key).length >= count, { key, count });
  const resolve = (key: string, models: { id: string; name: string }[]) => page.evaluate(({ key, models }) => (window as any).onboardingFixture.resolve(key, { models }), { key, models });
  const codex = [{ id: "codex:one", name: "Codex One" }, { id: "codex:two", name: "Codex Two" },
    ...Array.from({ length: 24 }, (_, i) => ({ id: `codex:extra-${i}`, name: `Extra model ${i}` }))];
  const cursor = [{ id: "cursor:one", name: "Cursor One" }];
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await page.goto(base); await waitCall("host-a:codex");
  assert.equal(await next.isDisabled(), true);
  await resolve("host-a:codex", codex);
  await page.getByRole("button", { name: "Codex One", exact: true }).waitFor();
  assert.equal(await next.isEnabled(), true, "a ready agent exposes its models without a hidden row click");
  assert.equal(await page.getByRole("button", { name: "Codex One", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Codex Two", exact: true }).click();
  await next.click(); assert.match(await page.locator(".agent-onboard__selection").innerText(), /Codex Two/);
  // Closing the currently selected Agent must not silently choose another ready Agent.
  await page.evaluate(() => (window as any).onboardingFixture.setDisabledAgents(["codex"]));
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start chatting", exact: true }).count(), 0);
  assert.equal(await page.locator('li[data-agent="cursor"]').getByRole("button", { name: "Cursor One", exact: true }).count(), 0);
  await page.evaluate(() => (window as any).onboardingFixture.setDisabledAgents([]));
  await page.getByRole("button", { name: "Start chatting", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  const chooseCursor = page.locator('li[data-agent="cursor"]').getByRole("button", { name: "Choose models" });
  await chooseCursor.focus(); await page.keyboard.press("Enter"); await waitCall("host-a:cursor");
  assert.equal(await next.isDisabled(), true, "switching agents cannot keep the previous model");
  await page.locator('li[data-agent="codex"]').getByRole("button", { name: "Choose models" }).click();
  await resolve("host-a:cursor", cursor);
  assert.equal(await page.getByRole("button", { name: "Codex Two", exact: true }).getAttribute("aria-pressed"), "true", "a late result cannot overwrite a newer choice");
  await chooseCursor.click(); await page.getByRole("button", { name: "Cursor One", exact: true }).waitFor();
  await next.click(); await page.getByRole("button", { name: "Start chatting" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).onboardingFixture.finished), ["cursor:one"]);

  // Failure, empty response and retry must all leave a working recovery action.
  await page.goto(base); await waitCall("host-a:codex");
  await page.evaluate(() => (window as any).onboardingFixture.fail("host-a:codex"));
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await waitCall("host-a:codex", 2);
  await resolve("host-a:codex", []);
  await page.getByRole("button", { name: "Use the default model" }).click();
  await next.click(); await page.getByRole("button", { name: "Start chatting" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).onboardingFixture.finished), ["codex:current"]);

  // Changing hosts retires both the old model selection and any pending result.
  await page.goto(base); await waitCall("host-a:codex");
  await page.evaluate(() => (window as any).onboardingFixture.setHostId("host-b")); await waitCall("host-b:codex");
  await resolve("host-a:codex", codex);
  assert.equal(await next.isDisabled(), true);
  await resolve("host-b:codex", [{ id: "codex:host-b", name: "Host B model" }]);
  await page.getByRole("button", { name: "Host B model" }).waitFor();
  await page.evaluate(() => (window as any).onboardingFixture.refresh(false));
  await page.getByRole("button", { name: "Sign in", exact: true }).first().waitFor();
  assert.equal(await next.isDisabled(), true, "signed-out agents cannot finish with a stale choice");
  assert.deepEqual(errors, []);
  await page.close();

  // Check the rendered composition with genuine touch input, themes and a short viewport.
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1100, height: 850 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.on("pageerror", (error: Error) => console.error("Onboarding locale browser error:", error.message)); p.setDefaultTimeout(15_000); await p.goto(`${base}/?locale=zh-CN`);
    try { await p.waitForFunction(() => (window as any).onboardingFixture?.calls.includes("host-a:codex")); } catch (error) { console.error("Onboarding state", await p.locator("body").innerText()); throw error; }
    await p.evaluate(models => (window as any).onboardingFixture.resolve("host-a:codex", { models }), codex);
    await p.getByRole("button", { name: "Codex Two", exact: true }).waitFor();
    for (const theme of ["light", "dark", "lavender"]) {
      await p.evaluate(theme => {
        const f = (window as any).onboardingFixture;
        f.setThemePreference(theme === "dark" ? "dark" : "light");
        if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender");
      }, theme);
      const choice = p.getByRole("button", { name: "Codex Two", exact: true });
      if (touch) await choice.tap(); else { await choice.focus(); await p.keyboard.press("Space"); }
      assert.equal(await choice.getAttribute("aria-pressed"), "true");
      const next = p.getByRole("button", { name: "继续", exact: true });
      await next.scrollIntoViewIfNeeded();
      assert.equal(await p.locator(".agent-onboard__models ul").evaluate(el => el.scrollHeight > el.clientHeight), true, "long model lists scroll within the page");
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
      if (touch) await next.tap(); else await next.click();
      assert.match(await p.locator(".agent-onboard__selection").innerText(), /Codex Two/);
      await p.getByRole("button", { name: "返回", exact: true }).click();
    }
    await context.close();
  }
  // During asynchronous Start, every exit button stays disabled until ownership settles.
  const finishingPage = await browser.newPage();
  await finishingPage.goto(base);
  await finishingPage.waitForFunction(() => (window as any).onboardingFixture?.calls.includes("host-a:codex"));
  await finishingPage.evaluate(() => {
    const fixture = (window as any).onboardingFixture;
    fixture.resolve("host-a:codex", { models: [{ id: "codex:one", name: "Codex One" }] });
    fixture.setPresentation("sheet"); fixture.holdFinish();
  });
  await finishingPage.getByRole("button", { name: "Continue", exact: true }).click();
  await finishingPage.getByRole("button", { name: "Start chatting", exact: true }).click();
  assert.equal(await finishingPage.getByRole("button", { name: "Back to model settings", exact: true }).isDisabled(), true);
  assert.equal(await finishingPage.getByRole("button", { name: "Back", exact: true }).isDisabled(), true);
  assert.equal(await finishingPage.getByRole("button", { name: "Start chatting", exact: true }).isDisabled(), true);
  await finishingPage.evaluate(() => (window as any).onboardingFixture.releaseFinish());
  await finishingPage.waitForFunction(() => (window as any).onboardingFixture.finished.includes("codex:one"));
  await finishingPage.close();
  // Actual import UI, with only the agent boundary simulated.
  const historyPage = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  historyPage.on("pageerror", (error: Error) => errors.push(error.message));
  await historyPage.goto(`${base}/?history=1`);
  await historyPage.waitForFunction(() => (window as any).onboardingFixture?.calls.includes("host-a:codex"));
  await historyPage.evaluate(() => (window as any).onboardingFixture.resolve("host-a:codex", { models: [{ id: "codex:one", name: "Codex One" }] }));
  await historyPage.getByRole("button", { name: "Continue", exact: true }).click();
  const choice = historyPage.getByRole("checkbox", { name: /Continue my local project/ });
  await choice.waitFor(); assert.equal(await historyPage.getByRole("button", { name: "Import selected (0)", exact: true }).isDisabled(), true);
  await choice.focus(); await historyPage.keyboard.press("Space"); assert.equal(await choice.getAttribute("aria-checked"), "true");
  await historyPage.screenshot({ path: `${output}/history-selected.png` });
  await historyPage.getByRole("button", { name: "Import selected (1)", exact: true }).click();
  assert.equal(await historyPage.getByRole("button", { name: "Start chatting", exact: true }).isDisabled(), true);
  await historyPage.evaluate(() => (window as any).onboardingFixture.fail("host-a:import"));
  await historyPage.getByRole("alert").waitFor(); assert.equal(await choice.getAttribute("aria-checked"), "true");
  await historyPage.getByRole("button", { name: "Import selected (1)", exact: true }).click();
  await historyPage.evaluate(() => (window as any).onboardingFixture.resolve("host-a:import", { imported: [{ id: "11111111-2222-3333-4444-555555555555", threadId: "codex_fixture" }], failed: [] }));
  await historyPage.getByRole("status").filter({ hasText: "1 conversations imported" }).waitFor(); assert.equal(await choice.isDisabled(), true);
  await historyPage.screenshot({ path: `${output}/history-imported.png` });
  await historyPage.getByRole("button", { name: "Back", exact: true }).click(); await historyPage.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal(await choice.isDisabled(), true, "back/forward inside onboarding preserves imported state");
  await historyPage.setViewportSize({ width: 390, height: 844 });
  await historyPage.screenshot({ path: `${output}/history-narrow.png` });
  await historyPage.close(); assert.deepEqual(errors, []);
  console.log(`PASS onboarding: automatic discovery, explicit keyboard/touch choices, correct model handoff, late results, host switch, sign-out, failure/retry/empty fallback; screenshots: ${output}. Agent boundary simulated.`);
} finally { await browser?.close(); await vite.close(); }
