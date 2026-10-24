import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const built = await build({ entryPoints: ["tests/fixtures/embedded-browser-navigation.tsx"], bundle: true,
  write: false, format: "esm", platform: "browser", jsx: "automatic", loader: { ".scss": "empty", ".css": "empty" } });
const server = createServer((req, res) => {
  res.setHeader("content-type", req.url === "/fixture.js" ? "text/javascript" : "text/html");
  res.end(req.url === "/fixture.js" ? built.outputFiles[0]!.contents : '<!doctype html><div id="root"></div><div id="surfaces"></div><script type="module" src="/fixture.js"></script>');
});
await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
  args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
try {
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const context = await browser.newContext();
  await context.route("**/*", route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.fulfill({ contentType: "text/html", body: "<title>Synthetic guest</title><p>Guest fixture</p>" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const snapshot = () => page.evaluate(() => (window as any).__browserFixture.snapshot());
  const checkDraft = async () => {
    assert.equal(page.url(), `${origin}/`);
    assert.equal(await page.getByRole("textbox", { name: "Conversation draft" }).inputValue(), "Keep my unsent draft");
  };
  const externalClick = async (label: string, options = {}) => {
    const before = await snapshot();
    const popupEvent = context.waitForEvent("page");
    await page.getByRole("link", { name: label, exact: true }).click(options);
    const popup = await popupEvent;
    await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    await popup.close();
    assert.deepEqual(await snapshot(), before);
    await checkDraft();
  };
  await externalClick("external");
  assert.equal(await page.locator("iframe").count(), 0);
  await externalClick("lookalike");
  await externalClick("external", { modifiers: ["Control"] });
  await externalClick("external", { button: "middle" });
  const menuPopupEvent = context.waitForEvent("page");
  await page.getByRole("link", { name: "external", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in browser", exact: true }).click();
  const menuPopup = await menuPopupEvent;
  await menuPopup.waitForLoadState();
  assert.equal(menuPopup.url(), "https://example.org/away");
  await menuPopup.close();
  assert.equal(await page.locator("iframe").count(), 0);
  await page.getByRole("link", { name: "allowed", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe[src="https://workbench.example/preview"]') !== null);
  await page.getByRole("link", { name: "subdomain", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('iframe[src="https://preview.workbench.example/app"]') !== null);
  // Observe completed real iframe loads before taking the no-navigation
  // baseline. Their onload revisions are unrelated to the next external URL.
  await page.waitForFunction(() => {
    const { pages } = (window as any).__browserFixture.snapshot();
    return pages.length === 2 && pages.every((page: any) => !page.navigation.isLoading);
  });
  const before = await snapshot();
  const popupEvent = context.waitForEvent("page");
  await page.getByRole("textbox", { name: "Browser address" }).fill("https://example.org/address");
  await page.getByRole("button", { name: "Navigate" }).click();
  const popup = await popupEvent;
  await popup.waitForLoadState();
  assert.equal(popup.url(), "https://example.org/address");
  await popup.close();
  assert.deepEqual(await snapshot(), before);
  assert.equal(await page.locator("iframe").count(), 2);
  await checkDraft();
  assert.deepEqual(errors, []);
  console.log("PASS embedded real link clicks (normal/Ctrl/middle/context menu), lookalike domains, two allowed iframe destinations, address navigation, opener isolation and retained draft");
  // Current Page/Tab metadata is seeded. Real owners must restore it,
  // retain IDs across reload, and keep closed resources closed.
  const restored = await context.newPage();
  const restoreErrors: string[] = []; restored.on("pageerror", error => restoreErrors.push(error.message));
  await restored.goto(origin);
  await restored.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("opencraft.browser-pages.v1", JSON.stringify([{
      id: "retained-page", ownerId: "conversation-fixture", hostId: "fixture-host", createdAt: 1,
      entries: [{ url: "https://workbench.example/retained", title: "Retained page" }], index: 0,
    }]));
    localStorage.setItem("opencraft.browser-tabs.v1", JSON.stringify([{
      id: "retained-tab", pageId: "retained-page", ownerId: "conversation-fixture", createdAt: 1,
    }]));
  });
  await restored.reload();
  await restored.waitForFunction(() => (window as any).__browserFixture?.snapshot().tabs.length === 1);
  assert.equal(await restored.locator("iframe").count(), 0, "restoring metadata cannot create a physical surface");
  assert.equal(await restored.evaluate(() => (window as any).__browserFixture.snapshot().tabs[0].tab.id), "retained-tab");
  await restored.evaluate(() => (window as any).__browserFixture.openRetained());
  await restored.locator('iframe[src="https://workbench.example/retained"]').waitFor();
  assert.equal(await restored.frameLocator('iframe[src="https://workbench.example/retained"]').locator('p').innerText(), "Guest fixture");
  await restored.reload();
  await restored.waitForFunction(() => (window as any).__browserFixture?.snapshot().tabs.length === 1);
  await restored.evaluate(() => (window as any).__browserFixture.closeRetained());
  assert.deepEqual(await restored.evaluate(() => [localStorage.getItem("opencraft.browser-pages.v1"), localStorage.getItem("opencraft.browser-tabs.v1")]), ["[]", "[]"]);
  await restored.reload();
  await restored.waitForFunction(() => (window as any).__browserFixture !== undefined);
  assert.equal(await restored.evaluate(() => (window as any).__browserFixture.snapshot().tabs.length), 0);
  assert.equal(await restored.locator("iframe").count(), 0);
  assert.deepEqual(restoreErrors, []);
  console.log("PASS current Page/Tab metadata, stable IDs on reload, lazy real iframe, and no closed-resource revival");
  await restored.close();
} finally { await browser.close(); await new Promise<void>(ok => server.close(() => ok())); }
