import assert from "node:assert/strict";
import { createServer } from "vite";
const playwright = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const { chromium } = playwright.default ?? playwright;
const screenshotRoot = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-conversation-presentation-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "presentation-smoke",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<div id="root"></div><script type="module" src="/tests/fixtures/conversation-presentation.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => {
    errors.push(error.message);
    console.error(error);
  });
  // A raw init script avoids tsx's function-name helper leaking into the page.
  await page.addInitScript({
    content: `Object.defineProperty(navigator, "clipboard", { value: {
    async write(items) { const contents = {}; for (const type of items[0].types) contents[type] = await (await items[0].getType(type)).text(); window.copied = contents; },
    async writeText(text) { window.copied = { "text/plain": text }; }
  } });`,
  });
  await page.goto(
    `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`,
  );
  await page.waitForSelector('[data-plan-completed="false"]');
  assert.match(await page.locator(".thread-thinking-placeholder").textContent(), /Planning/);
  assert.equal(
    await page.getByRole("button", { name: "Download plan" }).count(),
    0,
  );
  assert.equal(
    await page.locator(".thread-plan__body h1").textContent(),
    "Release plan",
  );
  assert.equal(
    Math.round((await page.locator(".thread-plan__body").boundingBox()).height),
    320,
  );
  await page.evaluate(() => (window as any).complete());
  await page.getByRole("button", { name: "Download plan" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Expand plan summary" })
      .getAttribute("aria-expanded"),
    "false",
    "completion cannot reset the user's collapse state",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download plan" }).click();
  assert.equal((await download).suggestedFilename(), "plan.md");
  await page.getByRole("button", { name: "Expand plan summary" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".thread-plan__body")!.getBoundingClientRect()
        .height > 320,
  );
  await page.evaluate(() => (window as any).restore());
  await page.getByRole("button", { name: "Collapse plan summary" }).waitFor();
  await page.evaluate(() => (window as any).scenario("todo"));
  assert.equal(await page.getByRole("button", { name: "Step 1 / 3" }).count(), 0);
  assert.equal(await page.locator(".thread-content .thread-todo").count(), 0, "todo snapshots never remain in transcript rows");
  assert.equal(await page.locator('[data-in-progress-fixed-content="true"] .thread-todo').count(), 1);
  await page.screenshot({ path: `${screenshotRoot}/conversation-presentation-todo-collapsed.png` });
  await page.getByRole("button", { name: "Step 2 / 3" }).click();
  await page.getByRole("dialog", { name: "Plan steps" }).waitFor();
  assert.equal(await page.locator(".thread-todo__popup li").count(), 3);
  assert.equal(
    await page
      .locator(
        '.thread-todo__popup li[data-status="in-progress"] .is-shimmering',
      )
      .evaluate((element: HTMLElement) => element.firstChild?.textContent),
    "Test rendering",
  );
  assert.equal(
    await page
      .locator(".thread-todo__popup")
      .evaluate((element: HTMLElement) => element.closest(".thread-content, .thread-todo") === null),
    true,
    "steps use the overlay portal, outside virtualized row layout",
  );
  await page.screenshot({ path: `${screenshotRoot}/conversation-presentation-todo-expanded.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Plan steps" }).waitFor({ state: "detached" });
  await page.evaluate(() => (window as any).complete());
  await page.waitForFunction(() => document.querySelector('[data-in-progress-fixed-content="true"]') === null);
  await page.evaluate(() => (window as any).scenario("compaction"));
  await page.waitForSelector('.thread-compaction[data-completed="false"]');
  assert.equal(await page.locator(".thread-thinking-placeholder").count(), 0);
  assert.match(
    await page.locator(".thread-compaction").textContent(),
    /Compacting context/,
  );
  await page.evaluate(() => (window as any).complete());
  await page.waitForSelector('.thread-compaction[data-completed="true"]');
  assert.match(
    await page.locator(".thread-compaction").textContent(),
    /Context compacted/,
  );
  await page.evaluate(() => (window as any).scenario("command"));
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Running npm test"),
  );
  await page.evaluate(() => (window as any).detail("STEPS_PROSE"));
  await page.waitForFunction(() =>
    document.body.textContent?.includes("Running command"),
  );
  await page.evaluate(() => (window as any).scenario("answer"));
  const copy = page
    .locator(".thread-message-actions")
    .getByRole("button", { name: "Copy response" });
  await copy.waitFor();
  await page.locator("[data-assistant-copy-content] strong").waitFor();
  await page.locator(".thread-frame").hover();
  await copy.click();
  await page.waitForFunction(() => (window as any).copied?.["text/html"]);
  const contents = await page.evaluate(() => (window as any).copied);
  assert.match(contents["text/plain"], /Answer/);
  assert.match(contents["text/html"], /<strong>(?:<span>)?Answer/);
  assert.match(contents["text/html"], /<code>code<\/code>/);
  assert.doesNotMatch(contents["text/html"], /Copy response|Worked for/);
  assert.equal(
    await page
      .locator("[data-assistant-message-sent-time]")
      .getAttribute("datetime"),
    "2023-11-14T22:13:20.000Z",
  );
  await page.screenshot({ path: `${screenshotRoot}/conversation-presentation-answer.png` });
  await page.evaluate(() => (window as any).scenario("skill"));
  await page.evaluate(() => (window as any).detail("STEPS_PROSE"));
  await page.getByRole("button", { name: "Reading Review skill", exact: true }).waitFor();
  await page.screenshot({ path: `${screenshotRoot}/conversation-presentation-skill.png` });
  await page.evaluate(() => (window as any).hooks());
  await page.evaluate(() => (window as any).detail("STEPS_COMMANDS"));
  const hook = page.getByRole("img", { name: "Hooks", exact: true });
  await hook.hover();
  const hookTooltip = page.getByRole("tooltip").filter({ hasText: "UserPromptSubmit" });
  await hookTooltip.waitFor();
  assert.match(await hookTooltip.innerText(), /Project · 2 runs/);
  assert.match(await hookTooltip.innerText(), /Audit failed/);
  assert.doesNotMatch(await hookTooltip.innerText(), /hidden context/);
  await page.screenshot({ path: `${screenshotRoot}/conversation-presentation-hooks.png` });
  await page.evaluate(() => (window as any).detail("STEPS_PROSE"));
  await hook.hover();
  const hookSummary = page.getByRole("tooltip").filter({ hasText: "Hooks summary" });
  await hookSummary.waitFor();
  assert.deepEqual(await hookSummary.locator(".thread-hook-stats__counts b").allTextContents(), ["3", "2", "1"]);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: [
        "streaming plan",
        "completion/collapse ownership",
        "download",
        "history restoration",
        "latest todo fixed outside transcript",
        "todo portal steps",
        "terminal todo removal",
        "compaction lifecycle",
        "detail mode",
        "failed-turn message actions",
        "HTML clipboard",
        "timestamp",
        "independent skill parser in real Conversation",
        "independent hook statistics in real Conversation",
      ],
      errors,
    }),
  );
} finally {
  await browser?.close();
  await vite.close();
}
