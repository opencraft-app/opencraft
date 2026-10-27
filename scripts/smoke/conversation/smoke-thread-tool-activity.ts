import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const output = resolve(process.env.OPENCRAFT_THREAD_TOOL_REPORT ?? ".local/thread-tool-activity");
await mkdir(output, { recursive: true });
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  esbuild: { jsx: "automatic" }, resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: "node_modules/.vite-thread-tool-activity", server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "thread-tool-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/thread-tool-activity.tsx"></script>');
    });
  } }],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let inspectedPage: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
const results = [];
const restoreOnly = process.argv.includes("--restore-only");
const handoffOnly = process.argv.includes("--handoff-live-only");
try {
  await vite.listen();
  browser = await chromium.launch({ executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  if (restoreOnly || !process.argv.some(value => value.endsWith("-only"))) {
    const restores = [];
    for (const width of [390, 1200]) for (const theme of ["light", "dark"]) for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 850 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion });
      inspectedPage = page;
      const errors: string[] = [];
      page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
      await page.addInitScript("window.__name=value=>value");
      await page.goto(vite.resolvedUrls!.local[0]! + `?scenario=live&single=1&restore=1&theme=${theme}`);
      const group = page.locator(".thread-agent-activity__group-disclosure > .thread-activity-item__header button");
      if (width === 390) await group.tap(); else await group.click();
      await page.waitForFunction(() => document.querySelector(".thread-agent-activity__group-disclosure")?.getAttribute("data-disclosure-phase") === "expanded");
      await page.waitForTimeout(350);
      await page.evaluate(() => (window as any).setMounted(false));
      await page.waitForFunction(() => !document.querySelector(".thread-agent-activity__group"));
      const snapshot = await page.evaluate(() => (window as any).capturedRestore);
      assert(snapshot && Object.values(snapshot.agentActivityCollapsedById).includes(false));
      const frames = await page.evaluate(async () => {
        const frames: { at: number; height: number; natural: number; opacity: number; outerHidden: boolean }[] = [];
        let start: number | null = null;
        const done = new Promise<typeof frames>(resolve => {
          function frame(now: number) {
            const row = document.querySelector<HTMLElement>(".thread-activity-item[data-status='running']");
            const clip = row?.querySelector<HTMLElement>(":scope > .thread-activity-item__body-clip");
            const body = clip?.querySelector<HTMLElement>(":scope > .thread-activity-item__body");
            if (clip && body) {
              start ??= now;
              frames.push({ at: now - start, height: clip.getBoundingClientRect().height, natural: body.scrollHeight,
                opacity: Number(getComputedStyle(clip).opacity), outerHidden: clip.closest("[inert], [aria-hidden='true']") !== null });
            }
            if (start === null || now - start < 450) requestAnimationFrame(frame); else resolve(frames);
          }
          requestAnimationFrame(frame);
        });
        (window as any).setMounted(true);
        return await done;
      });
      assert(frames.length && frames.every(frame => !frame.outerHidden && frame.natural > 0));
      const violations = frames.filter(frame => Math.abs(frame.height - frame.natural) > 1 || frame.opacity !== 1);
      restores.push({ width, theme, reducedMotion, snapshot, frames, violations, errors });
      const tool = page.locator(".thread-activity-item[data-status='running'] > .thread-activity-item__header button");
      if (width === 390) await tool.tap(); else await tool.click();
      await page.waitForFunction(() => !document.querySelector(".thread-activity-item[data-status='running']")?.hasAttribute("data-open"));
      await page.waitForTimeout(350);
      if (width === 390) await tool.tap(); else await tool.click();
      await page.waitForFunction(() => Number.parseFloat((document.querySelector(".thread-activity-item[data-status='running'] > .thread-activity-item__body-clip") as HTMLElement).style.height) > 0);
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(output, `restore-${width}-${theme}-${reducedMotion}.png`) });
      assert.deepEqual(errors, []);
      await page.close();
    }
    await writeFile(join(output, "restoration-frames.json"), JSON.stringify(restores, null, 2));
    console.log(JSON.stringify(restores.map(({ width, theme, reducedMotion, violations }) => ({ width, theme, reducedMotion, violations: violations.length }))));
    assert.equal(restores.reduce((count, item) => count + item.violations.length, 0), 0, "restored open tool bodies have final geometry on the first painted frame");
    results.push({ restoredToolGeometry: true, scenes: restores.length });
  }

  if (!restoreOnly) {

  if (!handoffOnly && !process.argv.some(value => value.endsWith("-only"))) for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(vite.resolvedUrls!.local[0]! + `?scenario=review-view&restore=1&theme=${theme}`);
    await page.locator("[data-phase]").waitFor();
    await page.evaluate(() => (window as any).changeThreadToolPhase("completed"));
    await page.locator('[data-phase="completed"]').waitFor();
    const activate = (target: import("playwright").Locator) => width === 390 ? target.tap() : target.click();
    const reveal = async () => {
      const groups = page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header button[aria-expanded="false"]');
      for (let index = 0; index < 10 && await groups.count(); index++) await activate(groups.first());
    };
    await reveal();
    const reviews = page.locator('.thread-activity-item[data-body-variant="default"]:has(.thread-auto-review):not(:has(.thread-auto-review-list))');
    assert.equal(await reviews.count(), 2);
    const first = reviews.nth(0).locator(':scope > .thread-activity-item__header button[aria-expanded]');
    const second = reviews.nth(1).locator(':scope > .thread-activity-item__header button[aria-expanded]');
    const reason = reviews.nth(0).locator('.thread-auto-review > button');
    const otherReason = reviews.nth(1).locator('.thread-auto-review > button');
    const toolHeader = page.locator('.thread-activity-item[data-status] > .thread-activity-item__header').filter({ hasText: "Reviewed · Completed" });
    const tool = toolHeader.locator('button[aria-expanded]');
    const commandHeader = page.locator('.thread-activity-item[data-status]').last().locator(':scope > .thread-activity-item__header');
    const command = commandHeader.locator('button[aria-expanded]');
    const toolBody = toolHeader.locator('..');
    const commandBody = commandHeader.locator('..');
    const toolReason = toolBody.locator('.thread-auto-review > button').first();
    const toolOther = toolBody.locator('.thread-auto-review > button').nth(1);
    const commandReason = commandBody.locator('.thread-auto-review > button').first();
    const patchReason = page.locator('.thread-patch-activities .thread-auto-review > button');
    assert.equal(await patchReason.count(), 1);
    await activate(patchReason);
    await activate(first); await activate(second); await activate(reason);
    await activate(tool); await activate(toolReason);
    await activate(command); await activate(commandReason);
    await toolBody.getByText("DE_REASON_TOOL: completed", { exact: true }).waitFor();
    await activate(tool); await toolReason.waitFor({ state: "detached", timeout: 10000 });
    await activate(tool); await toolReason.waitFor();
    assert.equal(await toolReason.getAttribute("aria-expanded"), "true", "Reopening a tool retains its explicit review reason choice");
    const remount = async (fresh = false) => {
      await page.evaluate(() => (window as any).setThreadToolMounted(false));
      await first.waitFor({ state: "detached" });
      if (fresh) await page.evaluate(() => (window as any).clearThreadToolRestore());
      await page.evaluate(() => (window as any).setThreadToolMounted(true));
      if (fresh) await reveal();
      await first.waitFor();
    };
    await remount();
    // This branch's command body has local outer state; reopen it to inspect
    // the nested review choice independently of command scroll restoration.
    if (await command.getAttribute("aria-expanded") !== "true") await activate(command);
    for (const target of [first, second, reason, tool, toolReason, commandReason, patchReason])
      assert.equal(await target.getAttribute("aria-expanded"), "true", "Same View retains outer and nested review choices");
    for (const target of [otherReason, toolOther]) assert.equal(await target.getAttribute("aria-expanded"), "false", "Other review choices stay independent");
    await page.evaluate(() => (window as any).changeThreadToolPhase("failed"));
    await toolBody.getByText("DE_REASON_TOOL: failed", { exact: true }).waitFor();
    await activate(reason); await activate(first); await activate(toolReason); await remount();
    for (const target of [first, reason, toolReason]) assert.equal(await target.getAttribute("aria-expanded"), "false", "Same View retains explicit close choices");
    if (await command.getAttribute("aria-expanded") !== "true") await activate(command);
    assert.equal(await commandReason.getAttribute("aria-expanded"), "true");
    await remount(true);
    for (const target of [first, second, tool, command]) assert.equal(await target.getAttribute("aria-expanded"), "false", "Fresh settled View retains collapsed defaults");
    for (const target of [patchReason]) assert.equal(await target.getAttribute("aria-expanded"), "false", "Fresh patch reasons remain independent and collapsed");
    await activate(first); assert.equal(await reason.getAttribute("aria-expanded"), "false");
    await activate(tool); assert.equal(await toolReason.getAttribute("aria-expanded"), "false");
    await activate(command); assert.equal(await commandReason.getAttribute("aria-expanded"), "false");
    await remount(true);
    await page.evaluate(() => (window as any).changeThreadToolPhase("inProgress"));
    await page.locator('[data-phase="inProgress"]').waitFor();
    assert.equal(await first.getAttribute("aria-expanded"), "true", "Fresh running review keeps existing open default");
    assert.equal(await reason.getAttribute("aria-expanded"), "false", "Running review reason remains manual");
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    results.push({ width, theme, reviewViewChoices: true, toolReopen: true, independentReasons: true, refreshedRationale: true, explicitClose: true, freshDefaults: true });
    await page.close();
  }

  if (!process.argv.some(value => value.endsWith("-only")) || process.argv.includes("--website-view-only")) for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(vite.resolvedUrls!.local[0]! + `?scenario=webmcp-restore&restore=1&theme=${theme}`);
    const activate = (target: import("playwright").Locator) => width === 390 ? target.tap() : target.click();
    const openGroups = async () => {
      const groups = page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header button[aria-expanded="false"]');
      for (let index = 0; index < 10 && await groups.count(); index++) await activate(groups.first());
    };
    await page.locator("[data-phase]").waitFor(); await openGroups();
    const first = page.getByRole("button", { name: "Look up an item", exact: true });
    const second = page.getByRole("button", { name: "Plain response", exact: true });
    assert.equal(await first.getAttribute("aria-expanded"), "false");
    await activate(first); await activate(second);
    const remount = async (fresh = false) => {
      await page.evaluate(() => (window as unknown as { setThreadToolMounted(value: boolean): void }).setThreadToolMounted(false));
      await first.waitFor({ state: "detached" });
      if (fresh) await page.evaluate(() => (window as unknown as { clearThreadToolRestore(): void }).clearThreadToolRestore());
      await page.evaluate(() => (window as unknown as { setThreadToolMounted(value: boolean): void }).setThreadToolMounted(true));
      if (fresh) await openGroups();
      await first.waitFor();
    };
    await remount();
    assert.equal(await first.getAttribute("aria-expanded"), "true");
    assert.equal(await second.getAttribute("aria-expanded"), "true");
    const restoredOutput = page.locator('.thread-webmcp-details .chat-code-block pre').filter({hasText:'WEBSITE_RESULT'});
    await restoredOutput.waitFor();
    assert.deepEqual(JSON.parse(await restoredOutput.innerText()), {result:'WEBSITE_RESULT'});
    await activate(first); await remount();
    assert.equal(await first.getAttribute("aria-expanded"), "false");
    assert.equal(await second.getAttribute("aria-expanded"), "true");
    await remount(true);
    assert.equal(await first.getAttribute("aria-expanded"), "false");
    assert.equal(await second.getAttribute("aria-expanded"), "false");
    assert.deepEqual(errors, []);
    results.push({ width, theme, websiteViewChoices: true, independentCalls: true, freshViewCollapsed: true });
    await page.close();
  }
  if (!process.argv.includes("--raw-only") && !handoffOnly && !process.argv.includes("--host-content-only") && !process.argv.includes("--live-only")) for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}`);
    const nativeSummary = page.locator(".thread-tool-row .thread-activity-item__summary");
    // Group headers repeat the last activity title; inspect the actual status-bearing rows.
    const surfaceSummary = page.locator(".thread-activity-item[data-status] > .thread-activity-item__header .thread-activity-item__summary");
    await page.locator('[data-phase="inProgress"]').waitFor();
    const collapsed = page.locator('.thread-agent-activity__group button[aria-expanded="false"]');
    for (let index = 0; index < 20 && await collapsed.count() > 0; index++) await collapsed.first().click();
    assert.equal(await collapsed.count(), 0, "all native activity groups opened");
    await nativeSummary.filter({ hasText: "Fork thread · Worktree · Running" }).waitFor();
    await page.getByText("Get handoff status · Failed", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Open chat", exact: true }).filter({ hasText: "Read thread" }).click();
    await page.locator(".thread-created-thread-card").click();
    assert.deepEqual(await page.evaluate(() => (window as any).openedThreads), ["read-target", "created-target"]);
    const transferDisclosure = page.getByRole("button", { name: "Transfer · Review · Remote · Needs attention", exact: true });
    if (await transferDisclosure.getAttribute("aria-expanded") !== "true") await transferDisclosure.click();
    assert.equal(await transferDisclosure.getAttribute("aria-expanded"), "true");
    await page.getByText("Prepare host transfer", { exact: true }).waitFor();
    const steps = page.locator(".thread-handoff-step");
    assert.equal(await steps.filter({ hasText: "Create new worktree" }).getAttribute("data-status"), "pending");
    assert.equal(await steps.filter({ hasText: "Transfer host artifacts" }).getAttribute("data-status"), "failed");
    assert.equal(await steps.filter({ hasText: "Rolling back changes" }).count(), 0);
    const queuedDisclosure = page.getByRole("button", { name: "Transfer · Queued", exact: true });
    if (await queuedDisclosure.getAttribute("aria-expanded") !== "true") await queuedDisclosure.click();
    assert.equal(await queuedDisclosure.getAttribute("aria-expanded"), "true");
    assert.equal(await steps.filter({ hasText: "Custom prepare step" }).getAttribute("data-status"), "pending");
    for (const title of ["Browser click · Chrome", "Scroll · Notes · down", "Inspect workspace"]) {
      await surfaceSummary.filter({ hasText: `${title} · Running` }).waitFor();
    }
    for (const [phase, label] of [["completed", "Completed"], ["failed", "Failed"], ["interrupted", "Stopped"]]) {
      await page.evaluate(phase => (window as any).changeThreadToolPhase(phase), phase);
      await nativeSummary.filter({ hasText: `Fork thread · Worktree · ${label}` }).waitFor();
      for (const title of ["Browser click · Chrome", "Scroll · Notes · down", "Inspect workspace"]) {
        await surfaceSummary.filter({ hasText: `${title} · ${label}` }).waitFor();
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(output, `${width}-${theme}.png`) });
    assert.deepEqual(errors, []);
    results.push({ width, theme, navigationAndCreatedCard: true, transferSteps: true, failedPollVisible: true, reportedStepStates: true, allSurfacePhases: true, allPhases: true });
    console.log(JSON.stringify({ width, theme, passed: true }));
    await page.close();
  }
  for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=images`);
    await page.locator("[data-phase]").waitFor();
    const collapsed = page.locator('.thread-agent-activity__group button[aria-expanded="false"]');
    for (let index = 0; index < 20 && await collapsed.count() > 0; index++) await collapsed.first().click();
    const disclosure = page.getByRole("button", { name: "Inspect images · Completed", exact: true });
    if (await disclosure.getAttribute("aria-expanded") !== "true") await disclosure.click();
    const measureImages = async () => {
      await page.waitForFunction(() => {
        const images = [...document.querySelectorAll<HTMLImageElement>(".thread-tool-details img")];
        return images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0);
      });
      return page.locator(".thread-tool-details img").evaluateAll(images => images.map(element => {
        const image = element as HTMLImageElement;
        const rect = image.getBoundingClientRect();
        const section = image.closest("section")!;
        return { width: rect.width, height: rect.height, bottom: rect.bottom,
          nextTop: section.nextElementSibling!.getBoundingClientRect().top,
          availableWidth: image.closest(".thread-tool-details")!.getBoundingClientRect().width,
          naturalRatio: image.naturalWidth / image.naturalHeight };
      }));
    };
    const initial = await measureImages();
    for (const image of initial) {
      assert.ok(image.height <= 192.5, JSON.stringify(image));
      assert.ok(image.width <= image.availableWidth + 0.5, JSON.stringify(image));
      assert.ok(image.bottom <= image.nextTop + 0.5, "Tool image cannot cover the following result");
      assert.ok(Math.abs(image.width / image.height - image.naturalRatio) < 0.01);
    }
    assert.equal(initial[2]!.width, 96, "Small images keep their natural size");
    await disclosure.click();
    await disclosure.click();
    const reopened = await measureImages();
    assert.deepEqual(reopened, initial, "Reopening preserves bounded preview geometry");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `images-${width}-${theme}.png`) });
    results.push({ width, theme, boundedToolImages: true, followingContentClear: true, reopen: true });
    console.log(JSON.stringify({ width, theme, toolImages: true, passed: true }));
    await page.close();
  }
  if (!handoffOnly && !process.argv.includes("--raw-only") && !process.argv.includes("--host-content-only")) for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as {
        port: number;
    }).port}/?theme=${theme}&scenario=live`;
    await page.goto(url);
    await page.locator('[data-phase="running"]').waitFor();
    const activate = (n: ReturnType<typeof page.locator>) => width === 390 ? n.tap() : n.click();
    const reveal = async () => { for (let i = 0; i < 20; i++) {
        const closed = page.locator('.thread-agent-activity__group > .thread-agent-activity__group-disclosure > .thread-activity-item__header > button[aria-expanded="false"]');
        if (!await closed.count())
            break;
        await activate(closed.first());
    } };
    await reveal();
    const liveRow = page.locator('.thread-activity-item[data-status]').filter({ has: page.locator('.thread-activity-item__detail', { hasText: '/workspace/live.txt' }) }).first();
    await liveRow.waitFor();
    const live = liveRow.locator(':scope > .thread-activity-item__header button[aria-expanded]');
    await live.waitFor();
    const settledRow = page.locator('.thread-activity-item[data-status]').filter({ has: page.locator('.thread-activity-item__detail', { hasText: '/workspace/settled.txt' }) }).first();
    const mcpRow = page.locator('.thread-activity-item[data-status]').filter({ has: page.locator('.thread-activity-item__summary', { hasText: 'Mcp probe' }) }).first();
    await page.waitForFunction(() => (window as any).observed['live-write']?.status === 'running');
    const features: Record<string, boolean> = { liveInitiallyOpen: await live.getAttribute('aria-expanded') === 'true', liveBodyInitiallyVisible: await page.getByText('LIVE_WRITE_BODY', { exact: false }).first().isVisible(), mcpInitiallyClosed: await mcpRow.locator(':scope > .thread-activity-item__header button[aria-expanded]').getAttribute('aria-expanded') === 'false', settledInitiallyClosed: await settledRow.locator(':scope > .thread-activity-item__header button[aria-expanded]').getAttribute('aria-expanded') === 'false', compactPayloadSuppressed: !await page.getByText('COMPACT_PAYLOAD_CONTROL', { exact: false }).count() };
    await page.screenshot({ path: join(output, `live-${width}-${theme}-initial.png`) });
    if (await live.getAttribute('aria-expanded') === 'true')
        await activate(live);
    await page.evaluate(() => (window as any).setPhase('progress'));
    await page.locator('[data-phase="progress"]').waitFor();
    await page.waitForFunction(() => (window as any).observed['live-write']?.content === 'UPDATED_WRITE_BODY');
    features.manualCollapseRetained = await live.getAttribute('aria-expanded') === 'false';
    await activate(live);
    await page.getByText('UPDATED_WRITE_BODY', { exact: false }).first().waitFor();
    await page.evaluate(() => (window as any).setPhase('completed'));
    await page.locator('[data-phase="completed"]').waitFor();
    const settledLive = liveRow.getByRole('button', { name: 'Wrote', exact: true });
    await settledLive.waitFor();
    features.settlementReturnsCollapsed = await settledLive.getAttribute('aria-expanded') === 'false';
    if (await settledLive.getAttribute('aria-expanded') === 'false')
        await activate(settledLive);
    features.settledManuallyReachable = await page.getByText('LIVE_WRITE_BODY', { exact: false }).first().isVisible();
    await page.goto(url + '&initial=completed&history=1');
    await page.locator('[data-phase="completed"]').waitFor();
    await reveal();
    features.historicalSettledCollapsed = await liveRow.getByRole('button', { name: 'Wrote', exact: true }).getAttribute('aria-expanded') === 'false';
    await page.goto(url);
    await page.locator('[data-phase="running"]').waitFor();
    await reveal();
    await page.waitForFunction(() => (window as any).observed['live-write']?.status === 'running');
    await page.evaluate(() => (window as any).setPhase('failed'));
    await page.waitForFunction(() => (window as any).observed['live-write']?.status === 'failed');
    features.failedSettlementCollapsed = await live.getAttribute('aria-expanded') === 'false';
    assert.ok(Object.values(features).every(Boolean), JSON.stringify(features));
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    results.push({ width, theme, liveTools: features });
    await page.close();
}
  }

  if (!handoffOnly && !process.argv.includes("--live-only") && !process.argv.includes("--raw-only") && !process.argv.includes("--host-content-only")) for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    const url = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=host-live`;
    const activate = (target: ReturnType<typeof page.locator>) => width === 390 ? target.tap() : target.click();
    const reveal = async () => { for (let i = 0; i < 20; i++) {
      const closed = page.locator('.thread-agent-activity__group > .thread-agent-activity__group-disclosure > .thread-activity-item__header > button[aria-expanded="false"]');
      if (!await closed.count()) break;
      await activate(closed.first());
    } };
    await page.goto(url);
    await page.locator('[data-phase="running"]').waitFor();
    await reveal();
    const row = page.locator('.thread-activity-item[data-status]').filter({ has: page.locator('[data-live-host-icon]') }).last();
    const trigger = row.locator(':scope > .thread-activity-item__header button[aria-expanded]');
    await trigger.waitFor();
    await page.waitForFunction(() => (window as any).hostPresentation?.phase === "running");
    assert.equal(await page.evaluate(() => (window as any).hostPresentation.canExpand), false);
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await page.getByRole("textbox", { name: "Host detail input" }).isVisible(), true);
    await page.screenshot({ path: join(output, `host-live-${width}-${theme}.png`) });
    await activate(trigger);
    await page.evaluate(() => (window as any).setPhase("progress"));
    await page.waitForFunction(() => (window as any).hostPresentation?.phase === "progress");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await activate(trigger);
    await page.getByRole("textbox", { name: "Host detail input" }).waitFor();
    await page.evaluate(() => (window as any).setPhase("completed"));
    await page.waitForFunction(() => (window as any).hostPresentation?.state === "completed");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await activate(trigger);
    await page.getByRole("textbox", { name: "Host detail input" }).waitFor();
    await page.evaluate(() => (window as any).setPhase("failed"));
    await page.waitForFunction(() => (window as any).hostPresentation?.state === "failed");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    for (const mode of ["null", "false", "fallback", "absent"]) {
      await page.evaluate(mode => (window as any).setHostMode(mode), mode);
      await page.locator(`[data-host-mode="${mode}"][data-phase="running"]`).waitFor();
      await reveal();
      assert.equal(await page.locator("[data-live-host-body]").count(), 0);
      assert.equal(await page.getByText("COMPACT_PAYLOAD_CONTROL", { exact: false }).count(), 0);
    }
    await page.goto(url + "&initial=completed&history=1");
    await page.locator('[data-phase="completed"]').waitFor();
    await reveal();
    await trigger.waitFor();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    results.push({ width, theme, hostLiveDisclosure: true, settledMemory: true, explicitSuppression: true, historicalRestore: true });
    await page.close();
  }
  if (!process.argv.includes("--raw-only") && !process.argv.includes("--host-content-only"))
    for (const width of [390, 1100])
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
        inspectedPage = page;
        const errors: string[] = [];
        page.on("pageerror", e => errors.push(e.message));
        await page.addInitScript("window.__name=value=>value");
        const url = `http://127.0.0.1:${(vite.httpServer!.address() as {
          port: number;
        }).port}/?theme=${theme}&scenario=handoff-live`;
        await page.goto(url);
        await page.locator('[data-phase="queued"]').waitFor();
        const activate = (n: ReturnType<typeof page.locator>) => width === 390 ? n.tap() : n.click();
        const row = page.locator('.thread-activity-item[data-status]').filter({ has: page.locator('.thread-handoff-steps') }).last();
        await row.waitFor();
        const trigger = row.locator(':scope > .thread-activity-item__header button[aria-expanded]');
        await trigger.waitFor();
        await page.waitForFunction(() => (window as any).presentations['handoff-live']?.phase === 'queued');
        assert.equal(await page.evaluate(() => (window as any).presentations['handoff-live'].state), 'running');
        const features: Record<string, boolean> = { queuedInitiallyOpen: await trigger.getAttribute('aria-expanded') === 'true', queuedStepsInitiallyVisible: await row.locator(':scope > .thread-activity-item__body-clip').getAttribute('aria-hidden') === 'false' };
        await page.screenshot({ path: join(output, `handoff-live-${width}-${theme}-initial.png`) });
        if (await trigger.getAttribute('aria-expanded') === 'true')
          await activate(trigger);
        const restoreHandoff = async (fresh = false) => {
          await page.evaluate(() => (window as any).setHandoffMounted(false));
          await trigger.waitFor({ state: "detached" });
          if (fresh) await page.evaluate(() => (window as any).clearHandoffRestore());
          await page.evaluate(() => (window as any).setHandoffMounted(true));
          await trigger.waitFor();
        };
        await restoreHandoff();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false", "Same View keeps explicit running handoff collapse");
        features.runningChoiceRestored = true;
        await page.evaluate(() => (window as any).setPhase('running'));
        await page.waitForFunction(() => (window as any).presentations['handoff-live']?.phase === 'running');
        features.manualCollapseSurvivesProgress = await trigger.getAttribute('aria-expanded') === 'false';
        await activate(trigger);
        features.manualReopenShowsSteps = await page.getByText('Prepare host transfer', { exact: true }).isVisible();
        await page.evaluate(() => (window as any).setPhase('success'));
        await page.waitForFunction(() => (window as any).presentations['handoff-live']?.state === 'completed');
        features.settlementStartsCollapsed = await trigger.getAttribute('aria-expanded') === 'false';
        if (await trigger.getAttribute('aria-expanded') === 'false')
          await activate(trigger);
        await restoreHandoff();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true", "Same View keeps explicit settled handoff expansion");
        features.settledChoiceRestored = true;
        await page.evaluate(() => (window as any).setPhase('error'));
        await page.waitForFunction(() => (window as any).presentations['handoff-live']?.state === 'failed');
        features.settledManualChoiceSurvivesFailure = await trigger.getAttribute('aria-expanded') === 'true';
        await activate(trigger);
        await restoreHandoff();
        assert.equal(await trigger.getAttribute("aria-expanded"), "false", "Same View keeps explicit settled handoff collapse");
        features.settledCollapseRestored = true;
        await activate(trigger);
        await restoreHandoff(true);
        assert.equal(await trigger.getAttribute("aria-expanded"), "false", "Fresh settled View retains collapsed default");
        await page.evaluate(() => (window as any).setPhase("queued"));
        assert.equal(await trigger.getAttribute("aria-expanded"), "true", "Fresh running View retains open default");
        features.freshViewDefaults = true;
        await page.evaluate(() => (window as any).setPhase('empty'));
        await page.locator('[data-phase="empty"]').waitFor();
        features.emptyHandoffSummaryOnly = await page.locator('.thread-handoff-steps').count() === 0 && await page.locator('.thread-tool-row button[aria-expanded]').count() === 0;
        for (const phase of ['success', 'transport-failed']) {
          await page.goto(url + '&initial=' + phase + '&history=1');
          await page.locator('[data-phase="' + phase + '"]').waitFor();
          await trigger.waitFor();
          features['historical-' + phase + '-collapsed'] = await trigger.getAttribute('aria-expanded') === 'false';
          features['historical-' + phase + '-state'] = await row.getAttribute('data-status') === (phase === 'success' ? 'completed' : 'failed');
        }
        assert.deepEqual(errors, []);
        for (const [feature, present] of Object.entries(features))
          assert.equal(present, true, feature);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        results.push({ width, theme, handoffLiveDisclosure: true, ...features });
        await page.close();
      }

  if (!handoffOnly && !process.argv.includes("--live-only")) for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390,
      isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = []; page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=host-content`);
    await page.locator('[data-host-mode="content"]').waitFor();
    const activate = (target: ReturnType<typeof page.locator>) => width === 390 ? target.tap() : target.click();
    for (const mode of ["content", "null", "false", "fallback", "absent"]) {
      await page.evaluate(mode => (window as any).changeHostContentMode(mode), mode);
      await page.locator(`[data-host-mode="${mode}"][data-phase="inProgress"]`).waitFor();

      for (let attempt = 0; attempt < 20; attempt++) {
        const closed = page.locator('.thread-agent-activity__group button[aria-expanded="false"], .thread-activity-item__hit-target[aria-expanded="false"]');
        if (await closed.count() === 0) break; await activate(closed.first());
      }
      if (mode !== "absent") await page.waitForFunction(mode => ['create', 'read', 'handoff', 'empty']
        .every(id => (window as any).hostRenderedModes[id] === mode), mode);
      const bodies = page.locator('[data-host-body]');
      const builtins = page.locator('.thread-created-thread-card,.thread-tool-row,.thread-handoff-steps');
      if (mode === "content") {
        assert.equal(await bodies.count(), 4, 'the hidden status poll does not create a fifth custom body');
        assert.equal(await builtins.count(), 0, 'the Host claim owns the tool body');
        const input = bodies.first().getByRole('textbox');
        await input.fill('Keep this draft through tool failure');
        await input.evaluate(node => { (window as any).hostInputNode = node; });
        await activate(bodies.first().getByRole('button'));
        assert.deepEqual(await page.evaluate(() => (window as any).hostActions), ['create']);
        await page.evaluate(() => (window as any).changeThreadToolPhase('failed'));
        await page.locator('[data-phase="failed"]').waitFor();
        assert.equal(await input.inputValue(), 'Keep this draft through tool failure');
        assert.ok(await input.evaluate(node => node === (window as any).hostInputNode));
      } else if (mode === "null" || mode === "false") {
        assert.equal(await bodies.count(), 0); assert.equal(await builtins.count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Transfer · Queued', exact: true }).count(), 0,
          'explicit Host suppression must not create an empty disclosure without progress steps');
        await page.screenshot({ path: join(output, `host-${mode}-${width}-${theme}.png`) });
      } else {
        assert.equal(await page.locator('.thread-created-thread-card').count(), 1);
        assert.equal(await page.locator('.thread-handoff-step').count(), 3);
        assert.equal(await page.locator('.thread-handoff-steps').evaluateAll(nodes =>
          nodes.filter(node => node.childElementCount === 0).length), 0);
        assert.equal(await page.getByRole('button', { name: 'Transfer · Queued', exact: true }).count(), 0,
          'an operation without reported steps has no empty disclosure');
        await activate(page.getByRole('button', { name: 'Open chat', exact: true }).filter({ hasText: 'Read thread' }));
        await activate(page.locator('.thread-created-thread-card'));
        assert.deepEqual(await page.evaluate(() => (window as any).openedThreads.slice(-2)), ['read-ai', 'created-ai']);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `host-content-${width}-${theme}.png`) });
    results.push({ width, theme, hostContentPriority: true, explicitSuppression: true,
      inputIdentityRetained: true, semanticFallback: true, emptyHandoffSummary: true });
    await page.close();
  }
  for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=webmcp`);
    await page.locator("[data-phase]").waitFor();
    const activate = (target: import("playwright").Locator) => width === 390 ? target.tap() : target.click();
    const groups = page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header button[aria-expanded="false"]');
    for (let index = 0; index < 10 && await groups.count(); index++) await activate(groups.first());
    const titles = ["Listed website tools", "Look up an item", "Partial query", "Plain response", "Empty response"];
    for (const title of titles) {
      const trigger = page.getByRole("button", { name: title, exact: true });
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      await activate(trigger);
    }
    const details = page.locator(".thread-webmcp-details");
    assert.equal(await details.count(), 5);
    assert.deepEqual(await details.locator(".chat-code-block__title").allTextContents(), [
      "Tool", "Result", "Tool", "Result", "Tool (input truncated)", "Result (truncated)", "Tool", "Result", "Tool",
    ]);
    const sources = (index: number) => details.nth(index).locator(".chat-code-block pre").allTextContents();
    const lookup = await sources(1);
    const metadata = JSON.parse(lookup[0]!);
    assert.deepEqual(metadata, { name: "lookup_item", title: "Look up an item", description: "Find an item in this website",
      website: "catalog.example.test", readOnlyHint: true, input: { query: { id: "INPUT_42", region: "上海" }, options: { limit: 40 } } });
    assert.ok(lookup[0]!.includes('"input": {\n'), "Nested input is formatted for reading");
    assert.ok(lookup[1]!.includes('"items": [\n'));
    const result = JSON.parse(lookup[1]!);
    assert.equal(result.items.length, 40);
    assert.equal(result.last, "LAST_RESULT");
    const partial = await sources(2);
    assert.equal(JSON.parse(partial[0]!).input, '{"query":"PARTIAL_INPUT');
    assert.equal(JSON.parse(partial[0]!).inputTruncated, true);
    assert.equal(JSON.parse(partial[0]!).readOnlyHint, false);
    assert.equal(partial[1], '{"result":"PARTIAL_OUTPUT');
    const plain = await sources(3);
    assert.equal(JSON.parse(plain[0]!).input, "PLAIN_INPUT");
    assert.equal(plain[1], "PLAIN_OUTPUT");
    const empty = await sources(4);
    assert.equal(empty.length, 1, "An absent result does not invent a result section");
    assert.equal(JSON.parse(empty[0]!).input, false);
    const scroller = details.nth(1).locator(".chat-code-block__scroller").nth(1);
    const scrolling = await scroller.evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return { top: element.scrollTop, client: element.clientHeight, total: element.scrollHeight,
        maximum: Number.parseFloat(getComputedStyle(element).maxHeight) };
    });
    assert.ok(scrolling.top > 0 && scrolling.total > scrolling.client);
    assert.ok(Number.isFinite(scrolling.maximum) && scrolling.client <= scrolling.maximum + 1, "Shared preview owns the local reading budget");
    const trigger = page.getByRole("button", { name: "Look up an item", exact: true });
    await activate(trigger);
    await activate(trigger);
    assert.deepEqual(await sources(1), lookup);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await details.nth(1).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `webmcp-${width}-${theme}.png`) });
    results.push({ width, theme, websiteToolSections: true, structuredJson: true, truncatedAndPlainPreserved: true, sharedPreviewScroll: true, collapseAndReopen: true });
    console.log(JSON.stringify({ width, theme, webMcpDetails: true, passed: true }));
    await page.close();
  }
  for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=reviews`);
    await page.locator('[data-phase="inProgress"]').waitFor();
    const activate = (target: import("playwright").Locator) => width === 390 ? target.tap() : target.click();
    const groups = page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header button[aria-expanded="false"]');
    for (let index = 0; index < 10 && await groups.count(); index++) await activate(groups.first());
    const reviewed = [page.getByRole("button", { name: "Reviewed · Running", exact: true }), page.getByRole("button", { name: "Inspect · Running", exact: true })];
    for (const trigger of reviewed) {
      assert.equal(await trigger.getAttribute("aria-expanded"), "false", "Pending reviews preserve the tool's collapsed default");
      await activate(trigger);
    }
    const reviews = page.locator(".thread-auto-review");
    assert.equal(await reviews.count(), 2);
    for (let index = 0; index < 2; index++) {
      await activate(reviews.nth(index).locator(":scope > button"));
      assert.equal(await reviews.nth(index).locator(":scope > p").textContent(), "Reviewing this request.");
    }
    assert.equal(await page.locator(".thread-tool-details").count(), 0, "Review details do not grant a tool payload surface");
    await page.evaluate(() => (window as any).changeThreadToolPhase("denied"));
    await page.locator('[data-phase="denied"]').waitFor();
    for (let index = 0; index < 2; index++) {
      assert.equal(await reviewed[index]!.getAttribute("aria-expanded"), "true");
      assert.equal(await reviews.nth(index).locator(":scope > p").textContent(), `REVIEW_REASON_${index}: add permission context.`);
      assert.equal(await reviews.nth(index).getAttribute("data-warning"), "true");
      await activate(reviewed[index]!);
      await activate(reviewed[index]!);
      const reasonToggle = reviews.nth(index).locator(":scope > button");
      assert.equal(await reasonToggle.getAttribute("aria-expanded"), "true", "Reopening the tool retains its explicit review reason choice");
      await activate(reasonToggle);
      assert.equal(await reasonToggle.getAttribute("aria-expanded"), "false", "The retained reason can still be collapsed manually");
      await activate(reasonToggle);
      assert.equal(await reviews.nth(index).locator(":scope > p").textContent(), `REVIEW_REASON_${index}: add permission context.`);
    }
    const plain = page.locator(".thread-activity-item[data-status] > .thread-activity-item__header").filter({ hasText: "Plain · Running" });
    assert.equal(await plain.count(), 1);
    assert.equal(await plain.locator("button[aria-expanded]").count(), 0, "An unrelated pending tool stays compact");
    assert.equal(await page.locator(".thread-tool-details").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `reviews-${width}-${theme}.png`) });
    results.push({ width, theme, pendingToolReviewsReachable: true, denialReasonUpdates: true, compactPayloadPreserved: true, collapseAndReopen: true });
    console.log(JSON.stringify({ width, theme, toolReviews: true, passed: true }));
    await page.close();
  }
  for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript(() => {
      (window as any).__name = (value: unknown) => value;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (text: string) => { (window as any).rawClipboard = text; },
      } });
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=raw`);
    await page.locator("[data-phase]").waitFor();
    const activate = (target: ReturnType<typeof page.locator>) => width === 390 ? target.tap() : target.click();
    for (let index = 0; index < 30; index++) {
      const closed = page.locator('.thread-activity-item__hit-target[aria-expanded="false"]');
      if (await closed.count() === 0) break;
      await activate(closed.first());
    }
    const rawButtons = page.getByRole("button", { name: "Show raw tool call output", exact: true });
    assert.equal(await rawButtons.count(), 6);
    const values: any[] = [];
    for (let index = 0; index < 6; index++) {
      await activate(rawButtons.nth(index));
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await page.evaluate(() => { (window as any).rawClipboard = ""; });
      await activate(dialog.getByRole("button", { name: "Copy code", exact: true }));
      await page.waitForFunction(() => (window as any).rawClipboard.length > 0);
      values.push(JSON.parse(await page.evaluate(() => (window as any).rawClipboard)));
      if (index === 0 || index === 4) await page.screenshot({ path: join(output, `raw-${index}-${width}-${theme}.png`) });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
    assert.deepEqual(values[0], {
      callId: "protocol-error", invocation: { server: "raw-probe", tool: "protocol_error", arguments: { path: "/workspace/report.txt" } }, durationMs: 120,
      result: { type: "error", kind: "protocol", error: "PROTOCOL_FAILURE: connection closed before a result", rawError: { message: "PROTOCOL_FAILURE: connection closed before a result" } },
    });
    assert.equal(values[1].result, null, "A missing MCP envelope remains absent");
    assert.deepEqual(values[2].result, { type: "success", content: [{ type: "text", text: "MCP_SUCCESS" }], structuredContent: { value: 42 }, raw: { content: [{ type: "text", text: "MCP_SUCCESS" }], structuredContent: { value: 42 } } });
    assert.equal(values[3].result.type, "success", "A tool-reported error is a received MCP result, not a protocol failure");
    assert.equal(values[3].result.raw.isError, true);
    assert.equal(values[3].result.content[0].text, "REPORTED_ERROR: item absent");
    for (const [index, success, text] of [[4, false, "DYNAMIC_FAILURE_CONTENT"], [5, true, "DYNAMIC_SUCCESS_CONTENT"]] as const) {
      assert.equal(values[index].invocation.server, "deepseek-harness");
      assert.deepEqual(values[index].result, { success, contentItems: [{ type: "inputText", text }] });
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    results.push({ width, theme, rawProtocolError: true, absentEnvelope: true, receivedMcpError: true, dynamicResultFacts: true, fullJsonCopy: true });
    console.log(JSON.stringify({ width, theme, rawOutput: true, passed: true }));
    await page.close();
  }
  for (const width of [390, 1100]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" });
    inspectedPage = page;
    const errors: string[] = [];
    page.on("pageerror", error => { errors.push(error.message); console.error("fixture-pageerror", error.message); });
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&scenario=inputs`);
    await page.locator('[data-phase="inProgress"]').waitFor();
    const collapsed = page.locator('.thread-agent-activity__group button[aria-expanded="false"]');
    for (let index = 0; index < 20 && await collapsed.count() > 0; index++) await collapsed.first().click();
    const calls = page.locator('.thread-activity-item button[aria-expanded="false"]');
    for (let index = 0; index < 20 && await calls.count() > 0; index++) await calls.first().click();
    const details = page.locator('.thread-tool-details[data-kind="dynamic"]');
    const checkInputs = async () => {
      await page.waitForFunction(() => ["DSH_WRITE_BODY", "DSH_OLD_TEXT", "DSH_NEW_TEXT"].every(text => document.body.textContent?.includes(text)));
      assert.equal(await details.count(), 3);
      assert.deepEqual(await details.locator('section[data-role="input"] > span').allTextContents(), ["Input", "Input", "Input"]);
      const text = await details.allTextContents();
      assert.match(text[0]!, /DSH_WRITE_BODY/);
      assert.match(text[1]!, /DSH_OLD_TEXT[\s\S]*DSH_NEW_TEXT/);
      assert.match(text[2]!, /"offset": 120[\s\S]*"limit": 60/);
      assert.equal(await details.locator(".thread-tool-details__empty").count(), 0);
      const mcp = page.locator('.thread-tool-details[data-kind="mcp"]');
      assert.equal(await mcp.locator('section[data-role="input"]').count(), 0);
      assert.equal((await mcp.textContent())?.includes("MCP_ARGUMENT_STAYS_IN_RAW"), false);
      assert.match(await mcp.textContent() ?? "", /MCP returned content/);
    };
    await checkInputs();
    assert.deepEqual(await details.locator('section[data-role="output"] > span').allTextContents(), ["Output", "Output"]);
    await page.evaluate(() => (window as any).changeThreadToolPhase("completed"));
    await page.locator('[data-phase="completed"]').waitFor();
    // Running details open automatically; settlement restores the collapsed default.
    // Reopen them explicitly before checking the preserved input and new output.
    const settledCalls = page.locator('.thread-activity-item button[aria-expanded="false"]');
    for (let index = 0; index < 20 && await settledCalls.count() > 0; index++) await settledCalls.first().click();
    await checkInputs();
    assert.deepEqual(await details.locator('section[data-role="output"] > span').allTextContents(), ["Output", "Output", "Output"]);
    const toggle = (await details.first().evaluateHandle(element => element.closest(".thread-activity-item")!.querySelector<HTMLButtonElement>(":scope > .thread-activity-item__header button[aria-expanded]")!)).asElement()!;
    await toggle.click();
    await toggle.click();
    await checkInputs();
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(output, `inputs-${width}-${theme}.png`) });
    results.push({ width, theme, dshArgumentsVisible: true, roleLabels: true, settlementAndReopen: true, mcpArgumentsRemainRaw: true });
    console.log(JSON.stringify({ width, theme, toolInputs: true, passed: true }));
    await page.close();
  }
  await writeFile(join(output, "report.json"), JSON.stringify({ results }, null, 2));
  console.log(JSON.stringify({ passed: results.length, output }));
} catch (error) {
  if (inspectedPage && !inspectedPage.isClosed()) {
    await writeFile(join(output, "failure.html"), await inspectedPage.content());
    await inspectedPage.screenshot({ path: join(output, "failure.png") });
  }
  throw error;
} finally { await browser?.close(); await vite.close(); }
