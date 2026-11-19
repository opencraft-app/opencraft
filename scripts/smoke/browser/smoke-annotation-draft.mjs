import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
const root = await mkdtemp(join(tmpdir(), "annotation-draft-"));
await build({
  entryPoints: ["scripts/smoke/browser/smoke-annotation-draft.entry.tsx"],
  outfile: join(root, "entry.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
});
await build({
  entryPoints: ["apps/workbench-web/src/browser-annotation/screenshot.worker.ts"],
  outfile: join(root, "screenshot.worker.ts"),
  bundle: true,
  format: "esm",
  platform: "browser",
});
const server = createServer(async (req, res) => {
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><script type="module" src="/entry.js"></script>');
    return;
  }
  res.setHeader("content-type", "text/javascript");
  res.end(await readFile(join(root, req.url === "/entry.js" ? "entry.js" : "screenshot.worker.ts")));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch();
try {
  const p = await browser.newPage();
  p.on("pageerror", (e) => console.error(e));
  await p.goto("http://127.0.0.1:" + server.address().port);
  await p.waitForFunction(() => window.draftTest?.controller);
  const choose = async () => {
    await p.evaluate(() => {
      if (!draftTest.controller.active) draftTest.controller.toggle();
    });
    await p.waitForTimeout(30);
    await p.evaluate(() => draftTest.tap());
    await p.waitForFunction(() => draftTest.controller.candidate);
  };
  await choose();
  await p.evaluate(() => draftTest.controller.submit("text only"));
  assert.equal(await p.evaluate(() => draftTest.captures), 0);
  await choose();
  await p.evaluate(() => draftTest.controller.previewScreenshot());
  await p.waitForFunction(() => draftTest.controller.screenshot);
  await p.evaluate(() => draftTest.controller.removeScreenshot());
  await p.waitForTimeout(30);
  await p.evaluate(() => draftTest.controller.submit("removed image"));
  assert.equal(
    await p.evaluate(() => draftTest.composer.getSnapshot().draft.context.some((r) => r.metadata?.inputImage)),
    false,
  );
  await choose();
  await p.evaluate(() => draftTest.controller.previewScreenshot());
  await p.waitForFunction(() => draftTest.controller.screenshot);
  await p.evaluate(() => draftTest.controller.submit("reviewed crop"));
  assert.equal(
    await p.evaluate(() => draftTest.composer.getSnapshot().draft.context.filter((r) => r.metadata?.inputImage).length),
    1,
  );
  await choose();
  await p.evaluate(() => {
    draftTest.hold = true;
    void draftTest.controller.previewScreenshot();
  });
  await p.waitForFunction(() => draftTest.controller.busy);
  await p.evaluate(() => draftTest.switch());
  await p.waitForTimeout(30);
  await p.evaluate(() => draftTest.release());
  await p.waitForFunction(() => !draftTest.controller.busy);
  assert.equal(await p.evaluate(() => draftTest.controller.screenshot), null);
  assert.equal(await p.evaluate(() => draftTest.composer.getSnapshot().draft.context.length), 0);
  console.log(
    "annotation draft: text-only default, explicit cropped preview, remove image, attach reviewed image and switched-draft cancellation passed",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
