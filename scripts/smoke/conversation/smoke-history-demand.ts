import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "history-demand",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url?.split("?")[0] !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<div id="root"></div><script type="module" src="/tests/fixtures/conversation-scroll.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const address = vite.httpServer!.address() as { port: number };
  for (const touch of [false, true])
    for (const natural of [false, true]) {
      const context = await browser.newContext({
        viewport: { width: touch ? 390 : 1200, height: 850 },
        hasTouch: touch,
        isMobile: touch,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const open = async () => {
        await page.goto(`http://127.0.0.1:${address.port}/?history&historyDemand${natural ? "&natural" : ""}`);
        await page.waitForFunction(
          () => typeof (window as any).setHistoryReady === "function" && !!document.querySelector(".thread-scroll"),
        );
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
      };
      await open();
      assert.equal(await page.evaluate(() => (window as any).historyLoads), 0);
      await page.evaluate(() => (window as any).setHistoryReady(true));
      await page
        .waitForFunction(() => (window as any).historyLoads === 3)
        .catch(async (error) => {
          console.error(
            JSON.stringify(
              await page.evaluate(() => {
                const port = document.querySelector(".thread-scroll") as HTMLElement;
                return {
                  loads: (window as any).historyLoads,
                  events: (window as any).historyEvents,
                  scrollHeight: port.scrollHeight,
                  height: port.clientHeight,
                  scrollTop: port.scrollTop,
                  rows: [...document.querySelectorAll("[data-virtualized-turn-key]")].map((e) => ({
                    key: e.getAttribute("data-virtualized-turn-key"),
                    height: e.getBoundingClientRect().height,
                  })),
                };
              }),
            ),
            errors,
          );
          throw error;
        });
      const progress = await page.evaluate(() => ({
        loads: (window as any).historyLoads,
        events: (window as any).historyEvents,
      }));
      assert.ok(
        progress.events.some(
          (event: any) => event.phase === "load-settled" && event.before.scrollHeightPx === event.after?.scrollHeightPx,
        ),
        "must exercise real scrollHeight flooring",
      );

      await open();
      await page.evaluate(() => {
        (window as any).stallHistory = true;
        (window as any).setHistoryReady(true);
      });
      await page.waitForFunction(() =>
        (window as any).historyEvents?.some((e: any) => e.reason === "unchanged-cursor"),
      );
      await page.evaluate(() => {
        (window as any).renderAgain();
        (window as any).setHistoryLoading(true);
      });
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await page.evaluate(() => (window as any).setHistoryLoading(false));
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      assert.equal(
        await page.evaluate(() => (window as any).historyLoads),
        1,
        "incidental commits cannot spin at a stalled cursor",
      );

      await open();
      await page.evaluate(() => (window as any).setHidden(true));
      await page.evaluate(() => (window as any).setHistoryReady(true));
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      assert.equal(await page.evaluate(() => (window as any).historyLoads), 0);
      await page.evaluate(() => (window as any).setHidden(false));
      await page.waitForFunction(() => (window as any).historyLoads === 3);
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          touch,
          natural,
          shortPages: progress.loads,
          readiness: "passed",
          stalled: "bounded",
          reactivation: "passed",
        }),
      );
      await context.close();
    }
} finally {
  await browser?.close();
  await vite.close();
}
