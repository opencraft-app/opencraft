import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

const output = process.env.OPENCRAFT_SMOKE_OUTPUT ?? "/tmp/sidechat-composer";
await mkdir(output, { recursive: true });
const children = new Map<string, { id: string; text: string }>();
const calls: { method: string; id?: string }[] = [];
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  optimizeDeps: { include: ["@opencraft/browser-core/metadata-limits", "@opencraft/browser-core/metadata-merge"] },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-sidechat-composer",
  esbuild: { jsx: "automatic", target: "esnext" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "resource-refresh-fixture",
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url?.split("?")[0] === "/") {
            res.setHeader("content-type", "text/html");
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/resource-refresh.tsx"></script>',
            );
            return;
          }
          if (req.url === "/resource-refresh/document") {
            res.setHeader("content-type", "text/html");
            res.end("<h1>Original browser document</h1>");
            return;
          }
          if (req.url !== "/resource-refresh/rpc") return next();
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString());
          calls.push(request);
          let result: any = {};
          if (request.method === "fork") {
            assert.equal(request.options.ephemeral, false);
            assert.equal(request.local.deduplicate, false);
            result = { id: "child-" + children.size, text: "Original side answer retained across reload" };
            children.set(result.id, result);
          }
          if (request.method === "acquire") {
            await new Promise((r) => setTimeout(r, 100));
            result = children.get(request.id);
            if (!result) res.statusCode = 404;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result ?? {}));
        });
      },
    },
  ],
});
let browser;
const reports: unknown[] = [];
try {
  await server.listen();
  browser = await (process.env.SMOKE_ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
  for (const touch of [true, false]) {
    children.clear();
    calls.length = 0;
    const context = await browser.newContext({
      viewport: { width: touch ? 390 : 1280, height: 844 },
      hasTouch: touch,
      isMobile: touch,
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error(e.message);
    });
    await page.addInitScript(
      ({ touch }) => {
        (window as any).__name = (v: unknown) => v;
        document.addEventListener(
          "DOMContentLoaded",
          () => (document.documentElement.dataset.uiDensity = touch ? "touch" : "compact"),
        );
      },
      { touch },
    );
    await page.goto(server.resolvedUrls!.local[0] + "?composer=1&locale=" + (process.env.SMOKE_LOCALE ?? "en-US"));
    const click = async (locator: any) => (touch ? locator.tap() : locator.click());
    const main = page.locator(".main-content-surface");
    const mainEditor = main.locator("[contenteditable=true]").first();
    await mainEditor.fill("Parent draft stays here");
    await page.screenshot({ path: `${output}/${touch ? "touch" : "pointer"}-main.png` });
    await click(page.getByTestId("new-sidechat"));
    const side = page.locator(".side-chat-panel:visible");
    await side.getByText("Original side answer retained across reload", { exact: true }).waitFor();
    const editor = side.locator("[contenteditable=true]").first();
    const mic = side.getByRole("button", { name: "Start voice input", exact: true });
    await mic.waitFor();
    await editor.evaluate((el) => (el as HTMLElement).blur());
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${output}/${touch ? "touch" : "pointer"}-idle.png` });
    await editor.fill("Side draft");
    if (touch) {
      assert.equal(await page.locator(".panel-mobile-dock:visible").count(), 0, "no duplicate side-chat dock");
      await side.getByTestId("composer-panel-toggle").waitFor();
      const geometry = await side.evaluate((el) => {
        const panel = el.closest(".right-panel-content")!;
        const view = panel.querySelector(".right-panel-view")!;
        const composer = el.querySelector(".opencraft-composer-shell")!.getBoundingClientRect();
        const tabs = el.querySelector("[data-testid=composer-panel-toggle]")!.getBoundingClientRect();
        return {
          reservedDock: getComputedStyle(view).marginBottom,
          composerBottom: composer.bottom,
          tabsBottom: tabs.bottom,
          panelBottom: panel.getBoundingClientRect().bottom,
        };
      });
      assert.equal(geometry.reservedDock, "0px");
      assert.ok(Math.abs(geometry.composerBottom - geometry.tabsBottom) < 12, JSON.stringify(geometry));
      assert.ok(geometry.panelBottom - geometry.composerBottom < 35, JSON.stringify(geometry));
      await click(side.getByTestId("composer-panel-toggle"));
      await page.getByRole("dialog").waitFor();
      assert.equal(
        await page.getByTestId("overview-origin").getAttribute("data-key"),
        await page.evaluate(() => (window as any).fixture.overviewKey()),
      );
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await editor.innerText(), "Side draft");
    }
    const chooserPromise = page.waitForEvent("filechooser");
    await click(side.getByRole("button", { name: /^(Add|添加)$/ }));
    await (
      await chooserPromise
    ).setFiles({ name: "side-note.txt", mimeType: "text/plain", buffer: Buffer.from("Only this side conversation") });
    await side.getByRole("button", { name: "Remove side-note.txt", exact: true }).waitFor();
    const attachmentState = await page.evaluate(() => (window as any).fixture.composerState());
    assert.equal(attachmentState.parent.input.attachments.length, 0);
    assert.equal(attachmentState.sides[0].snapshot.input.attachments.length, 1);
    await click(side.getByRole("button", { name: "Remove side-note.txt", exact: true }));
    await click(mic);
    await side.locator("[data-voice-phase=listening]").waitFor();
    await click(side.getByRole("button", { name: /^(Stop and insert text|停止并写入文字)$/ }));
    await page.waitForFunction(() =>
      document
        .querySelector(".side-chat-panel [contenteditable=true]")
        ?.textContent?.includes("Voice text for this conversation"),
    );
    const state = await page.evaluate(() => (window as any).fixture.composerState());
    assert.equal(state.parent.hasContent, true);
    assert.ok(JSON.stringify(state.parent.input).includes("Parent draft stays here"));
    assert.ok(!JSON.stringify(state.parent.input).includes("Voice text"));
    await click(side.locator("[data-composer-primary-action=send]"));
    await page.waitForFunction(() => !(window as any).fixture.composerState().sides[0].snapshot.hasContent);
    assert.equal(calls.filter((c) => c.method === "submit").length, 1);
    assert.equal(calls.find((c) => c.method === "submit")?.id, state.sides[0].key.threadId);
    await page.evaluate(() => (window as any).fixture.setRunning(true));
    await click(side.locator("[data-composer-primary-action=stop]"));
    await page.waitForTimeout(100);
    assert.equal(calls.find((c) => c.method === "interrupt")?.id, state.sides[0].key.threadId);
    await editor.fill("Steer side only");
    await click(side.locator("[data-composer-primary-action=steer]"));
    await page.waitForTimeout(100);
    assert.equal(calls.filter((c) => c.method === "submit").length, 2);
    assert.equal(
      calls.some((c) => c.id === "parent"),
      false,
    );
    await page.evaluate(() => (window as any).fixture.setRunning(false));
    await editor.fill("Retained side draft");
    await click(mic);
    await page.evaluate(() => (window as any).fixture.hideTools());
    await page.waitForFunction(() => (window as any).fixture.composerState().voiceCancelled > 0);
    await click(page.getByTestId("show-tools"));
    await editor.waitFor();
    assert.equal(await editor.innerText(), "Retained side draft");
    await page.evaluate(() => (window as any).fixture.setAuthoritative(false));
    assert.equal(await mic.isDisabled(), true);
    assert.equal(await side.locator("[data-composer-primary-action=send]").isDisabled(), true);
    await page.evaluate(() => (window as any).fixture.setAuthoritative(true));
    await page.waitForFunction(() => {
      const button = document
        .querySelector(".side-chat-panel [data-composer-primary-action=send]")
        ?.getBoundingClientRect();
      return button && button.right <= innerWidth && button.bottom <= innerHeight;
    });
    await page.screenshot({ path: `${output}/${touch ? "touch" : "pointer"}-side.png` });
    await page.evaluate(() => (window as any).fixture.setTheme("dark"));
    assert.equal(await editor.innerText(), "Retained side draft");
    await page.screenshot({ path: `${output}/${touch ? "touch" : "pointer"}-dark.png` });
    await page.evaluate(() => (window as any).fixture.setTheme("light"));
    if (touch) {
      await page.setViewportSize({ width: 390, height: 460 });
      await editor.focus();
      const button = await side.locator("[data-composer-primary-action=send]").boundingBox();
      assert.ok(button && button.y + button.height <= 460);
      await page.screenshot({ path: `${output}/touch-short.png` });
      await page.setViewportSize({ width: 844, height: 390 });
      assert.equal(await editor.innerText(), "Retained side draft");
      await page.screenshot({ path: `${output}/touch-landscape.png` });
    }
    if (touch) await page.setViewportSize({ width: 390, height: 844 });
    // Switching to an ordinary tool still keeps its own dock allocation.
    await page.evaluate(() => (window as any).fixture.newBrowser());
    await page.frameLocator("iframe").getByText("Original browser document").waitFor();
    if (touch) await page.locator(".panel-mobile-dock:visible").waitFor();
    await page.evaluate(() => (window as any).fixture.activate("sidechat"));
    await editor.waitFor();
    assert.equal(await editor.innerText(), "Retained side draft");
    assert.deepEqual(errors, []);
    reports.push({ touch, isolatedDraftAndVoice: true, isolatedSendAndStop: true, singleFooter: true });
    await context.close();
    console.log(`passed touch=${touch}`);
  }
  await writeFile(output + "/report.json", JSON.stringify(reports, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
