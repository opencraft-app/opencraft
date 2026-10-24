import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const before = process.argv.includes("--record-before");
const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/composer-add-menu";
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "add-menu-layout", configureServer(server) { server.middlewares.use((req, res, next) => {
  if (!req.url?.startsWith("/?")) return next();
  res.setHeader("content-type", "text/html");
  res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>');
}); } }] });
await vite.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
const cases = before ? [{ width: 390, touch: true, newera: true, mode: "light", palette: "neutral", reduce: false }] : [
  ...[320, 390, 430].flatMap(width => ["light", "dark"].map(mode => ({ width, touch: true, newera: true, mode, palette: "neutral", reduce: false }))),
  ...["light", "dark"].flatMap(mode => [
    { width: 1280, touch: false, newera: true, mode, palette: "neutral", reduce: false },
    { width: 390, touch: true, newera: false, mode, palette: "neutral", reduce: false },
    { width: 390, touch: true, newera: true, mode, palette: "neutral", reduce: true },
    { width: 390, touch: true, newera: true, mode, palette: "lavender", reduce: false },
  ]),
];
try {
  for (const test of cases) {
    const label = Object.values(test).join("-");
    const context = await browser.newContext({ viewport: { width: test.width, height: 844 }, hasTouch: test.touch, isMobile: test.touch, reducedMotion: test.reduce ? "reduce" : "no-preference" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`${vite.resolvedUrls!.local[0]}?addMenu&pickerFocus&mode=${test.mode}&palette=${test.palette}`);
    await page.waitForFunction(() => typeof (window as any).setTouch === "function");
    await page.evaluate(async ({ touch, newera }) => { await (window as any).setTouch(touch); await (window as any).setNewera(newera); }, test);
    const editor = page.locator(".opencraft-composer-editor"), shell = page.locator(".opencraft-composer-shell");
    const add = page.locator(".opencraft-composer-footer__attachment > button").first();
    const menu = page.locator(".opencraft-composer-add-menu"), outside = page.getByLabel("Outside input");
    const activate = async (target: any) => test.touch ? target.tap() : target.click();
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await outside.focus(); await settle();
    await editor.evaluate(el => (window as any).keptEditor = el);
    const initial = await shell.boundingBox(), anchor = await add.boundingBox(); assert(initial && anchor);
    const stable = async () => { await settle(); assert.deepEqual(await shell.boundingBox(), initial, `${label}: empty auxiliary menu must not resize composer`); assert.deepEqual(await add.boundingBox(), anchor, `${label}: menu anchor must not move`); };
    await activate(add); await menu.waitFor(); await settle();
    const opened = await shell.boundingBox();
    if (before) {
      assert(opened && opened.height > initial.height + 20, "baseline must reproduce empty Add expanding two rows");
      await page.screenshot({ path: `${output}/before.png` });
      evidence.push({ label, initial, opened, reproduced: true }); await context.close(); continue;
    }
    await stable();
    await activate(menu.getByText("连接器", { exact: true }));
    await page.getByRole("menuitem", { name: "Fixture connector", exact: true }).waitFor(); await stable();
    await page.keyboard.press("Escape"); await stable();
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await stable();
    assert(await add.evaluate(el => el === document.activeElement), "Escape restores the original Add trigger");
    await add.focus(); await page.keyboard.press("Enter"); await menu.waitFor(); await stable();
    assert(await menu.evaluate(el => el.contains(document.activeElement)), "Radix retains keyboard menu focus");
    await page.keyboard.press("ArrowDown"); await stable();
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await stable();
    await activate(add); await menu.waitFor(); await activate(outside); await menu.waitFor({ state: "hidden" }); await stable();
    // Existing dialog continuation runs after close; cleanup must not steal its focus.
    await activate(add); await menu.waitFor(); await activate(menu.getByText("设定持续目标", { exact: true }));
    await menu.waitFor({ state: "hidden" }); await stable();
    assert(await outside.evaluate(el => el === document.activeElement));
    // Empty editor focus stays compact; actual draft content owns expansion.
    await editor.focus(); await page.waitForTimeout(220);
    const editing = await shell.boundingBox(); assert(editing);
    assert.deepEqual(editing, initial);
    await activate(add); await menu.waitFor(); await settle(); assert.deepEqual(await shell.boundingBox(), editing);
    await activate(menu.getByText("连接器", { exact: true })); await page.getByRole("menuitem", { name: "Fixture connector", exact: true }).waitFor();
    assert.deepEqual(await shell.boundingBox(), editing, "nested menu retains the existing editing session");
    await activate(outside); await menu.waitFor({ state: "hidden" }); await stable();
    // An old edit must not make a later Add opening expand again.
    await activate(add); await menu.waitFor(); await stable(); await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" }); await stable();
    await editor.fill("保留当前草稿"); await page.waitForTimeout(220);
    await editor.evaluate(el => { const text = el.querySelector("p")!.firstChild!; const range = document.createRange(); range.setStart(text, 2); range.collapse(true); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    const draft = await shell.boundingBox(); await activate(add); await menu.waitFor(); await settle(); assert.deepEqual(await shell.boundingBox(), draft);
    await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
    assert.equal(await editor.innerText(), "保留当前草稿");
    assert.equal(await editor.evaluate(el => el === (window as any).keptEditor), true);
    await editor.fill(""); await outside.focus(); await settle(); await stable();
    await activate(add); await menu.waitFor(); await stable();
    if (test.width === 390 && test.newera && !test.reduce) await page.screenshot({ path: `${output}/${label}.png` });
    await page.keyboard.press("Escape"); assert.deepEqual(errors, []);
    evidence.push({ label, initial, opened, editing, editorRetained: true, errors });
    console.log("PASS", label); await context.close();
  }
  await writeFile(`${output}/${before ? "before" : "after"}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ baseline: before, cases: evidence.length, passed: true }));
} finally { await browser.close(); await vite.close(); }
