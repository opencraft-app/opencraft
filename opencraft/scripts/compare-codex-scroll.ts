import { createServer } from "vite";
import assert from "node:assert/strict";
import { createCodexScrollReferenceModules } from "./lib/codex-scroll-reference";

const reference = createCodexScrollReferenceModules(
  process.env.CODEX_SCROLL_REFERENCE_ROOT ??
    "/data/mia/.runtime/lifecycle-authority-dead-contract-r3562",
);
const playwright = await import(
  process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright"
);
const { chromium } = playwright.default ?? playwright;
const essays = process.env.CODEX_SCROLL_ESSAYS === "1";
const realClock = process.env.CODEX_SCROLL_REAL_CLOCK === "1";
const baselinePolicy = process.env.CODEX_SCROLL_REFERENCE_POLICY === "baseline";
// Geometry/animation comparison needs the same entry point on both sides.
// The visible Vela button is exercised separately by the scroll smoke test.
const testVisibleButton = process.env.CODEX_SCROLL_INPUT === "visible-button";
const diagnoseResize = process.env.CODEX_SCROLL_RESIZE_DIAGNOSIS === "1";
const boundaryFrames = Number(process.env.CODEX_SCROLL_BOUNDARY_FRAMES ?? 48);
assert.ok(Number.isInteger(boundaryFrames) && boundaryFrames > 0);
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  esbuild: { jsx: "automatic" },
  cacheDir: "node_modules/.vite-codex-scroll-comparison",
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react-dom",
      "react/jsx-runtime",
      "react/compiler-runtime",
      "motion/react",
      "lucide-react",
    ],
  },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "original-codex-scroll-comparison",
      resolveId(id) {
        if (reference.modules.has(id)) return `\0${id}`;
      },
      load(id) {
        const source = reference.modules.get(id.replace(/^\0/, ""));
        if (essays && id.endsWith("codex-scroll-response") && source) {
          assert.ok(source.includes("y?.turnKey;"), "Reference observation point changed");
          // Read-only test instrumentation; the reducer/controller bodies are unchanged.
          return source.replace("y?.turnKey;", "y?.turnKey;globalThis.__readScrollFollow=()=>({mode:N.current.followMode,phase:E});");
        }
        return source;
      },
      transform(source, id) {
        if (essays && id.endsWith("/conversation/response-positioned-turns.tsx")) {
          assert.ok(source.includes("// r3562 U/ee:"), "Candidate observation point changed");
          return source.replace("// r3562 U/ee:", "globalThis.__readScrollFollow=()=>({mode:responsePositioning.getFollowState().followMode,phase:latestTurnPhase});\n// r3562 U/ee:");
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/comparison-host") {
            response.setHeader("content-type", "text/html");
            response.end("<!doctype html><html><body></body></html>");
            return;
          }
          if (request.url?.split("?")[0] !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end(
            '<div id="root"></div><script>' +
            // Playwright virtual RAF phases are document-local, even in
            // sibling iframes. Share the parent's RAF and time origin BEFORE
            // either implementation (or Motion) captures its scheduling host.
            'if(parent!==window){window.requestAnimationFrame=cb=>parent.requestAnimationFrame(cb);window.cancelAnimationFrame=id=>parent.cancelAnimationFrame(id);Object.defineProperty(performance,"now",{value:()=>parent.performance.now()});}' +
            '</script><script type="module" src="/tests/fixtures/codex-scroll-comparison.tsx"></script>',
          );
        });
      },
    },
  ],
});
let browser: any;
const errors: string[] = [];
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  const backends = process.env.CODEX_SCROLL_CONTROL === "1" ? ["codex", "codex"] : ["codex", "vela"];
  console.log(JSON.stringify({ kind: "backends", backends }));
  // Both isolated documents share one Page clock and one rendering cycle.
  // Two independent pages can be a compositor frame apart even in a
  // Codex-vs-Codex control, which is not evidence of an implementation delta.
  const hostPage = await browser.newPage({ viewport: { width: 2400, height: 800 } });
  if (!realClock) await hostPage.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  hostPage.on("pageerror", (error: Error) => {
    errors.push(error.message);
    console.error(error.stack);
  });
  await hostPage.addInitScript(() => {
    const Original = window.IntersectionObserver;
    (window as any).intersections = [];
    (window as any).observerLifetimes = [];
    (window as any).resizeWarnings = [];
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver loop")) {
        (window as any).resizeWarnings.push({ time: performance.now(), step: (window as any).resizeStep });
      }
    });
    window.IntersectionObserver = class extends Original {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        (window as any).observerLifetimes.push({ type: "construct", time: performance.now() });
        super((records, observer) => {
          (window as any).intersections.push(...records.map((record) => ({
            height: record.intersectionRect.height,
            targetHeight: record.boundingClientRect.height,
            time: performance.now(),
          })));
          callback(records, observer);
        }, options);
      }
      disconnect() {
        (window as any).observerLifetimes.push({ type: "disconnect", time: performance.now() });
        super.disconnect();
      }
    };
  });
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  // Same-origin parent is required for atomic dispatch and atomic sampling.
  await hostPage.goto(`${origin}/comparison-host`);
  await hostPage.evaluate(({ backends, renderer, policy, sync }: any) => {
    document.body.style.cssText = "margin:0;display:flex";
    for (const backend of backends) {
      const frame = document.createElement("iframe");
      frame.style.cssText = "width:1200px;height:800px;border:0;flex:none";
      frame.src = `/?backend=${backend}&renderer=${renderer}&policy=${policy}&sync=${sync}`;
      document.body.append(frame);
    }
  }, { backends, renderer: process.env.CODEX_SCROLL_RENDERER ?? "fixture", policy: baselinePolicy ? "baseline" : "response", sync: process.env.CODEX_SCROLL_REFERENCE_SYNC ?? "false" });
  const pages = await Promise.all(backends.map(async (_backend, index) => {
      const handle = await hostPage.locator("iframe").nth(index).elementHandle();
      const page = await handle.contentFrame();
      await page.waitForFunction(
        () =>
          (window as any).api &&
          document.querySelector('[data-probe="text-5"]'),
        undefined,
        { timeout: 20000 },
      );
      return page;
  }));
  await hostPage.evaluate(async () => {
    for (let i = 0; i < 45; i++) await new Promise(requestAnimationFrame);
  });
  if (!realClock) {
    await hostPage.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  }
  const sampleBoth = (drain = false) => hostPage.evaluate((drain: boolean) =>
    [...document.querySelectorAll("iframe")].map((frame) => {
      const child = frame.contentWindow as any;
      return { ...child.sample(), ...(drain ? {
        intersections: child.intersections.splice(0),
        observerLifetimes: child.observerLifetimes.splice(0),
      } : {}) };
    }), drain);
  const paragraph = "清晨推开窗，雨后的街道泛着柔和的光。树叶上尚有水珠，远处传来早点铺的交谈声。我沿着河边慢慢走，想起昨日未完成的信。生活并不总是急着给出答案，有时候只需停一停，看风如何穿过桥洞，看一片落叶怎样安静地抵达岸边。那些细微的变化，让平凡的一天有了值得记住的轮廓。";
  const essayText = Array.from({ length: 6 }, (_, index) => `第${index + 1}篇：雨后的小城\n\n${paragraph.repeat(5).slice(0, 500)}\n\n`).join("");
  const chunks = (from: number, to: number) => Array.from(
    { length: Math.ceil((to - from) / 100) },
    (_, index) => ({ type: "text", value: essayText.slice(0, Math.min(to, from + (index + 1) * 100)) }),
  );
  const followStart = process.env.CODEX_SCROLL_RENDERER === "production" ? 1200 : 600;
  const sequence = essays && baselinePolicy ? [
    { type: "bottom", scenario: "natural-no-input" },
    { type: "submit", phase: "final_answer", text: "" },
    ...chunks(0, essayText.length),
    { type: "complete" },
    { type: "submit", phase: "final_answer", text: "" },
    ...chunks(0, 1200),
    { type: "distance", value: 400, scenario: "user-detach" },
    ...chunks(1200, 1800),
    { type: "remount", scenario: "restore-reading-position" },
    { type: "footer", value: 160 },
    { type: "footer", value: 80 },
    { type: "bottom" },
    ...chunks(1800, 2300),
    { type: "remount", scenario: "restore-active-bottom" },
    { type: "footer", value: 160 },
    ...chunks(2300, essayText.length),
    { type: "complete" },
    { type: "footer", value: 80 },
    { type: "submit", phase: "commentary", text: "正在整理。" },
    { type: "text", value: paragraph.repeat(14) },
    { type: "phase", value: "final_answer" },
    ...chunks(0, essayText.length),
    { type: "complete" },
  ] : essays ? [
    { type: "bottom", scenario: "direct-final" },
    { type: "submit", phase: "final_answer", text: "" },
    ...chunks(0, essayText.length),
    { type: "complete" },
    { type: "bottom", scenario: "explicit-follow" },
    { type: "submit", phase: "final_answer", text: "" },
    ...chunks(0, followStart),
    { type: "bottom" },
    ...chunks(followStart, 1800),
    ...(process.env.CODEX_SCROLL_RENDERER === "production" ? [
      ...chunks(1800, essayText.length),
      { type: "complete" },
      { type: "bottom", scenario: "separate-user-detach" },
      { type: "submit", phase: "final_answer", text: "" },
      ...chunks(0, followStart),
      { type: "bottom" },
      ...chunks(followStart, 1800),
    ] : []),
    { type: "distance", value: 400, scenario: "user-detach" },
    ...chunks(1800, essayText.length),
    { type: "complete" },
    { type: "bottom", scenario: "prework-overflow-to-final" },
    { type: "submit", phase: "commentary", text: "正在整理六篇文章。" },
    { type: "text", value: paragraph.repeat(14) },
    { type: "phase", value: "final_answer" },
    ...chunks(0, essayText.length),
    { type: "complete" },
  ] : [
    { type: "bottom" },
    { type: "submit" },
    { type: "phase", value: "commentary" },
    { type: "resize", value: 900 },
    { type: "phase", value: "final_answer" },
    { type: "resize", value: 1800 },
    { type: "distance", value: 400 },
    { type: "resize", value: 2600 },
    { type: "complete" },
    { type: "bottom" },
    { type: "submit", phase: "final_answer", height: 60 },
    { type: "complete" },
    { type: "submit", phase: "final_answer", height: 60 },
    { type: "complete" },
    { type: "resize", value: 900 },
    { type: "distance", value: 1000 },
    { type: "distance", value: 1000 },
    { type: "submit", phase: "final_answer", height: 60, shrinkPreviousTo: 20 },
  ];
  const results = [];
  console.log(
    JSON.stringify({
      kind: "baseline",
      values: await Promise.all(
        pages.map((page) => page.evaluate(() => (window as any).sample())),
      ),
    }),
  );
  const selectedSequence = diagnoseResize ? [
    { type: "bottom" },
    { type: "submit", phase: "final_answer", height: 260 },
    { type: "bottom" },
    { type: "distance", value: 1000 },
    { type: "resize", index: 5, value: 720 },
    { type: "resize", value: 360 },
    { type: "complete" },
    { type: "bottom" },
    { type: "fixed-row-height", value: 700 },
    { type: "resize", value: 400 },
  ] : process.env.CODEX_SCROLL_NATURAL_ONLY === "1"
    ? sequence.slice(0, sequence.findIndex(event => event.type === "complete") + 1)
    : [{ type: "physical-bottom", value: 900 }, { type: "physical-bottom", value: 20 }, ...sequence];
  for (const event of selectedSequence) {
    if (!testVisibleButton) {
      await hostPage.evaluate(async (event: any) => {
        await Promise.all([...document.querySelectorAll("iframe")].map((frame) =>
          (frame.contentWindow as any).event(event.type === "distance"
            ? { ...event, type: "wheel" } : event)));
      }, event);
    } else if (essays && event.type === "distance") {
      for (let index = 0; index < pages.length; index++) {
        await hostPage.mouse.move(index * 1200 + 500, 350);
        await hostPage.mouse.wheel(0, -event.value);
      }
    } else await Promise.all(pages.map(async (page, index) => {
      if (testVisibleButton && essays && process.env.CODEX_SCROLL_RENDERER === "production" && backends[index] === "vela" && event.type === "bottom" && !event.scenario) {
        // Exercise the actual visible control, not the public scroll API directly.
        const button = page.getByRole("button", { name: "Scroll to bottom", exact: true });
        const box = await button.boundingBox();
        assert.ok(box, "The actual bottom button must be visible");
        // Clock is paused for deterministic sampling: use trusted mouse input
        // without Playwright's RAF-based actionability wait.
        await hostPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else await page.evaluate((value: any) => (window as any).event(value), event);
    }));
    const frames = [];
    for (let frame = 0; frame < (essays && event.type === "text" ? 12 : boundaryFrames); frame++) {
      if (realClock) await hostPage.evaluate(() => new Promise(requestAnimationFrame));
      else await hostPage.clock.runFor(16);
      frames.push(await sampleBoth());
    }
    const values = await sampleBoth(true);
    const difference = (pair: any[]) => {
      const [a, b] = pair;
      const scalar = Math.max(
        ...["distance", "height", "viewport", "spacer"].map((key) =>
          Math.abs(a[key] - b[key]),
        ),
      );
      const commonKeys = Object.keys(a.anchors).filter(
        (key) => key in b.anchors,
      );
      return {
        scalar,
        anchor: Math.max(
          0,
          ...commonKeys.map((key) => Math.abs(a.anchors[key] - b.anchors[key])),
        ),
      };
    };
    const frameDifferences = frames.map(difference);
    if (!realClock && !testVisibleButton) {
      for (let index = 0; index < frames.length; index++) {
        const delta = frameDifferences[index]!;
        assert.ok(delta.scalar <= 1 && delta.anchor <= 1,
          `Shared-clock frame ${index} mismatch: ${JSON.stringify({ event, delta, values: frames[index] })}`);
        assert.deepEqual(Object.keys(frames[index]![0].anchors), Object.keys(frames[index]![1].anchors),
          `Rendered rows differ at shared-clock frame ${index}`);
        if (essays && !baselinePolicy) {
          assert.deepEqual(frames[index]![1].follow, frames[index]![0].follow,
            `Follow ownership differs at shared-clock frame ${index}`);
        }
      }
    }
    const result = {
      event: event.type === "text" ? { type: event.type, textLength: event.value.length } : event,
      settled: difference(values),
      maximumFrameScalarDifferencePx: Math.max(
        ...frameDifferences.map((v) => v.scalar),
      ),
      maximumFrameAnchorDifferencePx: Math.max(
        ...frameDifferences.map((v) => v.anchor),
      ),
    };
    assert.equal(values[0].reads, values[1].reads, "Placement consumption count differs");
    if (essays && !baselinePolicy) {
      assert.deepEqual(values[1].follow, values[0].follow, "Response phase/follow ownership differs from Codex");
    }
    assert.deepEqual(Object.keys(values[0].anchors), Object.keys(values[1].anchors), "Settled rendered rows differ");
    if (baselinePolicy) {
      for (const value of values) {
        assert.equal(value.reads, 0, "Natural policy must not consume response placement");
        assert.equal(value.spacer, 0, "Natural policy must not create response space");
        assert.equal(value.follow, null, "Natural policy must not construct response follow state");
      }
    }
    results.push(result);
    console.log(
      JSON.stringify({
        ...result,
        values,
        ...(process.env.CODEX_SCROLL_FULL_TRACE === "1" ? { frames } : {}),
      }),
    );
    if (essays && (event.type === "complete" || event.type === "distance")) {
      await Promise.all(pages.map((page, index) => page.locator("body").screenshot({ path: `/tmp/scroll-essays-${results.length}-${backends[index]}.png` })));
    }
  }
  console.log(
    JSON.stringify({
      kind: "reference-bodies",
      fingerprints: reference.fingerprints,
    }),
  );
  const resizeWarnings = await hostPage.evaluate(() => [...document.querySelectorAll("iframe")]
    .map((frame) => (frame.contentWindow as any).resizeWarnings));
  if (diagnoseResize) console.log(JSON.stringify({
    kind: "resize-warnings",
    backends,
    warnings: resizeWarnings,
  }));
  assert.deepEqual(resizeWarnings, [[], []], "neither implementation may emit skipped ResizeObserver notifications");
  assert.deepEqual(errors, []);
  for (const result of results) {
    assert.ok(
      result.settled.scalar <= 1 && result.settled.anchor <= 1,
      `Settled reference mismatch: ${JSON.stringify(result)}`,
    );
  }
  console.log(
    `Original-function comparison (${baselinePolicy ? "natural" : "response-placement"}): ${results.length} event boundaries match within 1px; ${!realClock && !testVisibleButton ? "every shared-clock frame also passes geometry, rendered-row and follow-state assertions" : "uncontrolled transient timing is reported, not asserted as frame parity"}.`,
  );
} finally {
  await browser?.close();
  await vite.close();
}
