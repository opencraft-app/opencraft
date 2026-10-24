import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT_DIR ?? ".local/async-question-keyboard");
await mkdir(output, { recursive: true });
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-async-question-keyboard",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "async-question-keyboard", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/async-question-keyboard.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const results = [];
  for (const mobile of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1100, height: 850 }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    const open = async () => {
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}${theme === "dark" ? "&suggested" : ""}`);
      if (theme === "dark") await page.getByText("Custom answer", { exact: true }).click();
      await page.getByRole("textbox", { name: "Your answer" }).waitFor();
    };
    const input = page.getByRole("textbox", { name: "Your answer" });
    const send = page.getByRole("button", { name: "Send answer", exact: true });
    const answers = () => page.evaluate(() => (window as any).answers);
    const dispatch = async (props: Record<string, unknown>) => input.evaluate((node: HTMLTextAreaElement, init: Record<string, unknown>) =>
      node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...init })), props);
    for (const shortcut of ["Enter", "Meta+Enter", "Control+Enter"]) {
      await open();
      await input.fill("  My answer\n第二行  ");
      if (shortcut === "Enter") await page.screenshot({ path: resolve(output, `${mobile ? "mobile" : "desktop"}-${theme}-draft.png`) });
      await input.press(shortcut);
      await page.waitForFunction(() => (window as any).answers.length === 1);
      assert.equal((await answers())[0].text, "My answer\n第二行");
      assert.equal(await input.isDisabled(), true);
      // A held request cannot be resubmitted by another keyboard event or click.
      await dispatch({});
      await send.evaluate((node: HTMLButtonElement) => node.click());
      assert.equal((await answers()).length, 1);
      await page.evaluate(() => (window as any).settleAnswer(true));
      await page.waitForFunction(() => !document.querySelector("textarea")!.matches(":disabled"));
      assert.equal(await input.inputValue(), "  My answer\n第二行  ");
      await input.press(shortcut);
      await page.waitForFunction(() => (window as any).answers.length === 2);
      await page.evaluate(() => (window as any).settleAnswer(false));
      await page.waitForFunction(() => !document.querySelector("textarea")!.matches(":disabled"));
      // Authoritative resolution disables/removes the control, not a local guess.
      await page.evaluate(() => (window as any).setQuestionMode("answered"));
      await page.getByText("Answered", { exact: true }).waitFor();
      assert.equal(await input.count(), 0);
    }
    await open();
    await input.fill("First");
    await input.press("Shift+Enter");
    await input.press("x");
    assert.equal(await input.inputValue(), "First\nx");
    assert.equal((await answers()).length, 0);
    for (const props of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { key: "Escape" }]) {
      await dispatch(props);
      assert.equal((await answers()).length, 0, JSON.stringify(props));
    }
    await input.fill("   ");
    await input.press("Enter");
    assert.equal(await send.isDisabled(), true);
    assert.equal((await answers()).length, 0);
    await input.fill("Keep this draft");
    for (const mode of ["disconnected", "queued", "dismissed"]) {
      await page.evaluate((mode: string) => (window as any).setQuestionMode(mode), mode);
      if (mode === "disconnected") {
        await page.getByText("Connect to answer", { exact: true }).waitFor();
        assert.equal(await input.isDisabled(), true);
        await dispatch({ metaKey: true });
      } else await input.waitFor({ state: "hidden" });
      assert.equal((await answers()).length, 0);
      await page.evaluate(() => (window as any).setQuestionMode("pending"));
      await input.waitFor();
      assert.equal(await input.inputValue(), "Keep this draft");
    }
    await send.click();
    assert.equal((await answers())[0].text, "Keep this draft");
    await page.evaluate(() => (window as any).settleAnswer(false));
    await page.waitForFunction(() => !document.querySelector("textarea")!.matches(":disabled"));
    // Suggested-answer click and Other keyboard answer still share one owner.
    if (theme === "dark") {
      await page.getByText("Suggested answer", { exact: true }).click();
      await send.click();
      assert.equal((await answers())[1].text, "Suggested answer");
    }
    await page.screenshot({ path: resolve(output, `${mobile ? "mobile" : "desktop"}-${theme}.png`) });
    assert.deepEqual(errors, []);
    results.push({ mobile, theme, shortcuts: 3, failureDraftRetry: true, duplicateBlocked: true, imeAndModifiers: true, unavailable: true, click: true });
    await page.close();
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ result: "passed", cases: results.length, output }));
} finally { await browser?.close(); await vite.close(); }
