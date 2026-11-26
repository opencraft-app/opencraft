import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const retirementOnly = process.argv.includes("--navigation-retirement");
const existingThreadsOnly = process.argv.includes("--existing-thread-models");
const output = process.env.OPENCRAFT_MODEL_BROWSER_OUTPUT ?? "/tmp/opencraft-model-browser";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  optimizeDeps: { entries: ["tests/fixtures/composer-model-browser.tsx"] },
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
  for (const touch of retirementOnly || existingThreadsOnly ? [] : [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.setDefaultTimeout(20_000); const errors: string[] = []; p.on("pageerror", (error: Error) => errors.push(error.message));
    await p.goto(base, { waitUntil: "domcontentloaded", timeout: 60_000 }); const editor = p.locator(".opencraft-composer-editor"); await editor.fill("Keep this model selection draft");
    await editor.evaluate(el => (window as any).originalModelBrowserEditor = el);
    const trigger = p.locator(".opencraft-composer-mode--intelligence");
    if (touch) await trigger.tap(); else { await trigger.focus(); await p.keyboard.press("Enter"); }
    const menu = p.locator(".opencraft-composer-model-browser-surface"); await menu.waitFor();
    if (!touch) assert.equal(await menu.getByRole("searchbox").evaluate(el => el === document.activeElement), true, "keyboard entry starts at model search");
    const codexTab = p.getByRole("tab", { name: "Agent: Codex", exact: true });
    assert.equal(await codexTab.getAttribute("aria-selected"), "true");
    assert.equal(await codexTab.getAttribute("title"), "Codex", "hover exposes the Agent name");
    assert.equal((await codexTab.innerText()).trim(), "", "Agent tabs expose only the icon");
    assert.equal(await p.locator(".opencraft-composer-model-browser__source-name").innerText(), "Codex", "the selected Agent name stays visible for touch");
    assert.equal(await menu.getByRole("slider").count(), 0, "a new thread opens on agents and models");
    assert.equal(await menu.getByText("Choosing a model from another Agent starts a new conversation with this thread's context.", { exact: true }).count(), 0, "a new draft does not claim a handoff");
    if (touch) {
      const box = await codexTab.boundingBox();
      assert.ok(box !== null && box.width >= 44 && box.height >= 44, "touch tabs use the project hit-area floor");
    }
    if (!touch) {
      const repeatPrevented = await p.evaluate(() => {
        const event = new KeyboardEvent("keydown", { key: "π", code: "KeyP", altKey: true, repeat: true, bubbles: true, cancelable: true, composed: true });
        (document.activeElement ?? document.body).dispatchEvent(event);
        return event.defaultPrevented;
      });
      assert.equal(repeatPrevented, true, "a held Option chord is consumed instead of typing into search");
      assert.equal(await codexTab.getAttribute("aria-selected"), "true", "repeat does not queue another cycle");
      await codexTab.focus(); await p.keyboard.press("ArrowRight");
      assert.equal(await p.getByRole("tab", { name: "Agent: Cursor", exact: true }).getAttribute("aria-selected"), "true");
      assert.equal(await p.locator(".opencraft-composer-model-browser__source-name").innerText(), "Cursor", "the visible name follows keyboard browsing");
      assert.equal(await p.getByRole("tab", { name: "Agent: Cursor", exact: true }).evaluate(el => el === document.activeElement), true, "arrow navigation keeps focus on the tab");
      assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[high]", "browsing tabs cannot select a model");
      await p.keyboard.press("Home");
      assert.equal(await codexTab.getAttribute("aria-selected"), "true");
      await p.keyboard.press("Alt+p");
      assert.equal(await p.getByRole("tab", { name: "Agent: Cursor", exact: true }).getAttribute("aria-selected"), "true", "registered shortcut cycles forward");
      await p.keyboard.press("Alt+Shift+p");
      assert.equal(await codexTab.getAttribute("aria-selected"), "true", "reverse shortcut cycles backward");
      assert.equal(await menu.isVisible(), true, "cycling keeps the picker open");
      assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[high]", "shortcut browsing writes no model");
    }
    assert.equal(await menu.getByRole("menuitem", { name: "Model One", exact: true }).count(), 1, "six concrete variants appear as one model");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.remembered.length), 0, "opening writes no defaults");
    const openModels = () => menu.getByRole("button", { name: /Change model/ });
    const chooseEffort = async (end: boolean) => {
      const slider = menu.getByRole("slider", { name: "Reasoning", exact: true });
      if (touch) {
        await slider.evaluate((el, toEnd) => {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: toEnd ? "End" : "Home", bubbles: true }));
        }, end);
      } else {
        await slider.focus();
        await p.keyboard.press(end ? "End" : "Home");
      }
    };
    if (touch) await menu.getByRole("menuitem", { name: "Model One", exact: true }).tap(); else await menu.getByRole("menuitem", { name: "Model One", exact: true }).click();
    if (touch) assert.equal(await editor.evaluate(el => el === document.activeElement), true, "touch choices retain editor focus");
    await menu.getByRole("slider", { name: "Reasoning", exact: true }).waitFor();
    assert.equal(await menu.getByRole("slider", { name: "Reasoning", exact: true }).getAttribute("aria-valuetext"), "High");
    await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-effort.png` });
    await chooseEffort(false);
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[low]");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().effort), undefined, "variant selection adds no unsupported effort override");
    if (touch) await openModels().tap(); else await openModels().click();
    const modelTwo = menu.getByRole("menuitem", { name: "Model Two", exact: true }); if (touch) await modelTwo.tap(); else await modelTwo.click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:two[low]");
    if (touch) await openModels().tap(); else await openModels().click();
    const search = menu.getByRole("searchbox", { name: "Search models" });
    await search.click();
    await p.keyboard.type("not-a-model");
    await menu.getByText("No models match your search.", { exact: true }).waitFor();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:two[low]");
    await search.click(); await p.keyboard.press("Control+a"); await p.keyboard.type("Model One"); await search.press("ArrowDown"); await p.keyboard.press("Enter");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[low]");
    if (touch) await openModels().tap(); else await openModels().click();
    await search.click(); await p.keyboard.press("Control+a"); await p.keyboard.press("Backspace");
    await p.getByRole("tab", { name: "Agent: Cursor", exact: true }).click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[low]", "browsing another Agent cannot select it");
    await menu.getByRole("menuitem", { name: "Model One", exact: true }).click();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "cursor:one");
    assert.equal(await menu.getByRole("slider").count(), 0, "unsupported controls stay absent");
    const cursorThinking = menu.getByRole("menuitem", { name: "Cursor Thinking", exact: true });
    if (touch) await cursorThinking.tap(); else await cursorThinking.click();
    await chooseEffort(false);
    const cursorFast = menu.getByRole("button", { name: "Fast mode", exact: true });
    if (touch) await cursorFast.tap(); else { await cursorFast.focus(); await p.keyboard.press("Space"); }
    assert.deepEqual(await p.evaluate(() => { const s = (window as any).modelBrowserFixture.selections(); return { model: s.model, effort: s.effort, serviceTier: s.serviceTier }; }), { model: "cursor:thinking", effort: "low", serviceTier: "fast" });
    if (touch) await cursorFast.tap(); else await p.keyboard.press("Space");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().serviceTier), null, "Cursor Fast off is an explicit clear");
    if (touch) await openModels().tap(); else await openModels().click();
    await p.getByRole("tab", { name: "Agent: API models", exact: true }).click();
    await menu.getByRole("menuitem", { name: "Thinking model", exact: true }).click();
    await chooseEffort(true);
    const fastSwitch = menu.getByRole("button", { name: "Fast mode", exact: true });
    if (touch) await fastSwitch.tap(); else { await fastSwitch.focus(); await p.keyboard.press("Space"); }
    const reset = menu.getByRole("button", { name: "Reset reasoning to model default" });
    if (touch) await reset.tap(); else await reset.click();
    assert.deepEqual(await p.evaluate(() => { const s = (window as any).modelBrowserFixture.selections(); return { model: s.model, effort: s.effort, serviceTier: s.serviceTier }; }), { model: "api:thinking", effort: "medium", serviceTier: "fast" });
    await chooseEffort(true);
    assert.deepEqual(await p.evaluate(() => { const s = (window as any).modelBrowserFixture.selections(); return { model: s.model, effort: s.effort, serviceTier: s.serviceTier }; }), { model: "api:thinking", effort: "high", serviceTier: "fast" });
    await p.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), "Keep this model selection draft");
    assert.equal(await editor.evaluate(el => el === (window as any).originalModelBrowserEditor), true);
    await editor.focus(); await p.keyboard.press("Alt+p"); await menu.waitFor();
    assert.equal(await p.getByRole("tab", { name: "Agent: Codex", exact: true }).getAttribute("aria-selected"), "true", "closed picker opens on the next Agent");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "api:thinking", "opening by shortcut writes no model");
    await p.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
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
    if (await menu.getByRole("button", { name: /Change model/ }).count()) await menu.getByRole("button", { name: /Change model/ }).click();
    assert.equal(await p.getByRole("tab", { name: "Agent: API models", exact: true }).count(), 0);
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
      await trigger.click(); await menu.waitFor();
      if (await menu.getByRole("button", { name: /Change model/ }).count()) await menu.getByRole("button", { name: /Change model/ }).click();
      await p.getByRole("tab", { name: "Agent: Codex", exact: true }).click();
      assert.equal(await p.locator(".opencraft-composer-model-browser__models").evaluate(el => el.scrollHeight > el.clientHeight), true);
      assert.equal(await menu.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
      await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
      await p.keyboard.press("Escape");
    }
    if (touch) {
      // The short visual viewport represents space above an open keyboard.
      // This checks real touch controls, six effort levels and Fast together.
      for (const size of [{ width: 390, height: 430 }, { width: 430, height: 390 }, { width: 320, height: 320 }]) {
        await p.setViewportSize(size);
        await p.evaluate(() => {
          const root = document.getElementById("root")!;
          Object.assign(root.style, { height: "auto", minHeight: "0", position: "fixed", bottom: "12px", left: "16px", width: "calc(100vw - 32px)", margin: "0" });
        });
        await trigger.tap(); await menu.waitFor();
        await p.getByRole("tab", { name: "API models", exact: true }).tap();
        await menu.getByRole("menuitem", { name: "Six-level thinking", exact: true }).tap();
        const list = p.locator(".opencraft-composer-model-browser__models");
        await list.evaluate(el => { el.scrollTop = 0; });
        await p.locator(".opencraft-composer-model-browser").evaluate(el => { el.scrollTop = 0; });
        const visible = await list.evaluate(el => {
          const bounds = el.getBoundingClientRect();
          const surface = el.closest('[role="menu"]')!.getBoundingClientRect();
          return [...el.querySelectorAll('[data-model-choice]')].filter(item => {
            const r = item.getBoundingClientRect();
            return r.top >= Math.max(bounds.top, surface.top) && r.bottom <= Math.min(bounds.bottom, surface.bottom);
          }).length;
        });
        const minimumRows = size.height <= 320 ? 2 : 3;
        assert.ok(visible >= minimumRows, `short touch viewport ${size.width}x${size.height} shows ${minimumRows} complete model rows; got ${visible}`);
        assert.ok(await menu.getByRole("searchbox").evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16), "search avoids iOS focus zoom");
        assert.equal(await menu.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), true);
        await p.screenshot({ path: `${output}/keyboard-${size.width}x${size.height}.png` });
        await menu.getByRole("switch", { name: "Fast mode", exact: true }).tap();
        await p.keyboard.press("Escape");
        assert.equal(await editor.innerText(), "Keep this model selection draft");
        assert.equal(await editor.evaluate(el => el === (window as any).originalModelBrowserEditor), true);
      }
    }
    if (touch) {
      await p.setViewportSize({ width: 390, height: 430 });
      await p.goto(`${base}?locale=zh-CN`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await p.evaluate(() => Object.assign(document.getElementById("root")!.style, { height: "auto", position: "fixed", bottom: "12px", left: "16px", width: "calc(100vw - 32px)", margin: "0" }));
      await p.locator(".opencraft-composer-editor").fill("保留尚未发送的草稿");
      await p.locator(".opencraft-composer-mode--intelligence").tap();
      await p.getByRole("tab", { name: /API/ }).tap();
      await p.getByRole("menuitem", { name: "Six-level thinking", exact: true }).tap();
      const effortRows = await p.locator(".opencraft-composer-model-browser__efforts button").evaluateAll(buttons => buttons.map(button => Math.round(button.getBoundingClientRect().top)));
      assert.equal(new Set(effortRows).size, 1, "six Chinese effort labels and reset share one touch row");
      await p.locator(".opencraft-composer-model-browser__models").evaluate(el => { el.scrollTop = 0; });
      await p.screenshot({ path: `${output}/keyboard-zh-CN.png` });
    }
    assert.deepEqual(errors, []); await context.close();
  }
  for (const touch of retirementOnly ? [] : [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.setDefaultTimeout(20_000); const errors: string[] = []; p.on("pageerror", (error: Error) => errors.push(error.message));
    await p.goto(`${base}?thread=1&bridge=1`); const editor = p.locator(".opencraft-composer-editor"); await editor.fill("Continue this thread");
    const trigger = p.locator(".opencraft-composer-mode--intelligence");
    if (touch) await trigger.tap(); else { await trigger.focus(); await p.keyboard.press("Enter"); }
    const menu = p.locator(".opencraft-composer-model-browser-surface"); await menu.waitFor();
    assert.equal(await menu.getByRole("slider", { name: "Reasoning", exact: true }).count(), 1, "an existing thread opens on reasoning");
    const effortGeometry = await p.evaluate(() => {
      const surface = document.querySelector(".opencraft-composer-model-browser-surface")!;
      const header = surface.querySelector(".opencraft-composer-effort__header")!;
      const name = surface.querySelector(".opencraft-composer-effort__name")!;
      const track = surface.querySelector(".ui-discrete-slider__track")!;
      const thumb = surface.querySelector(".ui-discrete-slider__visual-thumb")!;
      return { menuWidth: surface.getBoundingClientRect().width, menuHeight: surface.getBoundingClientRect().height,
        headerHeight: header.getBoundingClientRect().height, headerColumns: getComputedStyle(header).gridTemplateColumns,
        nameFontSize: getComputedStyle(name).fontSize, trackWidth: track.getBoundingClientRect().width,
        trackHeight: track.getBoundingClientRect().height, thumbWidth: thumb.getBoundingClientRect().width,
        thumbHeight: thumb.getBoundingClientRect().height };
    });
    assert.equal(effortGeometry.menuWidth, 288, "the effort layer keeps the former compact picker width");
    assert.equal(effortGeometry.menuHeight, touch ? 142 : 122, "the effort layer keeps the former compact picker height");
    assert.equal(effortGeometry.headerHeight, touch ? 64 : 44, "the effort header keeps the former desktop and touch density");
    assert.equal(effortGeometry.headerColumns, touch ? "44px 166px 44px" : "32px 190px 32px", "header side slots and the model title keep the former geometry");
    assert.equal(effortGeometry.nameFontSize, "14px", "the effort name keeps the former readout typography");
    assert.equal(effortGeometry.trackWidth, 262, "the track returns to the former compact width");
    assert.equal(effortGeometry.trackHeight, 28, "the shared track height is unchanged");
    assert.equal(effortGeometry.thumbWidth, 30, "the shared thumb size is unchanged");
    assert.equal(effortGeometry.thumbHeight, 30, "the thumb stays round");
    await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-existing-effort.png` });
    if (touch) await menu.getByRole("button", { name: /Change model/ }).tap(); else await menu.getByRole("button", { name: /Change model/ }).click();
    const currentCodex = p.getByRole("tab", { name: "Agent: Codex, current conversation", exact: true });
    assert.equal(await currentCodex.getAttribute("aria-selected"), "true", "the existing conversation opens on its own Agent");
    assert.equal(await currentCodex.getAttribute("data-current-agent"), "true");
    assert.equal(await currentCodex.getAttribute("title"), "Codex (current conversation)");
    assert.equal((await currentCodex.innerText()).trim(), "", "the current Agent tab also exposes only its icon");
    assert.equal(await p.locator(".opencraft-composer-model-browser__source-name").innerText(), "Codex · Current conversation", "the current Agent is visibly marked while browsing");
    const currentModel = menu.getByRole("menuitem", { name: "Model Two", exact: true });
    if (touch) await currentModel.tap(); else await currentModel.click();
    await p.waitForFunction(() => (window as any).modelBrowserFixture.selections().model?.startsWith("codex:two"));
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.handoffs.length), 0, "the current Agent selects in place");
    const beforeHandoff = await p.evaluate(() => (window as any).modelBrowserFixture.selections().model);
    if (touch) await menu.getByRole("button", { name: /Change model/ }).tap(); else await menu.getByRole("button", { name: /Change model/ }).click();
    const cursorTab = p.getByRole("tab", { name: "Agent: Cursor", exact: true });
    if (touch) await cursorTab.tap(); else await cursorTab.click();
    assert.equal(await p.locator(".opencraft-composer-model-browser__source-name").innerText(), "Cursor · Current: Codex", "the visible name follows browsing and keeps the current Agent marked");
    const notice = "Choosing a model from another Agent starts a new conversation with this thread's context.";
    await menu.getByText(notice, { exact: true }).waitFor();
    assert.equal(await currentCodex.getAttribute("data-current-agent"), "true", "the source Agent stays marked while browsing");
    assert.equal(await cursorTab.getAttribute("aria-selected"), "true");
    const thinking = menu.getByRole("menuitem", { name: "Cursor Thinking", exact: true });
    if (touch) await thinking.tap(); else await thinking.click();
    await p.waitForFunction(() => (window as any).modelBrowserFixture.handoffs.length === 1);
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.handoffs[0]), "cursor:thinking");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), beforeHandoff, "handoff stays a new-draft intent instead of mutating the thread");
    await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-existing-handoff.png` });
    assert.deepEqual(errors, []); await context.close();
  }
  for (const touch of retirementOnly ? [] : [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.setDefaultTimeout(20_000);
    await p.goto(`${base}?thread=1&single=1&handoff=0`);
    const trigger = p.locator(".opencraft-composer-mode--intelligence");
    if (touch) await trigger.tap(); else { await trigger.focus(); await p.keyboard.press("Enter"); }
    const menu = p.locator(".opencraft-composer-model-browser-surface"); await menu.waitFor();
    if (touch) await menu.getByRole("button", { name: /Change model/ }).tap(); else await menu.getByRole("button", { name: /Change model/ }).click();
    assert.equal(await p.getByRole("tablist").count(), 1, "one Agent still renders its identity row");
    const singleTab = p.getByRole("tab", { name: "Agent: Codex, current conversation", exact: true });
    assert.equal(await singleTab.count(), 1);
    assert.equal(await singleTab.getAttribute("data-current-agent"), "true", "the current Agent is marked without cross-Agent capability");
    assert.equal(await p.locator(".opencraft-composer-model-browser__source-name").innerText(), "Codex · Current conversation");
    assert.equal(await menu.getByText("Choosing a model from another Agent starts a new conversation with this thread's context.", { exact: true }).count(), 0);
    const currentModel = menu.getByRole("menuitem", { name: "Model Two", exact: true });
    if (touch) await currentModel.tap(); else await currentModel.click();
    await p.waitForFunction(() => (window as any).modelBrowserFixture.selections().model?.startsWith("codex:two"));
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.handoffs.length), 0);
    await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-single-agent.png` });
    await context.close();
  }
  for (const touch of retirementOnly ? [] : [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1200, height: 900 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.setDefaultTimeout(20_000);
    await p.goto(`${base}?thread=1&single=1&lateCatalog=1`);
    const trigger = p.locator(".opencraft-composer-mode--intelligence");
    const menu = p.locator(".opencraft-composer-model-browser-surface");
    const current = menu.getByRole("tab", { name: "Agent: Codex, current conversation", exact: true });
    const sameName = menu.getByRole("tab", { name: "Agent: Codex", exact: true });
    const press = (locator: typeof trigger) => touch ? locator.tap() : locator.click();
    await press(trigger);
    assert.equal(await current.getAttribute("aria-selected"), "true");
    assert.equal(await sameName.count(), 1, "another Host's Codex is not the current conversation");
    assert.equal(await menu.getByRole("menuitem", { name: "Other Host model", exact: true }).count(), 0);
    await p.evaluate(() => (window as any).modelBrowserFixture.setCatalogReady(true));
    const replacement = menu.getByRole("menuitem", { name: "Model Two", exact: true });
    await replacement.waitFor();
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.selections().model), "codex:one[high]",
      "catalog arrival preserves the existing selection");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.remembered.length), 0,
      "opening and loading the catalog do not write defaults");
    assert.equal(await sameName.count(), 2, "the same-named Host and unclassified models have separate tabs");
    await press(replacement);
    await p.waitForFunction(() => (window as any).modelBrowserFixture.selections().model?.startsWith("codex:two"));
    await press(menu.getByRole("button", { name: /Change model/ }));
    await press(sameName.first());
    await menu.getByRole("menuitem", { name: "Other Host model", exact: true }).waitFor();
    assert.equal(await current.getAttribute("data-current-agent"), "true");
    await press(sameName.last());
    await press(menu.getByRole("menuitem", { name: "Legacy Host model", exact: true }));
    await p.waitForFunction(() => (window as any).modelBrowserFixture.selections().model === "legacy-model");
    assert.equal(await p.evaluate(() => (window as any).modelBrowserFixture.handoffs.length), 0);
    await context.close();
  }
  if (!retirementOnly) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" });
    const p = await context.newPage(); p.setDefaultTimeout(20_000);
    await p.goto(`${base}?thread=1&locale=zh-CN`);
    await p.locator(".opencraft-composer-mode--intelligence").click();
    const menu = p.locator(".opencraft-composer-model-browser-surface"); await menu.waitFor();
    await menu.getByRole("button", { name: /更换模型/ }).click();
    assert.equal(await p.getByRole("tab", { name: "Agent：Codex，当前会话", exact: true }).count(), 1, "accessible Agent names come from the active Intl catalog");
    await context.close();
  }
  for (const touch of existingThreadsOnly ? [] : [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1067, height: 814 }, hasTouch: touch, isMobile: touch, reducedMotion: "no-preference" });
    const p = await context.newPage();
    await p.addInitScript(() => { (window as any).__name = (value: unknown) => value; });
    await p.goto(`${base}?retire=1`);
    const editor = p.locator(".opencraft-composer-editor");
    await editor.fill("Keep the original draft across settings");
    await p.evaluate(() => {
      (window as any).originalModelBrowserEditor = document.querySelector(".opencraft-composer-editor");
      (window as any).modelBrowserFixture.setDisabledAgents(["api", "cursor", "codex"]);
    });
    const trigger = p.locator(".opencraft-composer-mode--intelligence");
    const menu = p.locator(".opencraft-composer-model-browser-surface");
    const open = () => touch ? trigger.tap() : trigger.press("Enter");
    await open();
    const configure = menu.getByRole("menuitem", { name: /^(Configure models|Manage models…)$/ });
    await configure.waitFor();
    await menu.evaluate(element => {
      (window as any).normalMenuExit = new Promise<boolean>(resolve => {
        element.addEventListener("animationstart", event => {
          if (event.animationName === "menu-surface-exit") resolve(true);
        });
        element.addEventListener("animationend", event => {
          if (event.animationName === "menu-surface-exit") resolve(true);
        });
        setTimeout(() => resolve(false), 500);
      });
    });
    await p.keyboard.press("Escape");
    assert.equal(await p.evaluate(() => (window as any).normalMenuExit), true, "ordinary close still animates in its active page");
    await menu.waitFor({ state: "detached" });
    await open();
    await configure.waitFor();
    await p.evaluate(() => {
      const chat = document.querySelector<HTMLElement>("[data-fixture-chat]")!;
      const surface = document.querySelector<HTMLElement>(".opencraft-composer-model-browser-surface")!;
      (window as any).firstRetiredMenuFrame = new Promise<boolean>(resolve => {
        requestAnimationFrame(function sample() {
          if (!chat.hidden) { requestAnimationFrame(sample); return; }
          resolve(surface.isConnected);
        });
      });
    });
    if (touch) await configure.tap(); else await configure.click();
    const destination = p.getByRole("button", { name: "Return to chat" });
    await destination.waitFor();
    assert.equal(await p.evaluate(() => (window as any).firstRetiredMenuFrame), false, "no portalled surface survives the first frame after its page retires");
    assert.equal(await destination.evaluate(element => element === document.activeElement), true, "old menu focus cleanup leaves the new page in control");
    await destination.click();
    await editor.waitFor();
    assert.equal(await menu.count(), 0, "returning does not revive the closed menu");
    assert.equal(await editor.innerText(), "Keep the original draft across settings");
    assert.equal(await editor.evaluate(el => el === (window as any).originalModelBrowserEditor), true);
    await open();
    await configure.waitFor();
    await p.evaluate(() => (window as any).modelBrowserFixture.setChatActive(false));
    await menu.waitFor({ state: "detached" });
    await destination.click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false", "owner retirement clears a controlled open request without selecting a menu item");
    await context.close();
  }
  const scenarios = existingThreadsOnly ? "existing conversations with keyboard and touch"
    : retirementOnly ? "navigation retirement and retained drafts with keyboard and touch"
    : "desktop and touch, search and empty results, effort controls, themes, navigation retirement and retained drafts";
  console.log(`PASS model browser: ${scenarios}. Screenshots: ${output}. Inference boundary simulated.`);
} finally { await browser?.close(); await vite.close(); }
