import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const before = process.argv.includes("--record-before"), output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? ".local/dictation-layout";
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "dictation-layout", configureServer(server) { server.middlewares.use((req, res, next) => {
 if (!req.url?.startsWith("/?")) return next();
 res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/touch-newera.tsx"></script>');
}); } }] });
await vite.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
const evidence: unknown[] = [];
const cases = before ? [{ width: 390, touch: true, newera: true, mode: "light", reduce: false }] : [
 ...[320, 390, 430].flatMap(width => ["light", "dark"].map(mode => ({ width, touch: true, newera: true, mode, reduce: false }))),
 ...["light", "dark"].flatMap(mode => [
  { width: 1280, touch: false, newera: true, mode, reduce: false },
  { width: 390, touch: true, newera: false, mode, reduce: false },
  { width: 390, touch: true, newera: true, mode, reduce: true },
 ]),
];
try {
 for (const test of (process.argv.includes("--reduced-only") ? cases.filter(c => c.reduce) : cases)) {
  const label = Object.values(test).join("-"), compact = test.touch && test.newera;
  const context = await browser.newContext({ viewport: { width: test.width, height: 844 }, hasTouch: test.touch, isMobile: test.touch, reducedMotion: test.reduce ? "reduce" : "no-preference" });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message)); await page.addInitScript("window.__name=value=>value");
  await page.goto(`${vite.resolvedUrls!.local[0]}?dictation&pickerFocus&addMenu&mode=${test.mode}`);
  await page.waitForFunction(() => typeof (window as any).setTouch === "function");
  await page.evaluate(async ({ touch, newera }) => { await (window as any).setTouch(touch); await (window as any).setNewera(newera); }, test);
  const editor = page.locator(".opencraft-composer-editor"), shell = page.locator(".opencraft-composer-shell"), mic = page.locator(".opencraft-voice-input-action"), voice = page.locator(".opencraft-composer-voice-footer"), outside = page.getByLabel("Outside input");
  const activate = async (target: any) => test.touch ? target.tap() : target.click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const call = (method: string, argument?: any) => page.evaluate(({ method, argument }) => (window as any).dictationFixture[method](argument), { method, argument });
  // Safari-style pointer activation: tapping the mic need not focus it.
  await mic.evaluate(el => el.addEventListener("pointerdown", event => event.preventDefault()));
  await outside.focus(); await settle(); await editor.evaluate(el => (window as any).keptEditor = el);
  const initial = await shell.boundingBox(); assert(initial);
  await activate(mic); await voice.waitFor(); await settle();
  const started = await shell.boundingBox(); assert(started);
  if (before) { assert(started.height > initial.height + 20); await page.screenshot({ path: `${output}/before.png` }); evidence.push({ label, initial, started, reproduced: true }); await context.close(); continue; }
  const stable = async (expected = initial) => { await settle(); const actual = await shell.boundingBox(); if (JSON.stringify(actual) !== JSON.stringify(expected)) console.log("GEOMETRY_DIAGNOSTIC", await page.evaluate(() => ({ active: document.activeElement?.outerHTML, root: document.querySelector(".opencraft-composer-stack")?.outerHTML.slice(0,500), voice: (window as any).composerController.getInputInteractionSnapshot()?.phase, snapshot:(window as any).composerController.getSnapshot(), editor: document.querySelector(".opencraft-composer-editor")?.innerHTML, animations: document.querySelector(".opencraft-composer-shell")?.getAnimations().map(a => ({ id:a.id, state:a.playState })) }))); assert.deepEqual(actual, expected, `${label}: recording phase must retain shell geometry`); };
  const controls = async () => {
   const bounds = await shell.boundingBox(); assert(bounds);
   for (const button of await voice.locator("button").all()) {
    const box = await button.boundingBox(); assert(box);
    assert(box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1);
    assert(box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height + 1);
    if (test.touch) assert(box.width >= 43.9 && box.height >= 43.9, `${label}: ${await button.getAttribute("aria-label")} must retain touch target, got ${JSON.stringify(box)}`);
   }
   assert.equal(await editor.getAttribute("contenteditable"), "false");
   assert.equal(await editor.evaluate(el => el === document.activeElement), false, "reserving dictation must not enter text editing");
  };
  await stable(); await controls(); assert.equal(await voice.getAttribute("data-voice-phase"), "starting");
  await call("ready"); await page.waitForFunction(() => document.querySelector('.opencraft-composer-voice-footer')?.getAttribute('data-voice-phase') === 'listening');
  await call("level", 0.5); await stable(); await controls();
  await activate(page.getByRole("button", { name: "停止并写入文字", exact: true })); await stable(); await controls();
  assert.equal(await voice.getAttribute("data-voice-phase"), "transcribing");
  await call("fail"); await stable(); assert.equal(await voice.getAttribute("data-voice-phase"), "failed");
  await activate(page.getByRole("button", { name: "重试语音识别", exact: true })); await stable(); await controls();
  await page.screenshot({ path: `${output}/${label}.png` });
  await activate(page.getByRole("button", { name: "取消语音输入", exact: true })); await voice.waitFor({ state: "hidden" }); await stable();
  assert(await mic.evaluate(el => el === document.activeElement), "cancel returns to microphone"); assert.equal((await editor.innerText()).trim(), "");
  await mic.focus(); await page.keyboard.press("Enter"); await voice.waitFor(); await stable();
  await page.keyboard.press("Escape"); await voice.waitFor({ state: "hidden" }); await stable(); assert(await mic.evaluate(el => el === document.activeElement));
  const mb = await mic.boundingBox(); assert(mb);
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2); await page.mouse.down(); await page.waitForTimeout(180); await voice.waitFor(); await stable();
  await call("ready"); await page.mouse.up(); await stable(); assert.equal(await voice.getAttribute("data-voice-phase"), "transcribing");
  await activate(page.getByRole("button", { name: "取消语音输入", exact: true })); await voice.waitFor({ state: "hidden" }); await stable();
  await activate(mic); await voice.waitFor(); await call("ready"); await activate(page.getByRole("button", { name: "停止并写入文字", exact: true }));
  await call("complete"); await voice.waitFor({ state: "hidden" }); await page.waitForTimeout(220);
  assert.equal(await editor.innerText(), "识别后的文字"); if (!await editor.evaluate(el => el === document.activeElement)) console.log("FINAL_FOCUS_DIAGNOSTIC", await page.evaluate(() => ({ active:document.activeElement?.tagName, root:document.querySelector(".opencraft-composer-stack")?.outerHTML.slice(0,600), editorStyle:getComputedStyle(document.querySelector(".opencraft-composer-editor")!).visibility, editable:document.querySelector(".opencraft-composer-editor")?.getAttribute("contenteditable") })));
  assert(await editor.evaluate(el => el === document.activeElement), `${label}: final text focuses editor`);
  const edited = await shell.boundingBox(); assert(edited); if (compact) assert(edited.height > initial.height + 20);
  await activate(mic); await voice.waitFor(); await stable(edited); await controls();
  await activate(page.getByRole("button", { name: "取消语音输入", exact: true })); await voice.waitFor({ state: "hidden" }); await stable(edited); assert.equal(await editor.innerText(), "识别后的文字");
  assert.equal(await editor.evaluate(el => el === (window as any).keptEditor), true);
  await editor.focus(); await page.keyboard.press("ControlOrMeta+a"); await page.keyboard.press("Backspace"); await outside.focus(); await stable();
  await editor.focus(); await page.waitForTimeout(220); const focused = await shell.boundingBox(); assert(focused);
  await activate(mic); await voice.waitFor(); await stable(focused);
  await activate(page.getByRole("button", { name: "取消语音输入", exact: true })); await voice.waitFor({ state: "hidden" }); await stable(focused);
  await outside.focus(); await activate(mic); await voice.waitFor(); await call("ready");
  const send = page.getByRole("button", { name: "识别完成后发送", exact: true });
  assert(await send.isEnabled()); await activate(send); await settle();
  assert.deepEqual(await page.evaluate(() => (window as any).dictationFixture.submitted), [], "send waits for final ASR");
  await call("complete", "最终语音");
  await page.waitForFunction(() => (window as any).dictationFixture.submitted.length === 1);
  assert.deepEqual(await page.evaluate(() => (window as any).dictationFixture.submitted), ["最终语音"]);
  assert.deepEqual(errors.filter(message => message !== "ResizeObserver loop completed with undelivered notifications."), []);
  evidence.push({ label, initial, started, edited, controlsReachable: true, editorRetained: true, errors }); console.log("PASS", label); await context.close();
 }
 await writeFile(`${output}/${before ? "before" : "after"}.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ before, cases: evidence.length, passed: true }));
} finally { await browser.close(); await vite.close(); }
