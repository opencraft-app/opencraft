import assert from "node:assert/strict";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-hermes-approval-smoke", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "hermes-approval-smoke", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/") return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/hermes-approval.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 740 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const card = page.locator(".thread-approval-request");
  await card.waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => (window as any).approvalActions), []);
  await card.getByRole("button", { name: "Always allow", exact: true }).focus();
  await card.getByRole("button", { name: "Always allow", exact: true }).press("Enter");
  assert.deepEqual(await page.evaluate(() => (window as any).approvalActions), [], "first press is confirmation, not authorization");
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).approvalActions), []);
  await card.getByRole("button", { name: "Always allow", exact: true }).click();
  await card.getByRole("button", { name: "Confirm always allow", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).approvalActions), [{ type: "approve-always" }]);
  await page.evaluate(() => (window as any).setApprovalScopes(["once", "deny"]));
  await card.getByRole("button", { name: "Always allow", exact: true }).waitFor({ state: "detached" });
  await card.locator("summary").waitFor({ state: "detached" });
  assert.equal(await card.locator("summary").count(), 0);
  await card.getByRole("button", { name: /Allow once/ }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).approvalActions), [{ type: "approve-always" }, { type: "approve-once" }]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", realApprovalCard: true, idleWait: true, permanentConfirmation: true, allowedScopes: true, mobileWidth: true }));
} finally { await browser?.close(); await vite.close(); }
