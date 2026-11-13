import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "@playwright/test";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp";
const server = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-native-session-recovery",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "native-session-recovery", configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-presentation.tsx"></script>');
    });
  } }],
});
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
try {
  for (const touch of [false, true]) for (const theme of ["light", "dark"] as const) {
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1100, height: 844 },
      hasTouch: touch, isMobile: touch, reducedMotion: "reduce",
    });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.waitForFunction(() => typeof (window as any).scenario === "function");
    await page.evaluate(theme => {
      (window as any).theme(theme);
      (window as any).scenario("native-busy");
    }, theme);
    const card = page.locator(".thread-system-error--native-session");
    const button = card.getByRole("button", { name: "Continue in a new conversation", exact: true });
    await button.waitFor();
    const bounds = await button.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= (touch ? 390 : 1100));
    await page.screenshot({ path: `${output}/native-session-${touch ? "touch" : "desktop"}-${theme}.png` });
    if (touch) await button.tap();
    else { await button.focus(); await page.keyboard.press("Enter"); }
    assert.equal(await card.getByRole("button").isDisabled(), true);
    assert.equal(await page.evaluate(() => (window as any).forks), 1);
    await page.evaluate(() => (window as any).failFork(new Error("Lost creation acknowledgement")));
    await card.getByText(/Could not confirm the new branch/).waitFor();
    assert.equal(await card.getByRole("button").isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Native lock recovery: keyboard/touch, light/dark, pending and unconfirmed creation passed.");
} finally {
  await browser.close();
  await server.close();
}
