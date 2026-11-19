import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  cacheDir: ".local/vite-queue-markdown",
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    entries: ["tests/fixtures/queue-markdown-preview.tsx"],
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
  },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "queue-markdown-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/queue-markdown-preview.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
  });
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1280, height: 720 },
      hasTouch: touch,
      isMobile: touch,
    });
    const page = await context.newPage(),
      errors: string[] = [];
    await page.route("https://*.gstatic.com/**", (route) => route.abort());
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("PAGE_ERROR", e.message);
    });
    page.on("response", (r) => {
      if (r.status() >= 400) console.error("HTTP", r.status(), r.url());
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/`);
    const trigger = page.locator(".opencraft-composer-queue-item__preview-trigger");
    await trigger.waitFor();
    assert.match(await trigger.innerText(), /Invite members Read docs and a_b/);
    assert.doesNotMatch(await trigger.innerText(), /private-path|\*\*/);
    if (touch) await trigger.tap();
    else await trigger.click();
    const body = page.locator(".opencraft-composer-queue-message-text");
    await body.waitFor();
    await page.getByText("Invite members", { exact: true }).last().waitFor();
    assert.deepEqual(errors, []);
    await page.keyboard.press("Escape");
    await body.waitFor({ state: "hidden" });
    assert.equal(await page.getByLabel("Draft").inputValue(), "keep draft");
    await context.close();
  }
  console.log("QUEUE_MARKDOWN_SMOKE_OK desktop+touch");
} finally {
  await browser?.close();
  await vite.close();
}
