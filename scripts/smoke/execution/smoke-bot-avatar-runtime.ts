import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";

const playwright = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const { chromium } = playwright.default ?? playwright;
const output =
  process.env.OPENCRAFT_BOT_AVATAR_EVIDENCE ??
  "/tmp/opencraft-bot-avatar-runtime";
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-bot-avatar-runtime-smoke",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "bot-avatar-runtime-smoke",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<div id="root"></div><script type="module" src="/tests/fixtures/bot-avatar-runtime.tsx"></script>',
          );
        });
      },
    },
  ],
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await mkdir(output, { recursive: true });
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 920, height: 560 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const port = (vite.httpServer!.address() as { port: number }).port;
  await page.goto(`http://127.0.0.1:${port}`);
  await page.waitForSelector('[data-activity-level="active"]');
  await page.waitForSelector('[data-activity-level="attentive"]');
  await page.waitForSelector('[data-activity-level="ambient"]');
  assert.equal(await page.locator(".bot-chat-mark-source").count(), 3);
  assert.equal(
    await page
      .locator(".bot-chat-avatar__action-particles")
      .evaluateAll((groups) =>
        groups.every((group) => group.children.length <= 16),
      ),
    true,
  );
  assert.equal(
    await page
      .locator("[data-avatar-effect]")
      .evaluateAll((elements) =>
        elements.every(
          (element) => getComputedStyle(element).animationName === "none",
        ),
      ),
    true,
  );
  const activeActor = page.locator(
    '[data-activity-level="active"][data-participant-id="bot:opencraft"]',
  );
  const beforeMotion = await activeActor
    .locator("g[id]")
    .getAttribute("transform");
  await page.waitForTimeout(120);
  const afterMotion = await activeActor
    .locator("g[id]")
    .getAttribute("transform");
  assert.notEqual(afterMotion, beforeMotion);

  await page
    .locator(".avatar-fixture__team article")
    .nth(2)
    .evaluate((element) => {
      (element as HTMLElement).style.transform = "translateY(900px)";
    });
  const hiddenActor = page.locator(
    '[data-participant-id="bot:muse"][data-activity-level="hidden"]',
  );
  await hiddenActor.waitFor();
  const hiddenTransform = await hiddenActor
    .locator("g[id]")
    .getAttribute("transform");
  await page.waitForTimeout(260);
  assert.equal(
    await hiddenActor.locator("g[id]").getAttribute("transform"),
    hiddenTransform,
  );
  await page
    .locator(".avatar-fixture__team article")
    .nth(2)
    .evaluate((element) => {
      (element as HTMLElement).style.transform = "";
    });
  await page.screenshot({ path: `${output}/group-light.png` });
  await page.evaluate(() => window.botAvatarFixture!.active(false));
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>("[data-activity-level]")]
    .every(actor => actor.dataset.activityLevel === "hidden"));
  const parkedTransforms = await page.locator('.bot-chat-mark-source g[id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('transform')));
  await page.waitForTimeout(250);
  assert.deepEqual(await page.locator('.bot-chat-mark-source g[id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('transform'))), parkedTransforms,
    "parking presentation stops motion even while marks remain geometrically visible");
  await page.evaluate(() => window.botAvatarFixture!.active(true));
  await page.waitForSelector('[data-activity-level="active"]');


  await page.evaluate(() => window.botAvatarFixture!.scenario("send"));
  await page.waitForFunction(() => {
    const actor = document.querySelector<HTMLElement>(
      '[data-activity-level="active"]',
    );
    return (
      actor?.dataset.effect === "send" && actor.dataset.morphPhase === "hold"
    );
  });
  await page.evaluate(() => window.botAvatarFixture!.scenario("idle"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>("[data-activity-level]")].every(
      (actor) => actor.dataset.activityLevel === "ambient",
    ),
  );

  await page.evaluate(() => window.botAvatarFixture!.theme("dark"));
  assert.equal(
    await page.evaluate(
      () =>
        getComputedStyle(document.body).backgroundColor === "rgb(24, 24, 24)",
    ),
    true,
  );
  await page.screenshot({ path: `${output}/idle-dark.png` });
  assert.deepEqual(pageErrors, []);

  const reduced = await browser.newPage({
    viewport: { width: 920, height: 560 },
    reducedMotion: "reduce",
  });
  await reduced.goto(`http://127.0.0.1:${port}`);
  await reduced.waitForSelector('[data-reduced-motion="true"]');
  assert.equal(
    await reduced
      .locator("[data-avatar-effect]")
      .evaluateAll((elements) =>
        elements.every(
          (element) => Number(getComputedStyle(element).opacity) === 0,
        ),
      ),
    true,
  );
  await reduced.screenshot({ path: `${output}/reduced-motion.png` });
  await reduced.close();
  console.log(`Bot avatar runtime smoke passed: ${output}`);
} finally {
  await browser?.close();
  await vite.close();
}

declare global {
  interface Window {
    botAvatarFixture?: {
      scenario(value: "group" | "idle" | "send"): void;
      theme(value: "light" | "dark"): void;
    };
  }
}
