import assert from "node:assert/strict";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-async-question-markdown-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "async-question-markdown-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/tests/fixtures/async-question-markdown.tsx"></script>');
      });
    },
  }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 740 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const favicon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route(/https:\/\/git\.example\.test\/favicon\.ico/u, route => route.fulfill({ body: favicon, contentType: "image/png" }));
  await page.route(/https:\/\/www\.google\.com\/s2\/favicons/u, route => route.fulfill({ body: favicon, contentType: "image/png" }));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);

  const card = page.locator(".thread-async-question");
  const link = card.locator(".chat-external-link");
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), "https://git.example.test/merge/4869");
  const titleId = await card.locator("fieldset").getAttribute("aria-labelledby");
  assert.ok(titleId);
  assert.equal(await card.locator(`[id="${titleId}"]`).count(), 1);
  assert.equal(await card.locator("legend").count(), 0);
  assert.equal(await card.locator("a[href^='javascript:']").count(), 0);
  assert.doesNotMatch(await card.textContent() ?? "", /\[!4869\]\(/u);
  assert.equal(await card.getByRole("group", { name: /Source MR !4869/u }).count(), 1);

  await link.click();
  assert.deepEqual(await page.evaluate(() => (window as any).opens), ["https://git.example.test/merge/4869"]);
  assert.deepEqual(await page.evaluate(() => (window as any).answers), []);
  await card.getByRole("textbox", { name: "Your answer" }).fill("Approved");
  await card.getByRole("button", { name: "Send answer" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).answers), ["Approved"]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", markdownLink: true, safeResource: true, answerUnchanged: true }));
} finally {
  await browser?.close();
  await vite.close();
}
