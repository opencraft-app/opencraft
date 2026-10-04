import assert from "node:assert/strict";
import { createServer } from "vite";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{
    name: "conversation-scroll-smoke",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/") return next();
        response.setHeader("content-type", "text/html");
        response.end('<div id="root"></div><script type="module" src="/tests/fixtures/conversation-scroll.tsx"></script>');
      });
    },
  }],
});
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const traceResize = process.env.CODEX_SCROLL_TRACE_RESIZE === "1";
  if (traceResize) {
    const evaluate = page.evaluate.bind(page);
    page.evaluate = async (fn: unknown, arg?: unknown) => {
      const label = String(fn);
      if (!label.includes("requestAnimationFrame")) {
        await evaluate((label: string) => { (window as any).resizeStep = label; }, label.slice(0, 300));
      }
      return evaluate(fn, arg);
    };
  }
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript((trace: boolean) => {
    (window as any).resizeWarnings = [];
    const batches: unknown[] = [];
    if (trace) {
      const NativeResizeObserver = window.ResizeObserver;
      let observerId = 0;
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          const id = ++observerId;
          const origin = new Error().stack;
          super((records, observer) => {
            const targets = records.map((record) => ({
              tag: record.target.tagName,
              class: record.target.getAttribute("class"),
              turn: (record.target as HTMLElement).dataset.virtualizedTurnKey,
              reportedHeight: record.borderBoxSize[0]?.blockSize,
              before: record.target.getBoundingClientRect().height,
              after: 0,
            }));
            callback(records, observer);
            targets.forEach((target, index) => { target.after = records[index]!.target.getBoundingClientRect().height; });
            batches.push({ id, origin, time: performance.now(), step: (window as any).resizeStep, targets });
            if (batches.length > 30) batches.shift();
          });
        }
      };
    }
    window.addEventListener("error", (event) => {
      if (event.message.includes("ResizeObserver loop")) (window as any).resizeWarnings.push(trace
        ? { time: performance.now(), step: (window as any).resizeStep, batches: [...batches] }
        : performance.now());
    });
  }, traceResize);
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 40; i++) await new Promise(requestAnimationFrame); });
  await settle();
  const events = await page.evaluate(() => (window as any).events);
  assert.equal(events.find((event: any) => event.kind === "turn-height" && event.turnKey === "turn-5")?.heightDeltaPx, 0);
  assert.ok(events.some((event: any) => event.kind === "follow-content"));
  assert.equal(await page.evaluate(() => (window as any).placementReads), 1, "initial live mount consumes placement through the same Activity transition");

  await page.evaluate(() => { (window as any).api.scrollToBottom(); (window as any).change(5, 260); });
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), "streaming user-follow must stay at bottom");

  await page.evaluate(() => (window as any).owner.scrollController.scrollToDistanceFromBottomPx(1000, "instant", "user"));
  await settle();
  const top = () => page.locator('[data-probe="text-3"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
  const anchor = await top();
  await page.evaluate(() => (window as any).change(4, 720));
  await settle();
  assert.ok(Math.abs(await top() - anchor) < 2, "historical growth below the anchor must preserve reading position during generation");
  await page.evaluate(() => (window as any).change(5, 360));
  await settle();
  assert.ok(Math.abs(await top() - anchor) < 2, "latest growth must preserve user-owned reading position");
  await page.evaluate(() => (window as any).complete());
  await settle();
  assert.ok(Math.abs(await top() - anchor) < 2, "completion must not move the reading anchor");
  await page.evaluate(() => (window as any).api.scrollToBottom());
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1));

  await page.evaluate(() => {
    const content = document.querySelector('[data-probe="text-5"]')!;
    (content.closest(".thread-frame") as HTMLElement).style.height = "700px";
  });
  await settle();
  await page.evaluate(() => { (window as any).events.length = 0; (window as any).change(5, 400); });
  await settle();
  const contentOnly = await page.evaluate(() => (window as any).events);
  assert.ok(contentOnly.some((event: any) => event.kind === "follow-content"), "follow content must notify even when total row height is unchanged");
  assert.ok(!contentOnly.some((event: any) => event.kind === "turn-height"), "content-only change must not fabricate a row-height event");

  await page.evaluate(() => { (window as any).events.length = 0; (window as any).restartPrework(); });
  await settle();
  await page.evaluate(() => (window as any).setPhase("commentary"));
  await settle();
  await page.evaluate(() => (window as any).change(5, 900));
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), "overflowing work content must enter prework-follow");
  await page.evaluate(() => (window as any).setPhase("final_answer"));
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), "prework-follow transfers to final-answer follow");
  // A Turn can span many viewports without a new Activity/placement. Content
  // growth follows only in an acquired follow mode, never because it is long.
  for (const height of [1800, 3600, 6000]) {
    await page.evaluate((value: number) => (window as any).change(5, value), height);
    await settle();
    assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), `an acquired follow must survive a ${height}px Turn`);
  }
  await page.locator(".thread-scroll").hover();
  await page.mouse.wheel(0, -650);
  await settle();
  assert.ok(await page.evaluate(() => -document.querySelector(".thread-scroll")!.scrollTop > 300), "real wheel input must take over long-Turn reading");
  const longTop = () => page.locator('[data-probe="text-5"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
  const longReadingTop = await longTop();
  await page.evaluate(() => (window as any).change(5, 6800));
  await settle();
  assert.ok(Math.abs(await longTop() - longReadingTop) < 2, "long-Turn growth must not steal the user's wheel-owned reading position");
  await page.evaluate(() => (window as any).api.scrollToBottom());
  await settle();
  await page.evaluate(() => (window as any).change(5, 7600));
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), "explicit bottom intent must reacquire follow within the same long Turn");
  const warningCount = await page.evaluate(() => (window as any).resizeWarnings.length);
  if (traceResize) console.log("ResizeObserver trace:", JSON.stringify(await page.evaluate(() => (window as any).resizeWarnings)));
  assert.equal(warningCount, 0, "row layout must not trigger an ancestor ResizeObserver loop warning");
  await settle();
  assert.equal(await page.evaluate(() => (window as any).resizeWarnings.length), warningCount, "resize notifications must converge, not run an idle layout loop");
  assert.deepEqual(errors, []);
  console.log(`Conversation scroll passed: first measurement, independent follow targets, streaming bottom, historical/latest growth, completion, return to bottom, content-only resize, prework→final. Transient ResizeObserver warnings: ${warningCount}; no idle loop.`);

  // Full user + assistant rows. Unlike a lone placeholder, these exercise
  // normal send geometry, previous-row identity and retained response space.
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?submissions`);
  await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
  await settle();
  await page.evaluate(() => (window as any).api.scrollToBottom());
  await settle();
  const geometry = (index: number) => page.evaluate((i: number) => ({
    top: document.querySelector(`[data-probe="text-${i}"]`)!.getBoundingClientRect().top,
    distance: -document.querySelector(".thread-scroll")!.scrollTop,
    spacer: document.querySelector(".thread-response-spacer")!.getBoundingClientRect().height,
    reads: (window as any).placementReads as number,
  }), index);
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const oldIndex = 5 + round;
    const before = await geometry(oldIndex);
    const frames = await page.evaluate(async (i: number) => {
      const prior = document.querySelector(`[data-probe="text-${i}"]`)!;
      (window as any).submit();
      const tops: number[] = [];
      for (let frame = 0; frame < 45; frame++) {
        await new Promise(requestAnimationFrame);
        tops.push(document.querySelector(`[data-probe="text-${i}"]`)!.getBoundingClientRect().top);
      }
      return {
        tops,
        sameNode: prior === document.querySelector(`[data-probe="text-${i}"]`),
        newHeight: (document.querySelector(`[data-virtualized-turn-key="turn-${i + 1}"]`) as HTMLElement).offsetHeight,
      };
    }, oldIndex);
    const placed = await geometry(oldIndex);
    assert.ok(frames.sameNode, "demotion to history must preserve the exact rendered subtree");
    assert.equal(placed.reads, before.reads + 1, "one Activity consumes one submission snapshot");
    assert.ok(Math.abs(placed.distance - 1) < 1, "r3562 placement target is 1px");
    const expectedShift = frames.newHeight + 12 + before.distance - 1 + placed.spacer - before.spacer;
    assert.ok(Math.abs((before.top - placed.top) - expectedShift) < 2, "history movement must be fully accounted for, with no extra compensation");
    assert.ok(frames.tops.every((value, i) => i === 0 || value <= frames.tops[i - 1]! + 2), "send animation must not jump up and recoil");
    if (round > 0) assert.ok(Math.abs(placed.spacer - before.spacer) < 1, "consecutive sends reuse existing response space");
    await page.evaluate(() => (window as any).renderAgain());
    await settle();
    assert.equal((await geometry(oldIndex)).reads, placed.reads, "rerenders cannot consume or replay placement");
    await page.evaluate(() => (window as any).setPhase("final_answer"));
    await settle();
    await page.evaluate(() => (window as any).complete());
    await settle();
    const completed = await geometry(oldIndex);
    assert.ok(Math.abs(completed.top - placed.top) < 2, "answer and completion preserve history's reading position");
    assert.ok(Math.abs(completed.spacer - placed.spacer) < 1, "completion stops animation without disposing the spacer");
    rounds.push({ spacerBefore: before.spacer, spacerAfter: placed.spacer, historyShift: before.top - placed.top });
  }

  // Away from the placement threshold, explicit submission preserves reading.
  await page.evaluate(() => (window as any).change(8, 900));
  await settle();
  await page.evaluate(() => (window as any).owner.scrollController.scrollToDistanceFromBottomPx(1000, "instant", "user"));
  await settle();
  const readingAnchor = await page.locator('[data-probe="text-6"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
  // Isolate signed snapshot correction from a different boundary: first
  // measurement of a previously unmounted latest Turn. 224px text + 56px row
  // chrome equals the virtualizer's 280px estimate (see the documented limit).
  await page.evaluate(() => (window as any).submit({ phase: "final_answer", height: 224, shrinkPreviousTo: 20 }));
  await settle();
  assert.equal(await page.evaluate(() => (window as any).lastPlacement.shouldPlaceLatestTurn), false);
  const shrink = await page.evaluate(() => ({ before: (window as any).lastPlacement.scrollHeightPx, after: document.querySelector(".thread-scroll")!.scrollHeight }));
  assert.ok(shrink.after < shrink.before, `the preservation case must actually include negative total height change: ${JSON.stringify(shrink)}`);
  const readingAfter = await page.locator('[data-probe="text-6"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
  assert.ok(Math.abs(readingAfter - readingAnchor) < 2, `history-reading submit must retain the anchor even as prior content shrinks: ${JSON.stringify({ readingAnchor, readingAfter, shrink })}`);
  const reads = await page.evaluate(() => (window as any).placementReads);
  await page.evaluate(() => (window as any).renderAgain());
  await settle();
  assert.equal(await page.evaluate(() => (window as any).placementReads), reads);

  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?submissions`);
  await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
  await settle();
  await page.evaluate(() => (window as any).owner.scrollController.scrollToDistanceFromBottomPx(1000, "instant", "user"));
  await settle();
  await page.evaluate(() => (window as any).submit({ local: false }));
  await settle();
  const external = await page.evaluate(() => ({
    spacer: document.querySelector(".thread-response-spacer")!.getBoundingClientRect().height,
    distance: -document.querySelector(".thread-scroll")!.scrollTop,
    reads: (window as any).placementReads,
  }));
  assert.equal(external.spacer, 0, "a replica-only Activity cannot create local-submit response space");
  assert.ok(external.distance > 300, "a replica-only Activity cannot run the 1px placement");
  await page.evaluate(() => (window as any).renderAgain());
  await settle();
  assert.equal(await page.evaluate(() => (window as any).placementReads), external.reads);

  // Capturing a restore checkpoint is a pure persistence projection. The
  // response API may publish a new facade at this phase boundary, but that
  // cleanup must not promote prework_watch to prework_follow in the live
  // viewport and accidentally dispose the response spacer on the first
  // final-answer character.
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?submissions`);
  await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
  await settle();
  await page.evaluate(() => { (window as any).api.scrollToBottom(); (window as any).submit({ phase: "commentary", height: 60 }); });
  await settle();
  const preworkBoundary = await page.locator('[data-probe="text-6"]').evaluate((element: HTMLElement) => ({
    top: element.getBoundingClientRect().top,
    spacer: document.querySelector(".thread-response-spacer")!.getBoundingClientRect().height,
  }));
  await page.evaluate(() => (window as any).setPhase("final_answer"));
  await settle();
  const finalBoundary = await page.locator('[data-probe="text-6"]').evaluate((element: HTMLElement) => ({
    top: element.getBoundingClientRect().top,
    spacer: document.querySelector(".thread-response-spacer")!.getBoundingClientRect().height,
  }));
  assert.ok(Math.abs(finalBoundary.top - preworkBoundary.top) < 2, "a non-following prework → first-answer handoff must redraw in place");
  assert.ok(
    finalBoundary.spacer > 24,
    `restore snapshot capture cannot dispose live response space: ${JSON.stringify({ preworkBoundary, finalBoundary })}`,
  );

  // Codex OD has no "long final answer => follow" transition. A directly
  // streamed final answer retains its starting position until bottom intent.
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?submissions`);
  await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
  await settle();
  await page.evaluate(() => { (window as any).api.scrollToBottom(); (window as any).submit(); });
  await settle();
  await page.evaluate(() => (window as any).setPhase("final_answer"));
  await settle();
  const answerTop = () => page.locator('[data-probe="text-6"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
  const answerStart = await answerTop();
  for (const height of [1800, 3600]) {
    await page.evaluate((value: number) => (window as any).change(6, value), height);
    await settle();
    assert.ok(Math.abs(await answerTop() - answerStart) < 2, "direct final-answer streaming preserves its beginning, as Codex static mode does");
  }
  await page.evaluate(() => (window as any).api.scrollToBottom());
  await settle();
  await page.evaluate(() => (window as any).change(6, 4400));
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), "bottom intent must acquire follow even for a directly streamed long final answer");
  const beforeRestoreReads = await page.evaluate(() => (window as any).placementReads);
  await page.evaluate(() => (window as any).unmount());
  await settle();
  assert.ok(await page.evaluate(() => (window as any).restoreSnapshot?.turnFollow?.turnKey === "turn-6"), "restore must use the snapshot emitted by the actual unmount lifecycle");
  await page.evaluate(() => (window as any).remountFromSnapshot());
  await settle();
  assert.equal(await page.evaluate(() => (window as any).placementReads), beforeRestoreReads, "restoring an active Turn must not acquire the fresh-mount placement allowance");
  await page.evaluate(() => (window as any).change(6, 5200));
  await settle();
  assert.ok(await page.evaluate(() => Math.abs(document.querySelector(".thread-scroll")!.scrollTop) < 1), "restored user-follow must keep following the same long Turn");
  assert.deepEqual(errors, []);
  console.log(`Continuous submit passed: stable DOM, once-only placement, retained spacer, frame-by-frame motion, completion, signed shrink, reading anchor, replica-only updates, long-Turn static/follow/wheel/restore. ${JSON.stringify(rounds)}`);
  for (const policy of ["natural", "response-placement"]) {
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?submissions&handoff${policy === "natural" ? "&natural" : ""}`);
    await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
    await settle();
    await page.evaluate(() => (window as any).api.scrollToBottom());
    await settle();
    for (let index = 6; index < 9; index++) {
      await page.evaluate(() => (window as any).submit());
      await settle();
      await page.evaluate((index: number) => {
        const row = document.querySelector(`[data-virtualized-turn-key="turn-${index}"]`);
        if (row === null) throw new Error("optimistic latest row must be mounted");
        (window as any).handoffRow = row;
        (window as any).handoffBubble = row.querySelector(".thread-user-message");
        (window as any).acknowledge();
      }, index);
      await settle();
      const identity = await page.evaluate((index: number) => {
        const row = document.querySelector(`[data-virtualized-turn-key="authority-${index}"]`);
        return { mounted: row !== null, sameRow: row === (window as any).handoffRow,
          sameBubble: row?.querySelector(".thread-user-message") === (window as any).handoffBubble };
      }, index);
      assert.deepEqual(identity, { mounted: true, sameRow: true, sameBubble: true },
        `${policy}: canonical ID acknowledgement must retain the actual latest DOM without a scroll event`);
      await page.evaluate((index: number) => { (window as any).setPhase("commentary"); (window as any).change(index, 600); }, index);
      await settle();
      assert.equal(await page.locator(`[data-probe="text-${index}"]`).count(), 1,
        `${policy}: streaming after acknowledgement cannot remain outside the window`);
      await page.evaluate(() => (window as any).complete());
      await settle();
    }
    // Canonical acknowledgement while reading history cannot acquire bottom
    // ownership. Its height correction must retain the reader's anchor.
    await page.evaluate(() => (window as any).owner.scrollController.scrollToDistanceFromBottomPx(800, "instant", "user"));
    await settle();
    await page.evaluate(() => (window as any).submit({ phase: "final_answer", height: 224 }));
    await settle();
    const readingTop = await page.locator('[data-probe="text-8"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
    const distanceBeforeAck = await page.evaluate(() => -(document.querySelector(".thread-scroll") as HTMLElement).scrollTop);
    await page.evaluate(() => (window as any).acknowledge());
    await settle();
    const readingAfterAck = await page.locator('[data-probe="text-8"]').evaluate((element: HTMLElement) => element.getBoundingClientRect().top);
    const distanceAfterAck = await page.evaluate(() => -(document.querySelector(".thread-scroll") as HTMLElement).scrollTop);
    assert.ok(Math.abs(readingTop - readingAfterAck) < 2,
      `${policy}: identity handoff must preserve the user's history-reading anchor: ${JSON.stringify({ readingTop, readingAfterAck, distanceBeforeAck, distanceAfterAck })}`);
    assert.deepEqual(await page.evaluate(() => (window as any).resizeWarnings), []);
  }
  console.log("Canonical handoff passed in both policies: three consecutive sends retain exact latest row/bubble, stream without scroll, preserve history-reading anchor, zero resize warnings.");
  for (const policy of ["response-placement", "natural"]) {
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?history${policy === "natural" ? "&natural" : ""}`);
    await page.waitForFunction(() => (window as any).api && document.querySelector('[data-probe="text-5"]'));
    await settle();
    assert.equal(await page.evaluate(() => (window as any).historyLoads), 0, "a filled viewport needs no history fetch");
    await page.evaluate(() => (window as any).shrinkHistory());
    await settle();
    assert.equal(await page.evaluate(() => (window as any).historyLoads), 1, `${policy}: committed content shrink must request history without observing the surface`);
    await page.evaluate(() => (window as any).renderAgain());
    await settle();
    assert.equal(await page.evaluate(() => (window as any).historyLoads), 1, "a render alone cannot request another page");
    assert.deepEqual(await page.evaluate(() => (window as any).resizeWarnings), []);
  }
  assert.deepEqual(errors, []);
  console.log("History fill passed in both policies: content shrink loads once, rerender does not reload, zero ResizeObserver warnings.");
} finally {
  await browser?.close();
  await vite.close();
}
