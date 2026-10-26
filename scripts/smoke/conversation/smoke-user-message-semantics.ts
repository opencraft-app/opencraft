import assert from "node:assert/strict";
import { createServer } from "vite";

// Run with an installed Playwright module and Chrome/Chromium binary; use
// OPENCRAFT_PLAYWRIGHT_MODULE and OPENCRAFT_CHROMIUM_EXECUTABLE when external.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-user-message-semantics-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "user-message-semantics-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/user-message-semantics.tsx"></script></body></html>');
      });
    },
  }],
});

let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const errors: string[] = [];
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, reducedMotion: "reduce", hasTouch: width === 390, isMobile: width === 390 });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript({ content: `Object.defineProperty(navigator, "clipboard", { value: { async writeText(text) { document.documentElement.dataset.copied = text; } } });` });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/${theme === "dark" ? "?dark" : ""}`);
    const example = (id: string) => page.locator(`[data-case="${id}"]`);
    await example("goal").locator("[data-status-kind=goal]").waitFor();
    await example("goal").locator("[data-user-message-bubble]").getByText("Ship the release", { exact: true }).waitFor();
    assert.equal(await example("goal").locator("[data-user-message-bubble]").innerText(), "Ship the release");
    assert.match(await example("goal").innerText(), /Review mode/);
    assert.doesNotMatch(await example("goal").innerText(), /private context|My request/);
    assert.equal(await example("goal").locator(".thread-user-message__sender").innerText(), "reviewer");
    const copy = example("goal").getByRole("button", { name: "Copy message", exact: true });
    const opacity = () => copy.evaluate(element => getComputedStyle(element).opacity);
    const timestamp = example("goal").locator("time");
    assert.equal(await opacity(), "0", "copy is hidden before hover or focus");
    const before = await example("goal").boundingBox();
    if (width === 390) {
      assert.equal(await timestamp.evaluate(element => getComputedStyle(element).opacity), "1", "touch timestamps retain their policy");
      await example("goal").locator("[data-user-message-bubble]").tap();
      await page.waitForFunction(element => getComputedStyle(element).opacity === "1", await copy.elementHandle());
      assert.equal(await opacity(), "1", "touch tap reveals copy");
      await example("empty").locator(".thread-user-message__no-content").tap();
      await page.waitForFunction(element => getComputedStyle(element).opacity === "0", await copy.elementHandle());
      assert.equal(await opacity(), "0", "outside tap dismisses copy");
      await example("goal").locator("[data-user-message-bubble]").tap();
      await copy.tap();
    } else {
      assert.equal(await timestamp.evaluate(element => getComputedStyle(element).opacity), "0");
      await example("goal").locator("[data-user-message-bubble]").hover();
      await page.waitForFunction(element => getComputedStyle(element).opacity === "1", await copy.elementHandle());
      assert.equal(await opacity(), "1", "hover reveals copy");
      assert.equal(await timestamp.evaluate(element => getComputedStyle(element).opacity), "1");
      await example("empty").hover();
      await page.waitForFunction(element => getComputedStyle(element).opacity === "0", await copy.elementHandle());
      assert.equal(await opacity(), "0", "leaving hides copy");
      await copy.focus();
      await page.waitForFunction(element => getComputedStyle(element).opacity === "1", await copy.elementHandle());
      assert.equal(await opacity(), "1", "keyboard focus reveals copy");
      await page.keyboard.press("Enter");
    }
    assert.deepEqual(await example("goal").boundingBox(), before, "disclosure preserves footer geometry");
    await page.waitForFunction(() => document.documentElement.dataset.copied === "Ship the release");
    await example("goal").getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(await example("empty").locator(".thread-user-message__no-content").innerText(), "(No content)");
    for (const id of ["review", "prior", "image", "file", "context", "comment", "audio"]) {
      assert.equal(await example(id).locator("[data-user-message-bubble]").count(), 0, id);
    }
    assert.match(await example("prior").innerText(), /Previous context/);
    assert.equal(await example("file").locator(".thread-user-message__chip").count(), 0);
    await example("file").getByRole("button").click();
    await page.waitForFunction(() => document.documentElement.dataset.opened === "file:///workspace/index.ts");
    await example("context").getByRole("button", { name: "/review", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.opened === "file:///skills/review/SKILL.md");
    assert.equal(await example("failed").locator("[data-status-kind=failed]").count(), 1);
    assert.equal(await example("sending").locator("[data-status-kind]").count(), 0);
    assert.match(await example("steer-pending").innerText(), /Waiting for the current step to finish/);
    assert.match(await example("steer-accepted").innerText(), /Added to the current response/);
    assert.match(await example("steer-cancelled").innerText(), /Cancelled/);
    for (const state of ["pending", "accepted", "cancelled"]) {
      const row = example(`steer-${state}`).locator(`[data-status-kind="steer-${state}"]`);
      assert.equal(await row.count(), 1);
      assert.ok(await row.isVisible());
      const rect=await row.boundingBox(); await page.screenshot({path:`/tmp/opencraft-user-message-steer-${width}-${theme}.png`,fullPage:true});
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width, JSON.stringify({width,theme,state,rect}));
    }
    assert.match(await example("comment").innerText(), /1 comment/);
    assert.equal(await example("audio").locator("audio").count(), 1);
    await example("image").locator("[data-user-message-image-row] button").click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const senderBox = await example("goal").locator(".thread-user-message__sender").boundingBox();
    const bubbleBox = await example("goal").locator("[data-user-message-bubble]").boundingBox();
    assert.ok(senderBox && bubbleBox && senderBox.y + senderBox.height <= bubbleBox.y);
    await page.screenshot({ path: `/tmp/opencraft-user-message-semantics-${width}-${theme}.png`, fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: four user-message rendering scenarios; wrapped Goal/review, copy, empty/status/attachment visibility, file/context navigation, image viewer and sender ownership");
} finally {
  await browser?.close();
  await vite.close();
}
