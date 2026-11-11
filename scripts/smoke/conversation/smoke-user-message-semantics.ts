import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

// Run with an installed Playwright module and Chrome/Chromium binary; use
// OPENCRAFT_PLAYWRIGHT_MODULE and OPENCRAFT_CHROMIUM_EXECUTABLE when external.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT_DIR ?? "/tmp";
await mkdir(output, { recursive: true });
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
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/${theme === "dark" ? "?dark" : ""}`, { waitUntil: "domcontentloaded" });
    const example = (id: string) => page.locator(`[data-case="${id}"]`);
    await example("bridge-admission").getByText("Accepted; context not yet confirmed", { exact: true }).waitFor();
    assert.equal(await example("bridge-unknown").getByText("Delivery unconfirmed", { exact: true }).count(), 1);
    await example("bridge-confirmed").getByText("Input confirmed in task context", { exact: true }).waitFor();
    assert.equal(await example("bridge-admission").getByText("Input confirmed in task context", { exact: true }).count(), 0);
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
    for (const id of ["sending", "steer-pending", "steer-accepted", "steer-cancelled", "steer-declined"]) {
      assert.equal(await example(id).locator(".thread-user-message__status-row").count(), 0, id);
    }
    const first = example("first-submission");
    const firstSender = first.locator(".thread-user-message__sender");
    const firstBubble = first.locator("[data-user-message-bubble]");
    assert.equal(await firstSender.innerText(), "alice", "sender is present before creation finishes");
    assert.equal(await first.locator(".thread-user-message__status-row").count(), 0);
    await first.scrollIntoViewIfNeeded();
    const firstGeometry = [await firstSender.boundingBox(), await firstBubble.boundingBox()];
    await first.screenshot({ path: `${output}/first-message-${width}-${theme}-pending.png` });
    for (const [method, phase] of [["handoff", "handoff"], ["acknowledge", "confirmed"]]) {
      await page.evaluate(method => (window as any).firstSubmissionFixture[method](), method);
      await page.waitForFunction(phase => document.querySelector('[data-case="first-submission"]')?.getAttribute("data-phase") === phase, phase);
      assert.equal(await firstSender.innerText(), "alice", "account changes do not rewrite the sender");
      assert.deepEqual([await firstSender.boundingBox(), await firstBubble.boundingBox()], firstGeometry,
        `first-message geometry remains stable through ${phase}`);
      await first.screenshot({ path: `${output}/first-message-${width}-${theme}-${phase}.png` });
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
    await page.screenshot({ path: `${output}/opencraft-user-message-semantics-${width}-${theme}.png`, fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: four user-message rendering scenarios; wrapped Goal/review, copy, empty/status/attachment visibility, file/context navigation, image viewer and sender ownership");
} finally {
  await browser?.close();
  await vite.close();
}
