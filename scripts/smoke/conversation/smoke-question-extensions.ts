import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT_DIR ?? ".local/question-extensions"); await mkdir(output, { recursive: true });
async function assertNativeQuestionIme(page: any, input: any, answerCount: number) {
  const original = await input.inputValue();
  await input.fill(original); await input.focus();
  await input.evaluate((element: HTMLInputElement) => {
    (window as any).imeInput = element; (window as any).imeKeys = []; (window as any).imeEvents = [];
    element.addEventListener("keydown", event => (window as any).imeKeys.push({ key: event.key, composing: event.isComposing, keyCode: event.keyCode }));
    for (const type of ["compositionstart", "compositionend"]) element.addEventListener(type, () => (window as any).imeEvents.push(type));
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.imeSetComposition", { text: "候选", selectionStart: 2, selectionEnd: 2 });
    for (const key of ["Enter", "Escape"]) await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => (window as any).answers.length), answerCount);
    await cdp.send("Input.insertText", { text: "已确认" });
    const committed = await input.inputValue();
    assert.equal(committed, original + "已确认");
    for (const key of ["Escape", "Enter"]) {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => (window as any).answers.length), answerCount, `Input method owns compatibility ${key}`);
      assert.equal(await input.inputValue(), committed);
      assert(await input.evaluate((element: HTMLInputElement) => element === (window as any).imeInput && element === document.activeElement));
    }
    const native = await page.evaluate(() => ({ keys: (window as any).imeKeys, events: (window as any).imeEvents }));
    assert.deepEqual(native.events, ["compositionstart", "compositionend"]);
    for (const key of ["Enter", "Escape"]) {
      assert(native.keys.some((event: any) => event.key === key && event.composing));
      assert(native.keys.some((event: any) => event.key === key && !event.composing && event.keyCode === 229));
    }
    await input.fill(original);
  } finally { await cdp.detach(); }
}

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-question-extensions", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "question-extensions", configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/" && !req.url?.startsWith("/?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/question-extensions.tsx"></script>'); }); } }] });
let browser: any;
try {
  await vite.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const entryOnly = process.argv.includes("--entry-only");
  const scenes = entryOnly ? [390, 1100].flatMap(width => ["light", "dark"].flatMap(theme => ["reduce", "no-preference"].map(reducedMotion => ({ width, theme, reducedMotion }))))
    : [390, 1100].flatMap(width => ["light", "dark"].map(theme => ({ width, theme, reducedMotion: "reduce" })));
  const entries: unknown[] = [];
  for (const { width, theme, reducedMotion } of scenes) {
    const page = await browser.newPage({ viewport: { width, height: 850 }, reducedMotion, hasTouch: width === 390 }); const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message)); await page.addInitScript("window.__name=value=>value");
    if (entryOnly) await page.addInitScript(() => {
      const w = window as any; w.entryFrames = []; w.entryLabel = "cold"; w.entryResizeFeedback = [];
      window.addEventListener("error", event => { if (event.message.startsWith("ResizeObserver")) w.entryResizeFeedback.push({ label: w.entryLabel, message: event.message }); });
      const sample = () => {
        const panel = document.querySelector<HTMLElement>(".thread-pending-request-panel");
        if (panel) { const css = getComputedStyle(panel); w.entryFrames.push({ label: w.entryLabel, opacity: Number(css.opacity), transform: css.transform }); }
      };
      new MutationObserver(sample).observe(document, { subtree: true, childList: true });
      const frame = () => { sample(); requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}${entryOnly ? `/?entry=1&theme=${theme}` : `/?theme=${theme}`}`);
    if (entryOnly) {
      const panel = page.locator('.thread-pending-request-panel'); await panel.waitFor(); await page.waitForTimeout(260);
      const frames = (label: string) => page.evaluate(label => (window as any).entryFrames.filter((frame: any) => frame.label === label), label);
      const staticFrames = (rows: any[], label: string) => {
        assert.ok(rows.length > 0, label);
        assert.ok(rows.every(row => row.opacity === 1 && (row.transform === "none" || row.transform === "matrix(1, 0, 0, 1, 0, 0)")), `${label}: recovered and reduced-motion interaction panels must be visible and stationary from the first frame: ${JSON.stringify(rows)}`);
      };
      staticFrames(await frames("cold"), "cold baseline");
      const act = async (label: string, method: string, kind?: string) => {
        await page.evaluate(([label, method, kind]) => { (window as any).entryLabel = label; (window as any).entryFixture[method](kind); }, [label, method, kind]);
        await page.waitForTimeout(260); return frames(label);
      };
      for (const kind of ["question", "approval"]) {
        staticFrames(await act(kind + "-baseline", "reset", kind), kind + " baseline");
        const node = await panel.elementHandle();
        if (kind === "question") await panel.getByRole('textbox').fill('未提交中文草稿');
        staticFrames(await act(kind + "-return", "restore"), kind + " return");
        assert.equal(await node!.evaluate(element => element.isConnected), false);
        if (kind === "question") assert.equal(await panel.getByRole('textbox').inputValue(), '未提交中文草稿');
        await act(kind + "-empty", "clear"); assert.equal(await panel.count(), 0);
        const fresh = await act(kind + "-fresh", "appear", kind);
        if (reducedMotion === "reduce") staticFrames(fresh, kind + " reduced-motion new entry");
        else assert.ok(fresh.some((row: any) => row.opacity < 1), kind + " genuinely new live requests keep entry motion");
        const current = await panel.elementHandle();
        staticFrames(await act(kind + "-update", "refresh"), kind + " equivalent update");
        assert.equal(await current!.evaluate(element => element.isConnected), true);
      }
      assert.deepEqual(await page.evaluate(() => (window as any).answers), []); assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => (window as any).entryResizeFeedback), []);
      await writeFile(join(output, `entry-${width}-${theme}-${reducedMotion}.json`), JSON.stringify(await page.evaluate(() => (window as any).entryFrames)));
      await page.screenshot({ path: join(output, `entry-${width}-${theme}-${reducedMotion}.png`) });
      entries.push({ width, theme, reducedMotion, baselineStatic: true, returnStatic: true, draftRestored: true, liveEntryPreserved: true, equivalentNodeRetained: true });
      await page.close(); continue;
    }
    await page.getByRole("heading", { name: "Full fixture plan" }).waitFor();
    const first = page.getByRole("button", { name: /1 Verify/ }), second = page.getByRole("button", { name: /2 Deliver/ });
    await first.click(); await second.click(); assert.equal(await first.getAttribute("aria-pressed"), "true"); assert.equal(await second.getAttribute("aria-pressed"), "true");
    assert.deepEqual(await page.evaluate(() => (window as any).answers), []);
    const input = page.getByRole("textbox");
    await input.fill("Custom step");
    await input.evaluate((element: HTMLInputElement) => { element.focus(); element.setSelectionRange(2, 7); (window as any).questionInput = element; });
    await page.evaluate(() => (window as any).questionFixture.refresh());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await input.evaluate((element: HTMLInputElement) => ({ value: element.value, same: element === (window as any).questionInput, focus: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd })), { value: "Custom step", same: true, focus: true, start: 2, end: 7 });
    assert.equal(await first.getAttribute("aria-pressed"), "true"); assert.equal(await second.getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: join(output, `${width}-multiselect.png`) });
    await page.getByRole("button", { name: /Submit/ }).click();
    await page.waitForFunction(() => (window as any).answers.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).answers[0]), { type: "answer-questions", answers: { q: ["Verify", "Deliver", "Custom step"] } });
    await page.evaluate(() => (window as any).questionFixture.replaceRequest());
    await page.waitForFunction(() => (document.querySelector(".thread-request-input input") as HTMLInputElement)?.value === "");
    assert.equal(await first.getAttribute("aria-pressed"), "false");
    await input.fill("New request draft");
    await page.evaluate(() => (window as any).questionFixture.changeQuestion());
    await page.getByRole("textbox", { name: "Response to Choose updated steps", exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector(".thread-request-input input") as HTMLInputElement)?.value === "");
    await page.evaluate(() => (window as any).questionFixture.showTwoQuestions());
    await page.getByRole("button", { name: "Next question", exact: true }).click();
    const secondInput = page.getByRole("textbox", { name: "Response to Describe second step", exact: true });
    await secondInput.waitFor(); await secondInput.fill("Second page draft");
    await secondInput.evaluate((element: HTMLInputElement) => { element.focus(); element.setSelectionRange(2, 7); (window as any).questionInput = element; });
    await page.evaluate(() => (window as any).questionFixture.refresh());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator(".thread-request-input__pagination").innerText(), "2 of 2");
    assert.deepEqual(await secondInput.evaluate((element: HTMLInputElement) => ({ value: element.value, same: element === (window as any).questionInput, focus: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd })), { value: "Second page draft", same: true, focus: true, start: 2, end: 7 });
    assert.equal(await page.evaluate(() => (window as any).answers.length), 1);
    for (const key of ["Enter", "Escape"]) await secondInput.dispatchEvent("keydown", { key, bubbles: true, isComposing: true });
    assert.equal(await page.evaluate(() => (window as any).answers.length), 1, "Question IME keys never submit or skip");
    await assertNativeQuestionIme(page, secondInput, 1);
    await secondInput.press("Enter");
    await page.waitForFunction(() => (window as any).answers.length === 2);
    assert.equal(await page.evaluate(() => (window as any).answers[1].type), "answer-questions");
    await page.evaluate(() => (window as any).questionFixture.replaceRequest());
    const firstInput = page.getByRole("textbox", { name: "Response to Choose steps", exact: true });
    await firstInput.waitFor(); await firstInput.press("Escape");
    await page.waitForFunction(() => (window as any).answers.length === 3);
    assert.deepEqual(await page.evaluate(() => (window as any).answers[2]), { type: "cancel" });
    await page.evaluate(() => (window as any).questionFixture.showOptionPicker());
    const pickerInput = page.getByRole("textbox", { name: "Something else", exact: true });
    await pickerInput.fill("中文候选");
    await pickerInput.dispatchEvent("compositionstart", { data: "候选" });
    for (const key of ["Enter", "Escape"]) await pickerInput.dispatchEvent("keydown", { key, bubbles: true, isComposing: true });
    await page.locator(".thread-option-picker form").evaluate((element: HTMLFormElement) => element.requestSubmit());
    assert.equal(await page.evaluate(() => (window as any).answers.length), 3, "Picker IME keys and implicit form submission preserve the request");
    assert.equal(await pickerInput.inputValue(), "中文候选");
    await pickerInput.dispatchEvent("compositionend", { data: "候选" });
    await assertNativeQuestionIme(page, pickerInput, 3);
    await pickerInput.press("Enter");
    await page.waitForFunction(() => (window as any).answers.length === 4);
    assert.deepEqual(await page.evaluate(() => (window as any).answers[3]), { type: "submit-option-picker", action: "submit", selectedOptions: [], freeformAnswer: "中文候选" });
    await page.evaluate(() => (window as any).questionFixture.replaceRequest());
    await page.waitForFunction(() => (document.querySelector(".thread-option-picker input") as HTMLInputElement)?.disabled === false);
    await pickerInput.press("Escape");
    await page.waitForFunction(() => (window as any).answers.length === 5);
    assert.equal(await page.evaluate(() => (window as any).answers[4].action), "dismiss");
    const showSetup = async (kind: "role" | "task" | "context") => {
      const requestId = await page.evaluate(kind => { (window as any).answers = []; return (window as any).questionFixture.showSetup(kind); }, kind);
      await page.locator(`[data-pending-request-id="${requestId}"]`).waitFor();
    };
    const replaySetup = async () => {
      await page.evaluate(() => (window as any).questionFixture.hide());
      await page.locator("[data-pending-request-id]").waitFor({ state: "detached" });
      await page.evaluate(() => (window as any).questionFixture.replay());
      await page.locator("[data-pending-request-id]").waitFor();
    };
    await showSetup("role");
    const role = page.getByRole("checkbox", { name: "Engineering", exact: true });
    await role.click(); await replaySetup();
    assert.equal(await role.getAttribute("aria-checked"), "true");
    assert.deepEqual(await page.evaluate(() => (window as any).answers), []);
    await page.getByRole("button", { name: /^Continue(?:\s*↵)?$/ }).click();
    await page.waitForFunction(() => (window as any).answers.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).answers[0]), { type: "submit-setup-role", action: "submit", selectedRoles: ["engineering"] });
    await showSetup("role");
    assert.equal(await role.getAttribute("aria-checked"), "false", "A new setup request resets input");
    await showSetup("task");
    const taskInput = page.getByRole("textbox", { name: "Something else", exact: true });
    await taskInput.fill("中文任务草稿"); await replaySetup();
    assert.equal(await taskInput.inputValue(), "中文任务草稿");
    assert.deepEqual(await page.evaluate(() => (window as any).answers), []);
    await page.getByRole("button", { name: /^Continue(?:\s*↵)?$/ }).click();
    await page.waitForFunction(() => (window as any).answers.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).answers[0]), { type: "submit-setup-task", action: "submit", answers: { first_task: ["中文任务草稿"] } });
    await showSetup("task");
    const taskChoice = page.getByRole("radio", { name: /Build something/ });
    await taskChoice.click(); await replaySetup();
    assert.equal(await taskChoice.getAttribute("aria-checked"), "true");
    await page.evaluate(() => (window as any).questionFixture.changeSetupStep("role"));
    await page.locator('[data-interaction-kind="setup-role"]').waitFor();
    assert.equal(await role.getAttribute("aria-checked"), "false", "A different setup step owns a new draft");
    await page.evaluate(() => (window as any).questionFixture.changeSetupStep("task"));
    await page.locator('[data-interaction-kind="setup-task"]').waitFor();
    assert.equal(await taskChoice.getAttribute("aria-checked"), "false", "Returning from another definition resets input");
    await showSetup("context");
    const browse = page.locator(".thread-setup-context__browse"), search = page.getByRole("textbox", { name: "Search apps and plugins", exact: true });
    await browse.locator("summary").click(); await search.fill("slack"); await replaySetup();
    assert.equal(await browse.getAttribute("open"), "");
    assert.equal(await search.inputValue(), "slack");
    assert.deepEqual(await page.evaluate(() => (window as any).answers), []);
    await page.screenshot({ path: join(output, `${width}-setup-context-restored.png`) });
    await page.getByRole("button", { name: /^Continue(?:\s*↵)?$/ }).click();
    await page.waitForFunction(() => (window as any).answers.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).answers[0]), { type: "submit-setup-context", action: "continue", selectedSources: [] });
    await showSetup("context");
    assert.equal(await browse.getAttribute("open"), null);
    assert.equal(await page.locator('.thread-setup-context input').inputValue(), "");
    assert.deepEqual(errors, []); await page.close();
  }
  if (entryOnly) console.log(JSON.stringify({ result: "passed", entries, output }));
  else console.log(JSON.stringify({ result: "passed", mobileWeb: true, desktopWeb: true, explicitMultiSubmit: true, fullPlanMarkdown: true, semanticRefreshRetainsDraft: true, replacementResetsDraft: true, questionPageRetained: true, imeKeysRetained: true, implicitFormCompositionGuard: true, ordinaryQuestionAndPickerKeys: true, output }));
} finally { await browser?.close(); await vite.close(); }
