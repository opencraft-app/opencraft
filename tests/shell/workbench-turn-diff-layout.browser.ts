import assert from "node:assert/strict";
import gitCases from "../fixtures/turn-diff-git-cases.json";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-turn-diff-layout",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "turn-diff-layout", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/turn-diff-layout.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const results = [];
  for (const width of [320, 390, 768, 1200]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1600 }, hasTouch: width < 768, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    const card = page.locator(".thread-turn-diff");
    await card.waitFor();
    const rows = card.locator("button[aria-label^='Open ']");
    assert.equal(await rows.count(), 3);
    await card.locator(".thread-turn-diff__more").click();
    assert.equal(await rows.count(), 5);
    const geometries = await rows.evaluateAll((nodes: Element[]) => nodes.map(row => {
      const path = row.querySelector(".thread-turn-diff__path")!;
      const name = path.querySelector("b")!;
      const stats = row.querySelector(".thread-turn-diff__stats")!;
      const a = path.getBoundingClientRect(), b = name.getBoundingClientRect(), c = stats.getBoundingClientRect();
      return { label: row.getAttribute("aria-label"), text: name.textContent,
        pathLeft: a.left, pathRight: a.right, nameRight: b.right, statsLeft: c.left,
        statsRight: c.right, rowRight: row.getBoundingClientRect().right,
        statsWidth: c.width, statsScrollWidth: stats.scrollWidth,
        basenameOverflow: getComputedStyle(name).overflowX,
        clipped: name.scrollWidth > name.clientWidth };
    }));
    for (const g of geometries) {
      assert(g.nameRight <= g.pathRight + 0.5, `${g.text} stays within the path slot`);
      assert(g.pathRight + 7 <= g.statsLeft, `${g.text} retains the gap before counts`);
      assert(g.statsRight <= g.rowRight, "counts remain inside the row");
      assert(g.statsScrollWidth <= Math.ceil(g.statsWidth), "counts remain complete");
      assert.equal(g.basenameOverflow, "hidden");
      assert(g.label?.endsWith(g.text!), "accessible label preserves the full basename");
    }
    assert(geometries[3]!.clipped, "extreme basename is truncated rather than overflowing");
    if (width === 390) {
      const oldRules = await page.addStyleTag({ content: ".thread-turn-diff__path>b{max-width:none;overflow:visible;text-overflow:clip;white-space:normal}" });
      assert(await rows.first().evaluate(row => row.querySelector(".thread-turn-diff__path>b")!.getBoundingClientRect().right > row.querySelector(".thread-turn-diff__stats")!.getBoundingClientRect().left), "negative control reproduces original overlap");
      await oldRules.evaluate(node => node.remove());
    }
    await rows.nth(3).click();
    assert.equal(await page.locator("html").getAttribute("data-review-path"), geometries[3]!.label!.slice(5));
    await card.locator(".thread-turn-diff__more").click();
    assert.equal(await rows.count(), 3);
    assert.deepEqual(errors, []);
    results.push({ width, theme, files: geometries.length, countsIntact: true, fullPathReview: true });
    await page.close();
  }
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1200 }, hasTouch: width === 390, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    const activate = async (button: any) => width === 390 ? button.tap() : button.click();
    const open = async (name: string) => {
      await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&gitCase=${name}`);
      await page.locator('html[data-conversation-ready="true"]').waitFor();
      const card = page.locator(".thread-turn-diff");
      await card.waitFor();
      return card;
    };
    for (const entry of gitCases) {
      const card = await open(entry.name);
      const expected = entry.expected;
      assert.equal(await card.locator(".thread-turn-diff__default-subtitle .thread-turn-diff__stats").getAttribute("aria-label"),
        `${expected.additions} lines added, ${expected.deletions} lines removed`);
      await activate(card.getByRole("button", { name: "View changes", exact: true }));
      assert.equal(await page.locator("html").getAttribute("data-review-path"), expected.files[0]!.path);
      assert.equal(await page.locator("html").getAttribute("data-review-diff"), entry.diff);
    }
    const card = await open("all");
    await activate(card.locator(".thread-turn-diff__more"));
    const rows = card.locator("button[aria-label^='Open ']");
    assert.equal(await rows.count(), gitCases.length);
    for (const entry of gitCases) {
      const path = entry.expected.files[0]!.path;
      await activate(card.getByRole("button", { name: `Open ${path}`, exact: true }));
      assert.equal(await page.locator("html").getAttribute("data-review-path"), path);
      assert.equal((await page.locator("html").getAttribute("data-review-diff"))?.trimEnd(), entry.diff.trimEnd());
    }
    assert.deepEqual(errors, []);
    results.push({ width, theme, files: gitCases.length, countsIntact: true, fullPathReview: true });
    await page.close();
  }
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) for (const gitCase of ["operators", "all"]) {
    const page = await browser.newPage({ viewport: { width, height: 1200 }, hasTouch: width === 390, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&gitCase=${gitCase}&review=1`);
    const activate = async (button: any) => width === 390 ? button.tap() : button.click();
    await activate(page.locator(".thread-turn-diff").getByRole("button", { name: "View changes", exact: true }));
    const dialog = page.getByRole("dialog", { name: "Review changed files" });
    await dialog.waitFor();
    assert.equal(await dialog.locator('[data-diff-line="context"]').count(), 0, "actual Git fixtures contain no context lines; metadata and separators get no fabricated numbers");
    if (gitCase === "all") await activate(dialog.getByRole("button", { name: "operators.cpp", exact: true }));
    const changed = dialog.locator('[data-diff-line="deletion"], [data-diff-line="addition"]');
    assert.deepEqual(await changed.evaluateAll((nodes: Element[]) => nodes.map(node => ({
      kind: (node as HTMLElement).dataset.diffLine,
      cells: [...node.querySelectorAll('[role="cell"]')].map(cell => cell.textContent),
    }))), [
      { kind: "deletion", cells: ["1", "", "−", "--counter;"] },
      { kind: "deletion", cells: ["2", "", "−", "old"] },
      { kind: "addition", cells: ["", "1", "+", "++counter;"] },
      { kind: "addition", cells: ["", "2", "+", "new"] },
    ]);
    assert.deepEqual(await changed.locator('[data-diff-changed="true"]').allTextContents(), ["--", "old", "++", "new"]);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    results.push({ width, theme, files: gitCase === "all" ? gitCases.length : 1, countsIntact: true, fullPathReview: true });
    await page.close();
  }
  for (const width of [390, 1200]) for (const theme of ["light", "dark"]) for (const turnStatus of ["complete", "failed", "interrupted"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&gitCase=operators&review=1&withoutAssistant=1&turnStatus=${turnStatus}`);
    await page.getByText("Update files", { exact: true }).waitFor();
    const card = page.locator(".thread-turn-diff");
    await card.waitFor();
    assert.equal(await card.count(), 1, "the native Turn resource survives without an assistant Item");
    const open = card.getByRole("button", { name: "View changes", exact: true });
    if (width === 390) await open.tap(); else await open.click();
    const dialog = page.getByRole("dialog", { name: "Review changed files" });
    await dialog.waitFor();
    assert.equal(await page.locator("html").getAttribute("data-review-diff"), gitCases.find(entry => entry.name === "operators")!.diff);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    results.push({ width, theme, files: 1, countsIntact: true, fullPathReview: true });
    await page.close();
  }
  console.log(JSON.stringify({ passed: results }));
} finally {
  await browser?.close();
  await vite.close();
}
