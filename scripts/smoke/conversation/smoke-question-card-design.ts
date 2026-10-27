import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const output = resolve(process.env.OPENCRAFT_SMOKE_OUTPUT_DIR ?? ".local/question-card-design");
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-question-card-design",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "question-card-design", configureServer(server) {
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
  for (const mobile of [false, true]) for (const [palette, theme] of [["canvas", "light"], ["canvas", "dark"], ["lavender", "light"], ["frost", "dark"]]) {
    const page = await browser.newPage({ viewport: { width: mobile ? 390 : 1200, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?design&locale=zh-CN&palette=${palette}&theme=${theme}`);
    const card = page.locator(".thread-async-question");
    const send = card.getByRole("button", { name: "发送回答" });
    await send.waitFor();
    await card.locator(".opencraft-chat-document").waitFor();
    if (mobile) await card.locator(".thread-async-question__title").tap();
    assert.equal(await card.locator(".thread-async-question__eyebrow, .thread-async-question__hint").count(), 0);
    const metrics = await card.evaluate((node: HTMLElement) => {
      const choices = [...node.querySelectorAll("label")];
      const title = node.querySelector(".opencraft-chat-document")!;
      return { width: node.getBoundingClientRect().width, weight: getComputedStyle(title).fontWeight,
        rowHeight: Math.min(...choices.map(c => c.getBoundingClientRect().height)),
        selected: getComputedStyle(choices[0]!).backgroundColor, other: getComputedStyle(choices[1]!).backgroundColor,
        questionText: title.textContent };
    });
    assert.equal(metrics.weight, "400");
    assert.notEqual(metrics.selected, metrics.other);
    assert.ok(metrics.width <= 620 && metrics.width <= (mobile ? 390 : 1200));
    assert.ok(metrics.rowHeight >= (mobile ? 44 : 36));
    assert.ok(metrics.questionText.includes("请选择本次提交使用的身份。"));
    await page.screenshot({ path: resolve(output, `${mobile ? "touch" : "desktop"}-${palette}-${theme}.png`) });
    await card.getByText("自定义回答", { exact: true }).click();
    const input = card.getByRole("textbox", { name: "你的回答" });
    const initialInputHeight = await input.evaluate((el: HTMLElement) => el.getBoundingClientRect().height);
    await input.fill("多行回答，保留完整信息。\n".repeat(16));
    await page.waitForFunction((height) => document.querySelector("textarea")!.getBoundingClientRect().height > height, initialInputHeight);
    assert.ok(await input.evaluate((el: HTMLElement) => el.getBoundingClientRect().height) > initialInputHeight);
    assert.ok(await input.evaluate((el: HTMLElement) => el.getBoundingClientRect().height) <= 240);
    await input.fill("保持这段草稿");
    await input.focus();
    await input.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(2, 5); });
    await page.evaluate(() => (window as any).setQuestionPalette("lavender", "dark"));
    assert.equal(await input.inputValue(), "保持这段草稿");
    assert.deepEqual(await input.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, document.activeElement === el]), [2, 5, true]);
    await send.click();
    await page.waitForFunction(() => (window as any).answers.length === 1);
    assert.equal(await send.isDisabled(), true);
    assert.equal(await card.locator("details").count(), 0);
    await page.evaluate(() => (window as any).settleAnswer(true));
    await page.waitForFunction(() => !document.querySelector("textarea")!.matches(":disabled"));
    assert.equal(await input.inputValue(), "保持这段草稿");
    await send.click();
    await page.waitForFunction(() => (window as any).answers.length === 2);
    await page.evaluate(() => (window as any).settleAnswer(false));
    await page.waitForFunction(() => !document.querySelector("textarea")!.matches(":disabled"));
    await page.evaluate(() => (window as any).setQuestionMode("unconfirmed"));
    await card.getByText("尚未确认送达", { exact: true }).waitFor();
    assert.equal(await card.locator("details").count(), 0);
    await page.evaluate(() => (window as any).setQuestionMode("answered"));
    await card.getByText("Already answered", { exact: true }).waitFor();
    assert.equal(await input.count(), 0);
    assert.ok(!(await card.textContent()).includes("保持这段草稿"));
    await card.locator("summary").click();
    await card.locator(".thread-async-question__title").waitFor();
    assert.equal(await card.locator("details").getAttribute("open"), "");
    await card.locator("summary").click();
    await page.evaluate(([palette, theme]) => (window as any).setQuestionPalette(palette, theme), [palette, theme]);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `${mobile ? "touch" : "desktop"}-${palette}-${theme}-answered.png`) });
    const resolvedMetrics = await card.evaluate((node: HTMLElement) => {
      const summary = node.querySelector("summary")!;
      return { height: node.getBoundingClientRect().height, hitHeight: summary.getBoundingClientRect().height,
        overflow: node.scrollWidth > node.clientWidth };
    });
    assert.ok(resolvedMetrics.height <= resolvedMetrics.hitHeight + 2, "resolved row must not stack vertical panel padding outside its hit target");
    assert.ok(resolvedMetrics.hitHeight >= (mobile ? 44 : 36));
    assert.equal(resolvedMetrics.overflow, false);
    await page.evaluate(() => (window as any).setQuestionMode("dismissed"));
    await card.waitFor({ state: "detached" });
    assert.equal(await page.getByText("已被后续消息替代", { exact: true }).count(), 0);
    assert.equal(await page.getByText("查看问题", { exact: true }).count(), 0);
    const history = page.locator(".opencraft-chat-document").filter({ hasText: "请选择本次提交使用的身份。" });
    assert.equal(await history.count(), 1, "superseded question remains ordinary message history exactly once");
    await history.scrollIntoViewIfNeeded();
    await history.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => (window as any).answers.length), 2, "hiding a superseded card must not submit an answer");
    await page.screenshot({ path: resolve(output, `${mobile ? "touch" : "desktop"}-${palette}-${theme}-dismissed.png`) });
    assert.deepEqual(errors, []);
    results.push({ mobile, palette, theme, metrics, resolvedMetrics, draftFocusPreserved: true, authoritativeAnswer: true, disclosure: true, supersededCardHidden: true, originalQuestionHistoryPreserved: true });
    await page.close();
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ result: "passed", cases: results.length, output }));
} finally { await browser?.close(); await vite.close(); }
