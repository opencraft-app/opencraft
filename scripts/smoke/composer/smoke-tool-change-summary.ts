import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/opencraft-tool-summary";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "tool-summary-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/turn-diff-layout.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const width of [390, 1280])
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 844 },
        hasTouch: width === 390,
        reducedMotion: "reduce",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript("window.__name=value=>value");
      await page.goto(vite.resolvedUrls!.local[0]! + `?floatingSummary=1&shellPresentation=1&theme=${theme}`);
      const entry = page.locator(".thread-live-changes");
      await entry.waitFor();
      const original = await entry.innerText();
      assert.match(original, /files changed/);
      await page.getByRole("button", { name: "tools", exact: true }).click();
      await entry.waitFor({ state: "detached" });
      assert.equal(await page.getByRole("button", { name: "View changes", exact: true }).count(), 0);
      await page.screenshot({ path: `${output}/tools-${width}-${theme}.png` });
      await page.getByRole("button", { name: "split", exact: true }).click();
      await entry.waitFor();
      assert.equal(await entry.innerText(), original);
      await page.getByRole("button", { name: "chat", exact: true }).click();
      assert.equal(await entry.innerText(), original);
      await page.screenshot({ path: `${output}/chat-${width}-${theme}.png` });
      assert.deepEqual(errors, []);
      console.log("PASS", width, theme, "tools hidden; split and chat restored");
      await page.close();
    }
} finally {
  await browser?.close();
  await vite.close();
}
