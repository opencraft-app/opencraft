import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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
  optimizeDeps: { entries: ["tests/fixtures/sent-image-preview.tsx"] },
  cacheDir: "node_modules/.vite-sent-image-preview-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "sent-image-preview-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/") || request.url.split("?")[0] !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="host"></div><script type="module" src="/tests/fixtures/sent-image-preview.tsx"></script></body></html>');
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const thumbnail = page.locator("#host").getByRole("button", { name: "Open attached image" });
  await thumbnail.click();
  const dialog = page.locator("#host").getByRole("dialog", { name: "Attached image 1 of 1" });
  await dialog.waitFor({ timeout: 5_000 });
  assert.equal(await dialog.locator("img").count(), 1);
  const thumbnailBox = await thumbnail.boundingBox();
  const previewBox = await dialog.locator("img").boundingBox();
  assert.ok(thumbnailBox !== null && previewBox !== null && previewBox.width > thumbnailBox.width);
  assert.equal(await page.evaluate(() => document.body.querySelectorAll('[role="dialog"]').length), 0);
  await page.screenshot({ path: "/tmp/cn-opencraft-sent-image-preview.png" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // Real touch input through the shared image viewport inside its ShadowRoot.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await mobile.newPage();
  const mobileErrors: string[] = [];phone.on("pageerror", error => mobileErrors.push(error.message));
  await phone.addInitScript("window.__name=value=>value");
  await phone.goto(page.url());
  const trigger = phone.getByRole("button", { name: "Open attached image" });await trigger.click();
  const stage = phone.locator(".opencraft-zoomable-image");await stage.waitFor();await phone.waitForTimeout(250);
  const cdp = await mobile.newCDPSession(phone);
  const touch = async (type: string, points: number[][]) => {await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x,y],i)=>({x,y,id:i+1})) });await phone.waitForTimeout(35);};
  const matrix = () => stage.locator("img").evaluate(e => {const m=new DOMMatrixReadOnly(getComputedStyle(e).transform);return {scale:Math.hypot(m.a,m.b),angle:Math.atan2(m.b,m.a),x:m.e,y:m.f};});
  await touch("touchStart", [[145,422],[245,422]]);await touch("touchMove", [[185,422],[205,422]]);await touch("touchEnd", []);
  assert(Math.abs((await matrix()).scale-.2)<.01, "pinch can shrink below fitted size to 0.2×");
  await touch("touchStart", [[185,422],[205,422]]);await touch("touchMove", [[45,422],[345,422]]);await touch("touchEnd", []);
  assert(Math.abs((await matrix()).scale-3)<.05, "shrunk image can zoom back in");
  await touch("touchStart", [[115,422],[275,422]]);
  for(let i=1;i<=12;i++){const a=Math.PI/2*i/12;await touch("touchMove", [[195-80*Math.cos(a),422-80*Math.sin(a)],[195+80*Math.cos(a),422+80*Math.sin(a)]]);}
  await touch("touchEnd", []);const rotated=await matrix();
  assert(Math.abs(rotated.angle-Math.PI/2)<.02&&Math.abs(rotated.scale-3)<.05,"two fingers rotate 90 degrees without changing scale");
  await touch("touchStart", [[195,422]]);await touch("touchMove", [[230,470]]);await touch("touchEnd", []);
  const panned=await matrix();assert(panned.x>20&&panned.y>20,"rotated image remains draggable with rotated bounds");
  await phone.screenshot({path:process.env.OPENCRAFT_IMAGE_GESTURE_SCREENSHOT??"/tmp/opencraft-image-rotate-shrink.png"});
  await phone.keyboard.press("Escape");await trigger.click();await phone.waitForTimeout(150);
  const reset=await matrix();assert(Math.abs(reset.scale-1)<.001&&Math.abs(reset.angle)<.001&&Math.abs(reset.x)<.001&&Math.abs(reset.y)<.001,"reopening resets rotation, scale and pan");
  assert.deepEqual(mobileErrors,[]);await mobile.close();
  assert.deepEqual(errors, []);
  // Draft Composer uses the same viewport, with its own attachment and focus lifetime.
  const output = process.env.OPENCRAFT_IMAGE_PREVIEW_OUTPUT ?? "/tmp/opencraft-composer-image-preview";
  await mkdir(output, { recursive: true });
  for (const touchMode of [false, true]) for (const mode of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: touchMode ? 390 : 1280, height: 844 }, hasTouch: touchMode, isMobile: touchMode });
    const draftPage = await context.newPage();
    const draftErrors: string[] = [];
    draftPage.on("pageerror", error => draftErrors.push(error.message));
    await draftPage.addInitScript("window.__name=value=>value");
    await draftPage.goto(page.url() + `?mode=${mode}${touchMode ? "&touch" : ""}`);
    const editor = draftPage.locator(".opencraft-composer-editor");
    await editor.fill("预览后继续编辑");
    const files = [
      { name: "portrait.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="1600"><rect width="400" height="1600" fill="#245ab5"/><text x="25" y="100" fill="white" font-size="42">Portrait</text></svg>') },
      { name: "wide.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#ae5129"/><text x="50" y="270" fill="white" font-size="80">Wide image</text></svg>') },
      { name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
    ];
    const addFiles = async (selected: typeof files) => {
      const chooser = draftPage.waitForEvent("filechooser");
      await draftPage.getByRole("button", { name: "Add", exact: true }).click();
      await (await chooser).setFiles(selected);
    };
    await addFiles(files);
    const triggers = draftPage.locator(".opencraft-composer-image-attachment__preview");
    await triggers.first().waitFor();
    assert.equal(await triggers.count(), 3);
    await editor.click();
    await editor.evaluate(el => { (window as any).previewEditor = el; });
    await editor.press("Home"); await editor.press("ArrowRight"); await editor.press("ArrowRight");
    const selectionOffset = await editor.evaluate(el => (el.getRootNode() as ShadowRoot).getSelection()?.anchorOffset);
    const before = await draftPage.evaluate(() => (window as any).imagePreviewFixture.controller.getSnapshot().draft.document);
    const activate = async (target: any) => touchMode ? target.tap() : target.click();
    await activate(triggers.first());
    const preview = draftPage.locator(".opencraft-composer-image-preview");
    await preview.waitFor();
    assert.equal(await preview.locator("img").getAttribute("alt"), "portrait.svg");
    assert.equal(await draftPage.evaluate(() => document.body.querySelectorAll('[role="dialog"]').length), 0, "embedded preview portal stays in its ShadowRoot");
    await preview.locator("img").evaluate(async el => { await (el as HTMLImageElement).decode(); });
    const bounds = (await preview.locator("img").boundingBox())!;
    assert(Math.abs(bounds.height / bounds.width - 4) < .02, "portrait preview keeps original aspect ratio");
    const stage = preview.locator(".opencraft-zoomable-image");
    if (touchMode) {
      const box = (await stage.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const session = await context.newCDPSession(draftPage);
      const gesture = async (type: string, distance?: number) => {
        await session.send("Input.dispatchTouchEvent", { type, touchPoints: distance === undefined ? [] : [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }] });
      };
      await gesture("touchStart", 30); await gesture("touchMove", 60); await gesture("touchEnd");
      assert.notEqual(await stage.getAttribute("data-zoomed"), null, "preview retains shared pinch zoom");
      await session.detach();
    }
    await draftPage.evaluate(() => (window as any).imagePreviewFixture.complete());
    assert.equal(await preview.count(), 1, "upload completion does not close/reopen the preview");
    await activate(preview.getByRole("button", { name: "Next image", exact: true }));
    assert.equal(await preview.locator("img").getAttribute("alt"), "wide.svg");
    assert.equal(await stage.getAttribute("data-zoomed"), null, "image navigation resets zoom");
    await draftPage.screenshot({ path: `${output}/${touchMode ? "touch" : "desktop"}-${mode}.png` });
    await draftPage.keyboard.press("ArrowLeft");
    assert.equal(await preview.locator("img").getAttribute("alt"), "portrait.svg");
    await draftPage.keyboard.press("Escape");
    await preview.waitFor({ state: "detached" });
    await draftPage.waitForFunction(el => el === el.getRootNode().activeElement, await editor.elementHandle(), { timeout: 3000 });
    assert(await editor.evaluate(el => el === (window as any).previewEditor && el === el.getRootNode().activeElement), "pointer dismissal returns to the original editor");
    assert.deepEqual(await draftPage.evaluate(() => (window as any).imagePreviewFixture.controller.getSnapshot().draft.document), before);
    assert.equal(await editor.evaluate(el => (el.getRootNode() as ShadowRoot).getSelection()?.anchorOffset), selectionOffset);
    await triggers.nth(1).focus();
    await draftPage.keyboard.press("Enter");
    await preview.waitFor();
    await draftPage.keyboard.press("Escape");
    await preview.waitFor({ state: "detached" });
    await draftPage.waitForFunction(el => el === el.getRootNode().activeElement, await triggers.nth(1).elementHandle(), { timeout: 3000 });
    assert(await triggers.nth(1).evaluate(el => el === el.getRootNode().activeElement), "keyboard dismissal returns to invoking thumbnail");
    // Independent remove control never opens preview.
    await activate(draftPage.getByRole("button", { name: "Remove portrait.svg", exact: true }));
    assert.equal(await preview.count(), 0);
    assert.equal(await triggers.count(), 2);
    await activate(triggers.nth(1));
    await preview.getByRole("status").waitFor();
    assert.equal(await preview.getByRole("status").innerText(), "Image unavailable");
    await activate(preview.getByRole("button", { name: "Previous image", exact: true }));
    assert.equal(await preview.locator("img").getAttribute("alt"), "wide.svg");
    // Stable identity survives removing an earlier image; removing the selected closes.
    await draftPage.evaluate(() => { const c = (window as any).imagePreviewFixture.controller; c.dispatch({ type: "remove-attachment", id: c.getSnapshot().draft.attachments[1].id }); });
    assert.equal(await preview.locator("img").getAttribute("alt"), "wide.svg");
    await draftPage.evaluate(() => { const c = (window as any).imagePreviewFixture.controller; c.dispatch({ type: "remove-attachment", id: c.getSnapshot().draft.attachments[0].id }); });
    await preview.waitFor({ state: "detached" });
    await addFiles(files.slice(0, 1));
    await activate(triggers.first());
    await preview.waitFor();
    await draftPage.evaluate(() => (window as any).imagePreviewFixture.switchThread("other"));
    await preview.waitFor({ state: "detached" });
    await draftPage.evaluate(() => (window as any).imagePreviewFixture.complete());
    await draftPage.evaluate(() => (window as any).imagePreviewFixture.switchThread("images"));
    assert.equal(await preview.count(), 0, "returning to a draft does not reopen its dismissed gallery");
    await activate(triggers.first());
    await preview.waitFor();
    await draftPage.evaluate(() => (window as any).imagePreviewFixture.controller.dispatch({ type: "clear" }));
    await preview.waitFor({ state: "detached" });
    assert.equal(await draftPage.evaluate(() => (window as any).imagePreviewFixture.submissions), 0);
    // Browser-only editing uses the actual plugin View and Composer replacement port.
    const stripes = Array.from({ length: 640 }, (_, x) => `<rect x="${x}" width="1" height="480" fill="${x % 2 ? "#eef2f8" : "#223344"}"/>`).join("");
    await addFiles([{ name: "editable.svg", mimeType: "image/svg+xml", buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">${stripes}</svg>`) }]);
    await triggers.first().click();
    await draftPage.getByRole("button", { name: "Edit image", exact: true }).click();
    const canvas = draftPage.getByLabel("Image editing canvas", { exact: true });
    await canvas.waitFor();
    await draftPage.waitForFunction(() => {
      const c = document.getElementById("host")?.shadowRoot?.querySelector<HTMLCanvasElement>(".image-editor canvas");
      return c && c.width === 640 && c.getBoundingClientRect().width > 0;
    });
    const brush = async (from: number[], to: number[]) => {
      const bounds = (await canvas.boundingBox())!;
      const a = [bounds.x + bounds.width * from[0]!, bounds.y + bounds.height * from[1]!];
      const b = [bounds.x + bounds.width * to[0]!, bounds.y + bounds.height * to[1]!];
      if (touchMode) {
        const session = await context.newCDPSession(draftPage);
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: a[0], y: a[1], id: 1 }] });
        for (let i = 1; i <= 8; i++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: a[0]! + (b[0]! - a[0]!) * i / 8, y: a[1]! + (b[1]! - a[1]!) * i / 8, id: 1 }] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await session.detach();
      } else { await draftPage.mouse.move(a[0]!, a[1]!); await draftPage.mouse.down(); await draftPage.mouse.move(b[0]!, b[1]!, { steps: 8 }); await draftPage.mouse.up(); }
      await draftPage.waitForTimeout(80);
    };
    const settle = () => draftPage.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const pixel = (x: number, y: number) => canvas.evaluate((node, p) => Array.from((node as HTMLCanvasElement).getContext("2d")!.getImageData(Math.floor((node as HTMLCanvasElement).width * p[0]!), Math.floor((node as HTMLCanvasElement).height * p[1]!), 1, 1).data), [x, y]);
    if (touchMode) {
      const session = await context.newCDPSession(draftPage), box = (await canvas.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const touch = async (type: string, points: number[][]) => { await session.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([px, py], index) => ({ x: px, y: py, id: index + 1 })) }); await draftPage.waitForTimeout(30); };
      const original = await pixel(.5, .5);
      await touch("touchStart", [[x - 35, y]]);
      await touch("touchMove", [[x, y]]);
      await touch("touchStart", [[x, y], [x + 60, y]]);
      await touch("touchMove", [[x - 60, y - 20], [x + 90, y + 20]]);
      await touch("touchEnd", [[x - 60, y - 20]]);
      await touch("touchMove", [[x - 30, y - 20]]);
      await touch("touchEnd", []);
      assert.deepEqual(await pixel(.5, .5), original, "second finger cancels in-progress ink and remaining finger cannot draw");
      assert(await draftPage.getByRole("button", { name: "Undo", exact: true }).isDisabled(), "pinch/pan does not create editing history");
      const view = await draftPage.locator(".image-editor__image").evaluate(node => { const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform); return { zoom: matrix.a, x: matrix.e }; });
      assert(view.zoom > 2 && view.x !== 0, "real two-finger input zooms and pans the editor");
      await brush([.5, .4], [.6, .4]);
      assert((await pixel(.55, .4))[0]! > 200, "zoomed drawing uses native image coordinates");
      await draftPage.getByRole("button", { name: "Undo", exact: true }).click(); await settle();
      await draftPage.getByRole("button", { name: "Fit image", exact: true }).click();
      await session.detach();
    }
    await brush([.2, .25], [.8, .25]);
    const ink = await pixel(.5, .25); assert(ink[0]! > 200 && ink[1]! < 100, "pen changes actual pixels");
    await draftPage.getByRole("button", { name: "Undo", exact: true }).click(); await settle();
    assert.notDeepEqual(await pixel(.5, .25), ink, "undo restores source pixels");
    await draftPage.getByRole("button", { name: "Redo", exact: true }).click(); await settle(); assert.deepEqual(await pixel(.5, .25), ink);
    await draftPage.getByRole("button", { name: "Text", exact: true }).click();
    assert.equal(await draftPage.getByRole("textbox", { name: "Text", exact: true }).count(), 0, "text entry starts at an image position, not in toolbar");
    assert.equal(await draftPage.locator(".image-editor__feedback").count(), 0, "no permanent instructions");
    assert.equal(await draftPage.locator(".image-editor__name").count(), 0, "no filename chrome");
    await brush([.5, .5], [.5, .5]);
    const textEntry = draftPage.getByRole("textbox", { name: "Text", exact: true });
    assert(await textEntry.evaluate(node => node.closest(".image-editor__image") !== null && node === (node.getRootNode() as Document | ShadowRoot).activeElement), "tap focuses image-local native text entry");
    await textEntry.fill("直接标注\nSecond line");
    await textEntry.dispatchEvent("compositionstart", { data: "文" });
    await draftPage.getByRole("button", { name: "Apply text", exact: true }).click();
    assert.equal(await textEntry.count(), 1, "composition does not submit partial text");
    await textEntry.press("Escape");
    assert.equal(await textEntry.count(), 1, "IME Escape does not close annotation or editor");
    await textEntry.dispatchEvent("compositionend", { data: "文" });
    if (touchMode) {
      await draftPage.setViewportSize({ width: 390, height: 520 });
      await settle();
      const done = (await draftPage.getByRole("button", { name: "Done", exact: true }).boundingBox())!;
      assert(done.y + done.height <= 520, "tools remain reachable when mobile viewport shrinks for keyboard");
      assert.equal(await draftPage.getByRole("textbox", { name: "Text", exact: true }).inputValue(), "直接标注\nSecond line", "resize preserves text input");
      assert.deepEqual(await pixel(.5, .25), ink, "resize preserves committed ink");
      await draftPage.setViewportSize({ width: 390, height: 844 }); await settle();
    }
    const inputFormat = await textEntry.evaluate(node => { const style = getComputedStyle(node); return { family: style.fontFamily, weight: style.fontWeight, leading: parseFloat(style.lineHeight) / parseFloat(style.fontSize) }; });
    await draftPage.evaluate(() => {
      (window as any).imageTextPaints = [];
      CanvasRenderingContext2D.prototype.fillText = new Proxy(CanvasRenderingContext2D.prototype.fillText, { apply(target, ctx, args) {
        (window as any).imageTextPaints.push({ text: args[0], x: args[1], y: args[2], font: ctx.font });
        return Reflect.apply(target, ctx, args);
      } });
    });
    const beforeText = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL());
    await draftPage.getByRole("button", { name: "Apply text", exact: true }).click(); await settle();
    assert.equal(await textEntry.count(), 0);
    const afterText = await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL());
    assert.notEqual(afterText, beforeText, "inline text commits pixels");
    const textPresentation = await draftPage.evaluate(format => {
      const lines = (window as any).imageTextPaints.filter((p: any) => p.text === "直接标注" || p.text === "Second line").slice(-2);
      const size = Number(lines[0]?.font.match(/([\d.]+)px/)?.[1]);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${format.weight} ${size}px ${format.family}`;
      return { count: lines.length, fontMatches: lines.every((p: any) => p.font === context.font), spacing: lines[1]?.y - lines[0]?.y, expectedSpacing: size * format.leading };
    }, inputFormat);
    assert.equal(textPresentation.count, 2); assert.equal(textPresentation.fontMatches, true, "canvas retains the actual native input font");
    assert.ok(Math.abs(textPresentation.spacing - textPresentation.expectedSpacing) < .01, "multiline export retains input leading");
    await draftPage.getByRole("button", { name: "Undo", exact: true }).click(); await settle();
    assert.equal(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL()), beforeText, "whole text is one undo step");
    await draftPage.getByRole("button", { name: "Redo", exact: true }).click(); await settle();
    assert.equal(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL()), afterText);
    await brush([.5, .7], [.5, .7]); await textEntry.fill("Discard this"); await textEntry.press("Escape");
    assert.equal(await textEntry.count(), 0); assert.equal(await draftPage.locator(".image-editor").count(), 1, "Escape discards text only");
    assert.equal(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL()), afterText);
    await brush([.5, .7], [.5, .7]); await textEntry.fill("Pending IME"); await textEntry.dispatchEvent("compositionstart", { data: "文" });
    await draftPage.getByRole("button", { name: "Discard text", exact: true }).click();
    assert.equal(await textEntry.count(), 0);
    await brush([.5, .7], [.5, .7]); await textEntry.fill("New text after cancelled IME");
    await draftPage.getByRole("button", { name: "Apply text", exact: true }).click(); await settle();
    assert.equal(await textEntry.count(), 0, "discarded IME cannot lock the next text operation");
    await draftPage.getByRole("button", { name: "Undo", exact: true }).click(); await settle();
    assert.equal(await canvas.evaluate(node => (node as HTMLCanvasElement).toDataURL()), afterText);
    await draftPage.getByRole("button", { name: "Undo", exact: true }).click(); await settle();
    await draftPage.getByRole("button", { name: "Sticker", exact: true }).click(); await draftPage.getByRole("button", { name: "👍", exact: true }).click(); await brush([.3, .65], [.3, .65]);
    assert.equal(await draftPage.getByRole("button", { name: "Redo", exact: true }).isDisabled(), true, "new action retires redo branch");
    assert.equal(await draftPage.getByRole("button", { name: "Mosaic", exact: true }).locator('[data-action-glyph="image-mosaic"]').count(), 1, "shared mosaic artwork");
    await draftPage.getByRole("button", { name: "Mosaic", exact: true }).click();
    const originalPixel = await pixel(.5, .75); await brush([.2, .75], [.8, .75]);
    assert.notDeepEqual(await pixel(.5, .75), originalPixel, "mosaic changes source pixels");
    await draftPage.screenshot({ path: `${output}/editor-${touchMode ? "touch" : "mouse"}-${mode}.png` });
    await draftPage.getByRole("button", { name: "Crop", exact: true }).click(); await brush([.1, .1], [.9, .9]);
    await draftPage.getByRole("button", { name: "Apply crop", exact: true }).click(); await settle();
    const cropSize = await canvas.evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height]);
    assert(Math.abs(cropSize[0]! - 512) <= 2 && Math.abs(cropSize[1]! - 384) <= 2);
    await draftPage.getByRole("button", { name: "Rotate clockwise", exact: true }).click();
    await draftPage.getByRole("button", { name: "Undo", exact: true }).click(); await settle();
    assert.deepEqual(await canvas.evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height]), cropSize);
    await draftPage.getByRole("button", { name: "Redo", exact: true }).click(); await settle();
    await draftPage.getByRole("button", { name: "Done", exact: true }).click(); await draftPage.locator(".opencraft-composer-image-preview").waitFor({ state: "hidden" });
    const result = await draftPage.evaluate(async () => {
      const f = (window as any).imagePreviewFixture, file = f.files.at(-1), bitmap = await createImageBitmap(file);
      const result = { type: file.type, name: file.name, width: bitmap.width, height: bitmap.height, attachments: f.controller.getSnapshot().draft.attachments.length, submissions: f.submissions }; bitmap.close(); return result;
    });
    assert.equal(result.type, "image/png"); assert.equal(result.name, "editable-edited.png"); assert.equal(result.attachments, 1); assert.equal(result.submissions, 0);
    assert.equal(result.width, cropSize[1]); assert.equal(result.height, cropSize[0]);
    // A cancelled session keeps attachment identity/URI/name and document intact.
    const saved = await draftPage.evaluate(() => (window as any).imagePreviewFixture.controller.getSnapshot().draft);
    await triggers.first().click(); await draftPage.getByRole("button", { name: "Edit image", exact: true }).click(); await canvas.waitFor();
    await brush([.2, .2], [.8, .2]); await draftPage.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await draftPage.evaluate(() => (window as any).imagePreviewFixture.controller.getSnapshot().draft), saved);
    assert.deepEqual(draftErrors, []);
    await context.close();
    console.log("composer preview", touchMode ? "touch" : "desktop", mode, "passed");
  }
  console.log("PASS: sent image opens and closes inside the embedded presentation root");
} finally {
  await browser?.close();
  await vite.close();
}
