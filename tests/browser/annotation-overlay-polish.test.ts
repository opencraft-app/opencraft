import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";

test("live marker hit-test shares painted geometry, handles overlap, scrolling and retired targets", async () => {
  const js = await build({
    entryPoints: ["packages/browser-preview-bridge/src/annotation-overlay.ts"],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    globalName: "Overlay",
  });
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(
      '<style>body{margin:0;height:2000px}#target{position:absolute;top:200px;left:100px;width:200px;height:80px;border-radius:24px}</style><button id="target">Hello</button>',
    );
    await page.addScriptTag({ content: js.outputFiles[0]!.text });
    await page.evaluate(() => {
      const w = window as any,
        target = document.querySelector("#target")!;
      w.overlay = w.Overlay.createAnnotationOverlay(window);
      w.overlay.bind("bound", target);
      w.overlay.draw([
        {
          x: 100,
          y: 200,
          width: 200,
          height: 80,
          targetKey: "bound",
          label: "1A",
          markerId: "a/one",
          state: "current",
        },
        { x: 100, y: 200, width: 200, height: 80, targetKey: "bound", label: "2A", markerId: "b/one", state: "saved" },
      ]);
    });
    const hit = (x: number, y: number) =>
      page.evaluate(({ x, y }) => (window as any).overlay.hit({ x, y, frameWidth: 800, frameHeight: 600 }), { x, y });
    assert.deepEqual(await hit(298, 201), ["a/one", "b/one"]);
    assert.deepEqual(await hit(150, 240), [], "only marker labels intercept, not page boxes");
    await page.evaluate(() => scrollTo(0, 100));
    assert.deepEqual(await hit(298, 101), ["a/one", "b/one"]);
    assert.deepEqual(await hit(298, 201), []);
    await page.evaluate(() => document.querySelector("#target")!.remove());
    assert.deepEqual(await hit(298, 101), []);
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<button id="target">Replacement</button>');
    });
    assert.deepEqual(await hit(298, 101), [], "same selector cannot revive a replaced node");
    await page.evaluate(() => (window as any).overlay.dispose());
    assert.equal(await page.locator("#opencraft-annotation-host").count(), 0);
  } finally {
    await browser.close();
  }
});
