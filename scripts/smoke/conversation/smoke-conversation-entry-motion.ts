import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
const output = ".local/conversation-entry-motion";
await mkdir(output, {recursive: true});
const vite = await createServer({root: process.cwd(), configFile: false, logLevel: "error", resolve: {dedupe: ["react", "react-dom"]},
  cacheDir: "node_modules/.vite-conversation-entry-motion", esbuild: {jsx: "automatic", target: "esnext"}, server: {host: "127.0.0.1", port: 0, hmr: false},
  plugins: [{name: "entry-fixture", configureServer(server) {server.middlewares.use((req,res,next) => {
    if (req.url !== "/") return next();
    res.setHeader("content-type", "text/html");
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-entry-motion.tsx"></script>');
  });}}]});
const restorationEvidence: unknown[] = [];
let browser;
try {
  await vite.listen(); browser = await chromium.launch({headless: true, args: ["--no-sandbox"]});
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({viewport: {width: touch ? 390 : 900, height: 800}, hasTouch: touch, isMobile: touch});
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(vite.resolvedUrls!.local[0]!); await page.locator("[data-work-status]").waitFor();
    await page.evaluate(theme => (window as any).entryFixture.theme(theme), theme);
    // Observe the first DOM commit rather than auto-waiting for a hidden row.
    const sample = async (method: string, arg?: string) => page.evaluate(async ({method,arg}) => {
      const before = document.querySelector("[data-fixture-revision]")!.getAttribute("data-fixture-revision");
      return await new Promise<{opacity: number; height: number; outerOpacity: number}>(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector("[data-fixture-revision]")!.getAttribute("data-fixture-revision") === before) return;
          const label = document.querySelector<HTMLElement>("[data-work-status]");
          if (!label) return;
          observer.disconnect();
          let opacity = 1;
          for (let node: HTMLElement | null = label; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
          const divider = label.closest(".thread-work-status");
          const outer = label.closest(".thread-agent-activity__outer-content");
          resolve({opacity, height: divider?.getBoundingClientRect().height ?? label.getBoundingClientRect().height,
            outerOpacity: outer ? Number(getComputedStyle(outer).opacity) : 1});
        });
        observer.observe(document.getElementById("root")!, {childList: true, subtree: true, attributes: true});
        (window as any).entryFixture[method](arg);
      });
    }, {method,arg});
    // A restored running tool group must never expose its bash body, even for
    // the first commit before effects run or during the following animation frames.
    for (const method of ["restore", "switchInPlace"]) for (const scope of ["B", "A"]) {
      const samples = await page.evaluate(async ({method, scope}) => {
        const values: {phase: string | null; height: number; open: string | null}[] = [];
        const before = document.querySelector("[data-fixture-revision]")!.getAttribute("data-fixture-revision");
        const sampling = {sample() {
          const group = document.querySelector<HTMLElement>(".thread-agent-activity__group-disclosure");
          if (group) values.push({phase: group.dataset.disclosurePhase ?? null,
            height: group.querySelector(".thread-activity-item__body-clip")?.getBoundingClientRect().height ?? 0,
            open: group.querySelector("button")?.getAttribute("aria-expanded") ?? null});
        }};
        const observer = new MutationObserver(() => {
          if (document.querySelector("[data-fixture-revision]")!.getAttribute("data-fixture-revision") !== before) sampling.sample();
        });
        observer.observe(document.getElementById("root")!, {childList: true, subtree: true, attributes: true});
        (window as any).entryFixture[method](scope);
        const started = performance.now();
        while (performance.now() - started < 250) {await new Promise(requestAnimationFrame);sampling.sample();}
        observer.disconnect();
        return values;
      }, {method, scope});
      restorationEvidence.push({touch, theme, method, scope, samples});
      assert.ok(samples.length > 0, "running commands must create a real tool group");
      assert.ok(samples.every(s => s.phase === "collapsed" && s.height === 0 && s.open === "false"),
        `${method} ${scope}: restored bash group must stay folded: ${JSON.stringify(samples)}`);
    }
    for (const [method,arg] of [["restore","B"],["restore","A"],["switchInPlace","B"],["switchInPlace","A"]]) {
      const first = await sample(method!,arg);
      assert.equal(first.opacity, 1, `${method}: restored label must be visible in the first commit`);
      assert.ok(first.height > 0); assert.equal(first.outerOpacity, 1);
    }
    await page.screenshot({path: `${output}/folded-${touch ? "touch" : "desktop"}-${theme}.png`});
    const groupToggle = page.locator(".thread-agent-activity__group-disclosure button");
    await groupToggle.click();
    await page.waitForFunction(() => document.querySelector(".thread-agent-activity__group-disclosure")?.getAttribute("data-disclosure-phase") === "expanded");
    assert.equal(await groupToggle.getAttribute("aria-expanded"), "true");
    await page.screenshot({path: `${output}/expanded-${touch ? "touch" : "desktop"}-${theme}.png`});
    // Replacing live data for the same group must retain the user's open choice.
    await page.evaluate(() => (window as any).entryFixture.liveWork());
    assert.equal(await groupToggle.getAttribute("aria-expanded"), "true");
    await groupToggle.click();
    await page.waitForFunction(() => document.querySelector(".thread-agent-activity__group-disclosure")?.getAttribute("data-disclosure-phase") === "collapsed");
    await page.evaluate(() => (window as any).entryFixture.beginRecovery());
    await page.waitForFunction(() => !document.querySelector("[data-work-status]"));
    assert.equal((await sample("preview")).opacity, 1, "progressive recovery is a baseline");
    assert.equal((await sample("confirm")).opacity, 1, "authoritative promotion cannot replay entry");
    await page.evaluate(() => (window as any).entryFixture.emptyLive());
    await page.waitForFunction(() => !document.querySelector("[data-work-status]"));
    const inserted = await sample("liveWork");
    assert.equal(inserted.opacity, 0, "new live work retains its entry animation");
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).entryFixture.finish());
    const toggle = page.locator(".thread-agent-activity__turn-header button"); await toggle.waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const box = await page.evaluate(async () => {
      const result = new Promise<number>(resolve => new MutationObserver((_,observer) => {
        const e = document.querySelector(".thread-agent-activity__outer-content");
        if (e) {observer.disconnect();resolve(Number(getComputedStyle(e).opacity));}
      }).observe(document.getElementById("root")!, {childList: true, subtree: true}));
      document.querySelector<HTMLButtonElement>(".thread-agent-activity__turn-header button")!.click();
      return result;
    });
    assert.equal(box, 0, "manual expansion retains its animation");
    await page.waitForTimeout(350);
    await toggle.click();
    await page.evaluate(() => (window as any).entryFixture.reconnect());
    await page.waitForTimeout(30);
    const syncingExpansion = await page.evaluate(async () => {
      const result = new Promise<number>(resolve => new MutationObserver((_,observer) => {
        const e = document.querySelector(".thread-agent-activity__outer-content");
        if (e) {observer.disconnect();resolve(Number(getComputedStyle(e).opacity));}
      }).observe(document.getElementById("root")!, {childList: true, subtree: true}));
      document.querySelector<HTMLButtonElement>(".thread-agent-activity__turn-header button")!.click();
      return result;
    });
    assert.equal(syncingExpansion, 0, "manual expansion remains animated during recovery too");
    await page.waitForTimeout(350);
    await page.screenshot({path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png`});
    assert.deepEqual(errors, []); await context.close();
  }
  await writeFile(`${output}/restoration-frames.json`, JSON.stringify(restorationEvidence, null, 2));
  console.log("Conversation entry: warm remount/in-place switch, progressive restore, authority promotion, live insertion and manual expansion passed on desktop/touch × light/dark.");
} finally {await browser?.close(); await vite.close();}
