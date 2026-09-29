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
  cacheDir: "node_modules/.vite-url-presentation-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "url-presentation-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/tests/fixtures/url-presentation.tsx"></script>');
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
  const page = await browser.newPage({ viewport: { width: 900, height: 520 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript({ content: `Object.defineProperty(navigator, "clipboard", { value: {
    async writeText(text) { window.copiedUrl = text; }
  } });` });
  const favicon = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await page.route(/https:\/\/(?:git|stream)\.example\.test\/favicon\.ico/u, route => route.fulfill({ body: favicon, contentType: "image/png" }));
  await page.route(/https:\/\/www\.google\.com\/s2\/favicons/u, route => route.fulfill({ body: favicon, contentType: "image/png" }));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const link = page.locator(".chat-external-link");
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), "https://git.example.test/merge/4438");
  assert.equal(await page.locator("h2").count(), 1, "URL presentation must not flatten the model-authored heading");
  assert.equal(
    await link.evaluate((element: HTMLElement) => getComputedStyle(element).fontSize),
    await page.locator("h2").evaluate((element: HTMLElement) => getComputedStyle(element).fontSize),
  );
  await page.locator(".chat-external-link__icon img.is-loaded").waitFor();
  await link.hover();
  await page.getByRole("tooltip").waitFor();
  assert.equal(await page.getByRole("tooltip").textContent(), "https://git.example.test/merge/4438");

  await link.click();
  await link.click({ modifiers: ["Meta"] });
  let opens = await page.evaluate(() => (window as any).opens);
  assert.equal(opens[0].intent.disposition, "current-tab");
  assert.equal(opens[1].intent.disposition, "new-tab");

  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  assert.equal(await page.evaluate(() => (window as any).copiedUrl), "https://git.example.test/merge/4438");
  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in external browser" }).click();
  opens = await page.evaluate(() => (window as any).opens);
  assert.equal(opens.at(-1).intent.target, "external-browser");
  await page.screenshot({ path: "/tmp/opencraft-url-presentation.png" });

  await page.evaluate(() => {
    (window as any).setStreaming(true);
    (window as any).setUrl("https://stream.example.test/partial");
  });
  await page.waitForFunction(() => document.querySelector(".chat-external-link")?.getAttribute("aria-busy") === "true");
  assert.equal(await link.getAttribute("href"), null);
  assert.equal(await page.locator(".chat-external-link__icon img").count(), 0);
  await page.waitForFunction(() => document.querySelector(".chat-external-link")?.getAttribute("href") === "https://stream.example.test/partial");
  await page.locator(".chat-external-link__icon img.is-loaded").waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", headingPreserved: true, faviconFallback: true, streamingSafetyMs: 500 }));
} finally {
  await browser?.close();
  await vite.close();
}
