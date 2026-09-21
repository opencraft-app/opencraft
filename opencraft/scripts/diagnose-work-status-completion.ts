import { createServer } from "vite";
import assert from "node:assert/strict";
import { createCodexScrollReferenceModules } from "./lib/codex-scroll-reference";
const reference = createCodexScrollReferenceModules("/data/mia/.runtime/lifecycle-authority-dead-contract-r3562");
const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: process.env.WORK_REFERENCE === "1"
    ? "node_modules/.vite-work-transition-reference" : "node_modules/.vite-work-transition-candidate",
  optimizeDeps: { include: ["react", "react-dom/client", "react-dom", "react/jsx-runtime", "react/compiler-runtime"] },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "completion-diagnostic", enforce: "pre",
    resolveId(id) { if (reference.modules.has(id)) return `\0${id}`; },
    load(id) { return reference.modules.get(id.replace(/^\0/, "")); },
    transform(source, id) {
      if (process.env.WORK_REFERENCE === "1" && id.endsWith("/tests/fixtures/work-status.tsx")) {
        return 'import { ReferenceConversation as Conversation } from "/tests/fixtures/work-status-reference-host.tsx";\n'
          + source.replace("import { Conversation,", "import { Conversation as VelaConversation,");
      }
    }, configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/work-status.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("globalThis.__name = (value) => value;");
  const cases = process.env.WORK_INTERIM_SHRINK === "1"
    ? ["conversation&production&long&unphased&interim-shrink" + (process.env.WORK_SEALED_PREVIEW === "1" ? "&sealed-preview" : "")]
    : process.env.WORK_TRANSITION_ONLY === "1"
    ? ["conversation&transition-final", "conversation&transition-final&production", "conversation&late-final", "conversation&late-final&hold", "conversation&late-final&production&long"]
    : ["conversation", "conversation&unphased", "conversation&no-final-clock", "conversation&unphased&no-final-clock",
    "conversation&production&long", "conversation&production&long&unphased", "conversation&production&long&no-final-clock", "conversation&production&long&unphased&no-final-clock",
    "conversation&production&long&natural&no-final-clock", "conversation&late-final", "conversation&production&long&late-final"];
  for (const query of cases) {
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as any).port}/?${query}`);
    if (process.env.WORK_DISABLE_CONTENT_VISIBILITY === "1") {
      await page.addStyleTag({ content: '[data-virtualized-turn-content] { content-visibility: visible !important; contain-intrinsic-size: none !important; }' });
    }
    try { await page.waitForFunction(() => (window as any).scrollApi); }
    catch (error) { console.error(JSON.stringify({ errors, query })); throw error; }
    if (!query.includes("transition-final")) await page.evaluate(() => (window as any).final());
    await page.waitForTimeout(600);
    if (!query.includes("hold")) await page.evaluate(() => (window as any).scrollApi.scrollToBottom());
    await page.waitForTimeout(400);
    if (process.env.WORK_INTERIM_SHRINK === "1") {
      await page.locator('.thread-scroll,.thread-scroll-container').hover();
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(150);
      await page.mouse.wheel(0, -10000);
      await page.waitForTimeout(500);
    }
    const trace = await page.evaluate(async (transitionFinal: boolean) => {
      const label = document.querySelector("[data-work-status]");
      const writes: any[] = [];
      const originalScrollTo = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (...args: any[]) {
        writes.push({ args, before: this.scrollTop, height: this.scrollHeight, stack: new Error().stack });
        return originalScrollTo.apply(this, args as any);
      };
      const sample = () => {
        const scroll = document.querySelector(".thread-scroll,.thread-scroll-container")!;
        const modes: string[] = [];
        const fiberKey = Object.keys(scroll).find(key => key.startsWith('__reactFiber'));
        const seen = new Set<any>();
        const visit = (fiber: any) => {
          if (!fiber || seen.has(fiber)) return;
          seen.add(fiber);
          let hook = fiber.memoizedState;
          while (hook && typeof hook === 'object' && 'memoizedState' in hook) {
            const value = hook.memoizedState;
            if (value?.current?.followMode) modes.push(value.current.followMode);
            hook = hook.next;
          }
          visit(fiber.child); visit(fiber.sibling);
        };
        if (fiberKey) visit((scroll as any)[fiberKey]);
        const row = document.querySelector(".thread-turn")!;
        const current = document.querySelector("[data-work-status]");
        const box = (el: Element | null) => el ? { top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height } : null;
        const textRange = current === null ? null : document.createRange();
        if (current !== null) textRange?.selectNodeContents(current);
        const textRect = textRange?.getBoundingClientRect();
        return { label: current?.textContent, sameLabel: current === label, labelBox: box(current), row: box(row),
          writes: writes.splice(0), modes,
          labelTextBox: textRect == null ? null : { top: textRect.top, height: textRect.height },
          scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, viewport: scroll.clientHeight,
          spacer: box(document.querySelector(".thread-response-spacer")), actions: box(document.querySelector(".thread-message-actions")),
          divider: box(document.querySelector(".thread-work-status")), header: box(document.querySelector(".thread-agent-activity__turn-header")),
          documents: Array.from(document.querySelectorAll('.opencraft-chat-document')).map(el => ({ box: box(el), textLength: el.textContent?.length, parent: el.parentElement?.className })),
          activity: Array.from(document.querySelectorAll('.thread-agent-activity,.thread-agent-activity__unit,.thread-agent-activity__outer-content')).map(el => ({ className: el.className, box: box(el), textLength: el.textContent?.length, style: el.getAttribute('style') })),
          transforms: Array.from(document.querySelectorAll(".thread-agent-activity__outer-content,.thread-work-status")).map(el => ({transform:getComputedStyle(el).transform,height:el.getBoundingClientRect().height,opacity:getComputedStyle(el).opacity})),
        };
      };
      const samples = [sample()];
      if (new URLSearchParams(location.search).has('interim-shrink')) (window as any).interim();
      else if (transitionFinal) (window as any).final(); else (window as any).complete();
      for (let i = 0; i < 30; i++) { await new Promise(requestAnimationFrame); samples.push(sample()); }
      if (new URLSearchParams(location.search).has('interim-shrink')) {
        (window as any).complete();
        for (let i = 0; i < 30; i++) { await new Promise(requestAnimationFrame); samples.push(sample()); }
      }
      Element.prototype.scrollTo = originalScrollTo;
      return samples;
    }, query.includes("transition-final"));
    if (query.includes("interim-shrink")) {
      assert.ok(trace[0]!.modes.includes("static"), "shrink probe must start detached, not user_follow");
      if (query.includes("sealed-preview")) {
        for (const sample of trace.slice(0, 31)) {
          assert.ok(Math.abs(sample.scrollTop - trace[0]!.scrollTop) <= 1, "interim sealing moved the viewport");
          assert.ok(Math.abs(sample.row!.height - trace[0]!.row!.height) <= 1, "interim sealing moved content between slots");
          assert.ok(sample.modes.includes("static"), "interim sealing changed follow mode");
        }
      }
      {
        const minimumRowHeight = Math.min(trace[0]!.row!.height, trace[30]!.row!.height);
        for (const sample of trace.slice(0, 31)) {
          assert.ok(sample.row!.height >= minimumRowHeight - 1,
            "mounted measured row exposed an intrinsic placeholder height during phase transfer");
        }
      }
    }
    if (query.includes("late-final")) {
      // The text is unchanged; only work ownership/collapse changes. It may
      // keep the previous measurement until RO, but cannot commit both trees.
      const first = trace[0]!;
      const last = trace.at(-1)!;
      const maximumScrollHeight = Math.max(first.scrollHeight, last.scrollHeight);
      const minimumTop = Math.min(first.row!.top, last.row!.top);
      const maximumTop = Math.max(first.row!.top, last.row!.top);
      for (const sample of trace) {
        assert.ok(sample.scrollHeight <= maximumScrollHeight + 1, `${query}: outgoing content counted twice`);
        assert.ok(sample.row!.top >= minimumTop - 1 && sample.row!.top <= maximumTop + 1, `${query}: transient measurement displaced reading position`);
        if (sample.spacer && first.row!.top === 0 && last.row!.top === 0) {
          assert.ok(sample.spacer.top <= Math.max(first.row!.height, last.row!.height) + 1, `${query}: stale outgoing work leaked into virtual-list height`);
        }
      }
    }
    console.log(JSON.stringify({ query, trace }));
  }
  assert.deepEqual(errors, []);
  console.log(process.env.WORK_INTERIM_SHRINK === "1"
    ? "Interim shrink captured; detached initial state asserted. Visible/reference cases reject placeholder collapse; reading-position trace remains diagnostic."
    : "Working/Worked diagnostic completed; late-final cases passed measurement assertions.");
} finally { await browser?.close(); await vite.close(); }
