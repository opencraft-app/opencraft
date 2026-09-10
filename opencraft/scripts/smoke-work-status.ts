import assert from "node:assert/strict";
import { createServer } from "vite";
const playwright = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-work-status-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "work-status-smoke",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<div id="root"></div><script type="module" src="/tests/fixtures/work-status.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript(() => {
    const intervals = new Set<number>();
    const start = window.setInterval.bind(window);
    const stop = window.clearInterval.bind(window);
    (window as any).clockIntervals = intervals;
    window.setInterval = ((
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      const id = start(callback, delay, ...args);
      if (delay === 1_000) intervals.add(id);
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = (id) => {
      if (id !== undefined) intervals.delete(id);
      stop(id);
    };
  });
  await page.goto(
    `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`,
  );
  await page.waitForSelector('[data-work-status="working"]');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-work-status="working"]')
      ?.textContent?.startsWith("Working for"),
  );
  await page.evaluate(() => (window as any).final());
  await page.waitForSelector(
    '.thread-agent-activity__turn-header button[aria-expanded="false"]',
  );
  assert.equal(
    await page.locator("[data-work-status]").textContent(),
    "Worked for 2s",
  );
  assert.equal(await page.locator("[data-work-status]").count(), 1);
  const geometry = await page
    .locator(".thread-agent-activity__turn-header")
    .evaluate((header: HTMLElement) => {
      const button = header.querySelector("button")!.getBoundingClientRect();
      const rule = header
        .querySelector(".thread-work-status__rule")!
        .getBoundingClientRect();
      const style = getComputedStyle(
        header.querySelector(".thread-work-status__rule")!,
      );
      return {
        buttonBottom: button.bottom,
        ruleTop: rule.top,
        ruleWidth: rule.width,
        headerWidth: header.getBoundingClientRect().width,
        borderWidth: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
      };
    });
  assert.ok(geometry.ruleTop >= geometry.buttonBottom);
  assert.ok(Math.abs(geometry.ruleWidth - geometry.headerWidth) < 1);
  assert.equal(geometry.borderWidth, "1px");
  assert.equal(geometry.borderStyle, "solid");
  await page.locator(".thread-agent-activity__turn-header button").click();
  assert.equal(
    await page.locator("[data-work-status]").count(),
    1,
    "expansion must not duplicate the work label",
  );
  assert.equal(await page.locator("[data-final]").count(), 1);
  await page.evaluate(() => (window as any).complete());
  assert.equal(
    await page.locator("[data-work-status]").textContent(),
    "Worked for 2s",
    "Turn completion cannot change the work interval to 99s",
  );
  await page.evaluate(() => (window as any).restore());
  await page.waitForSelector(
    '.thread-agent-activity__turn-header button[aria-expanded="false"]',
  );
  assert.equal(
    await page.locator("[data-work-status]").textContent(),
    "Worked for 2s",
  );
  assert.equal(
    await page.evaluate(() => (window as any).clockIntervals.size),
    0,
    "settled labels must not retain live intervals",
  );
  await page.screenshot({ path: "/tmp/work-status-complete.png" });
  await page.evaluate(() => (window as any).stop());
  await page.waitForSelector('[data-work-status="stopped"]');
  assert.equal(
    await page.locator("[data-work-status]").textContent(),
    "You stopped after 4s",
  );
  assert.equal(
    await page.locator(".thread-agent-activity__turn-header button").count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checks: [
        "live clock",
        "final boundary",
        "full-width rule below toggle",
        "expand ownership",
        "completion",
        "remount from snapshot",
        "local stop",
      ],
      errors,
      screenshot: "/tmp/work-status-complete.png",
    }),
  );
} finally {
  await browser?.close();
  await vite.close();
}
