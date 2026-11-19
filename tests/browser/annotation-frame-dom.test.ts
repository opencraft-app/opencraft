import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { chromium } from "playwright";

test("packaged frame transport preserves opaque sandbox and supports real touch selection/browse scrolling", async () => {
  const bundle = await build({
    entryPoints: ["apps/workbench-web/src/browser-annotation/frame/frame-source.ts"],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    globalName: "FrameSource",
    platform: "browser",
  });
  const factory = runInNewContext(bundle.outputFiles[0]!.text + ";FrameSource");
  const script = factory.annotationFrameScript({ token: "test", parentOrigin: "http://localhost" });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, hasTouch: true });
    await page.addInitScript(
      'window.__name = value => value; window.messages = []; addEventListener("message", event => { if (event.data?.channel === "opencraft-annotation") messages.push({ ...event.data, origin: event.origin }); });',
    );
    await page.route("http://localhost/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<style>html,body{margin:0}iframe{border:0;width:800px;height:600px}</style><iframe sandbox="allow-scripts"></iframe>',
      }),
    );
    await page.goto("http://localhost/transport");
    await page.locator("iframe").evaluate((frame, script) => {
      (frame as HTMLIFrameElement).srcdoc =
        '<style>body{margin:0;font:24px monospace;height:2400px}p{margin:20px}</style><p id="text">Hello world Unicode 世界</p><button>Button</button>' +
        script;
    }, script);
    await page.waitForFunction(() => (window as any).messages.some((message: any) => message.type === "ready"));
    const frame = page.frames().find((frame) => frame.parentFrame())!;
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(
      await page.evaluate(() => (window as any).messages.find((message: any) => message.type === "ready").origin),
      "null",
    );
    const send = async (type: string, data: Record<string, unknown> = {}) => {
      await page.evaluate(
        ({ type, data }) =>
          document
            .querySelector("iframe")!
            .contentWindow!.postMessage({ channel: "opencraft-annotation", token: "test", type, ...data }, "*"),
        { type, data },
      );
    };
    await send("start", { mode: "region" });
    await frame.waitForFunction(() => document.documentElement.style.touchAction === "none");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x = 0, y = 0) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }],
      });
    await touch("touchStart", 40, 120);
    await touch("touchMove", 160, 220);
    await touch("touchEnd");
    await page.waitForFunction(() => (window as any).messages.some((message: any) => message.type === "drag"));
    assert.equal(await frame.evaluate(() => scrollY), 0);
    const drag = await page.evaluate(() => (window as any).messages.find((message: any) => message.type === "drag"));
    assert.equal(drag.start.x, 40);
    assert.equal(drag.end.x, 160);
    await send("region", { id: 1, start: drag.start, end: drag.end });
    await page.waitForFunction(() => (window as any).messages.some((message: any) => message.id === 1));
    const region = await page.evaluate(() => (window as any).messages.find((message: any) => message.id === 1));
    assert.equal(region.ok, true);
    assert.equal(region.result.anchor.kind, "region");
    assert.equal(region.result.anchor.rect.width, 120);
    await touch("touchStart", 40, 120);
    await touch("touchCancel");
    assert.equal(
      await page.evaluate(() => (window as any).messages.filter((message: any) => message.type === "drag").length),
      1,
    );
    await send("start", { mode: "text" });
    await send("text", {
      id: 2,
      start: { x: 21, y: 32, frameWidth: 800, frameHeight: 600 },
      end: { x: 165, y: 32, frameWidth: 800, frameHeight: 600 },
    });
    await page.waitForFunction(() => (window as any).messages.some((message: any) => message.id === 2));
    const text = await page.evaluate(() => (window as any).messages.find((message: any) => message.id === 2));
    assert.equal(text.ok, true);
    assert.equal(text.result.anchor.kind, "text");
    assert.match(text.result.anchor.selectedText, /Hello/);
    await send("start", { mode: "browse" });
    await frame.waitForFunction(() => document.documentElement.style.touchAction !== "none");
    await touch("touchStart", 300, 450);
    await touch("touchMove", 300, 200);
    await touch("touchEnd");
    await frame.waitForFunction(() => scrollY > 0);
    assert.equal(
      await page.evaluate(() => (window as any).messages.filter((message: any) => message.type === "drag").length),
      1,
    );
  } finally {
    await browser.close();
  }
});
