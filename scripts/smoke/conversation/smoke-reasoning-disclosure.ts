import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertBrowserRuntimeDependencies } from "../../browser-smoke-preflight.mjs";

const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const { chromium } = playwright.default ?? playwright;
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const output = await mkdtemp("/tmp/opencraft-reasoning-disclosure-");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-reasoning-disclosure",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "reasoning-disclosure", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/reasoning-disclosure.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const results = [];
  const activityScales = [];
  const subagentDetails = [];
  const commandElapsed = [];
  const commandOutputStates = [];
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1024, height: 900 }, hasTouch: touch,
      deviceScaleFactor: touch ? 2 : 1,
      isMobile: touch, reducedMotion: touch ? "reduce" : "no-preference" });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    if (process.argv.includes("--command-output-only")) await page.addInitScript(() => {
      (window as any).commandClipboard = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (value: string) => { (window as any).commandClipboard.push(value); },
      } });
    });
    await page.addInitScript(() => {
      const NativeObserver = window.ResizeObserver;
      const deliveries: unknown[] = [];
      (window as any).resizeFeedback = [];
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            deliveries.push(entries.map(entry => ({ target: entry.target.className,
              width: entry.contentRect.width, height: entry.contentRect.height })));
            if (deliveries.length > 10) deliveries.shift();
            callback(entries, observer);
          });
        }
      };
      window.addEventListener('error', event => {
        if (event.message.startsWith('ResizeObserver')) (window as any).resizeFeedback.push({ action: (window as any).__reasoningSmokeAction, message: event.message, deliveries: deliveries.slice() });
      });
    });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&locale=${touch ? "zh" : "en"}`);
    assert.equal(await page.evaluate(() => innerWidth), touch ? 390 : 1024,
      'mobile emulation must use the real narrow CSS viewport, not Safari default page scaling');
    const update = async (action: string, engine?: string) => {
      const before = Number(await page.locator('[data-revision]').getAttribute('data-revision'));
      await page.evaluate(([action, engine]) => {
        (window as any).__reasoningSmokeAction = action;
        (window as any).update(action, engine);
      }, [action, engine]);
      await page.locator(`[data-revision="${before + 1}"]`).waitFor({ state: (process.argv.includes("--command-hidden-only") || process.argv.includes("--diff-hidden-only")) ? "attached" : "visible" });
    };
    const activate = (target: any) => touch ? target.tap() : target.click();
    if (process.argv.includes("--command-hidden-only")) {
      await update("command-view-reset");
      const viewport = page.locator('.thread-shell-output__output pre');
      for (let index = 0; index < 8 && !await viewport.count(); index++) {
        const closed = page.locator('.thread-agent-activity__group button[aria-expanded="false"], .thread-activity-item__hit-target[aria-expanded="false"]');
        assert.ok(await closed.count()); await activate(closed.first());
      }
      await viewport.waitFor();
      const position = () => viewport.evaluate(element => [element.scrollTop, element.scrollLeft]);
      const readManually = async () => {
        await viewport.evaluate(element => { element.scrollTop = 180; element.scrollLeft = 90; });
        await page.waitForFunction(() => {
          const element = document.querySelector('.thread-shell-output__output pre');
          return element?.scrollTop === 180 && element.scrollLeft === 90;
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      };
      const restoreHidden = async () => {
        const original = await viewport.elementHandle(); await update("restore");
        await page.waitForFunction(element => !element.isConnected, original);
        await viewport.waitFor({ state: "attached" });
      };
      await readManually();
      const original = await viewport.elementHandle();
      await update("command-view-hide"); await update("command-view-append");
      await update("command-view-show"); await viewport.waitFor();
      assert.equal(await original!.evaluate(element => element.isConnected), true, "parking retains the same log DOM");
      assert.deepEqual(await position(), [180, 90], "hidden output cannot reset manual reading in the mounted View");
      await update("command-view-hide"); await update("command-view-grow"); await restoreHidden();
      await update("command-view-show"); await viewport.waitFor();
      assert.deepEqual(await position(), [180, 90], "hidden View replacement keeps both log reading axes");
      await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.waitForFunction(() => {
        const element = document.querySelector('.thread-shell-output__output pre')!;
        return element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
      });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await update("command-view-hide"); await update("command-view-append"); await restoreHidden();
      await update("command-view-show"); await viewport.waitFor();
      assert.ok(await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2),
        "a following reader resumes at the current tail after hidden output and replacement");
      assert.equal(await viewport.evaluate(element => element.scrollLeft), 90, "following does not discard horizontal reading");
      await page.screenshot({ path: join(output, `command-hidden-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      await update("command-view-reset");
      assert.equal(await page.locator('.thread-shell-output').count(), 0, "a fresh View keeps the original collapsed default");
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => (window as any).resizeFeedback), []);
      results.push({touch, theme, hiddenMountedReading:true, hiddenRemountReading:true, followRestored:true, horizontalReading:true, freshViewIsolated:true});
      await page.close(); continue;
    }
    if (process.argv.includes("--plan-preview-only")) {
      await update("plan-preview-reset");
      const plan = page.locator('.thread-plan');
      const control = plan.locator('header button[aria-expanded]');
      await plan.locator('.opencraft-chat-document li').first().waitFor();
      const original = await plan.elementHandle();
      const waitGeometry = (clipped: boolean) => page.waitForFunction(clipped => {
        const plan = document.querySelector('.thread-plan');
        const body = plan?.querySelector('.thread-plan__body');
        const content = plan?.querySelector('.thread-plan__content') ?? plan?.querySelector('.opencraft-chat-document');
        if (!body || !content) return false;
        const natural = content.getBoundingClientRect().height;
        return natural > 0 && (clipped ? natural > 320 : natural < 320)
          && Math.abs(body.getBoundingClientRect().height - Math.min(320, natural)) <= 1;
      }, clipped, {timeout: 5000});
      await waitGeometry(false);
      assert.equal(await plan.locator('.thread-plan__expand').count(), 0, 'a short preview has no covering fade or redundant expansion overlay');
      assert.equal(await control.getAttribute('aria-expanded'), 'false');
      await update("plan-preview-grow");
      await waitGeometry(true);
      assert.equal(await original!.evaluate(node => node.isConnected), true, 'growth keeps the same plan');
      await plan.locator('.thread-plan__expand').waitFor();
      if (touch) await activate(control); else { await control.focus(); await page.keyboard.press('Enter'); }
      await page.waitForFunction(() => {
        const body = document.querySelector('.thread-plan__body');
        const content = document.querySelector('.thread-plan__content') ?? document.querySelector('.thread-plan .opencraft-chat-document');
        return body && content && Math.abs(body.getBoundingClientRect().height - content.getBoundingClientRect().height) <= 1;
      });
      assert.equal(await control.getAttribute('aria-expanded'), 'true');
      assert.equal(await plan.locator('.thread-plan__expand').count(), 0);
      await activate(control); await waitGeometry(true);
      await update("plan-preview-shrink"); await waitGeometry(false);
      assert.equal(await plan.locator('.thread-plan__expand').count(), 0);
      await update("plan-preview-complete"); await waitGeometry(false);
      assert.equal(await control.getAttribute('aria-expanded'), 'false', 'completion preserves explicit collapse');
      await update("restore"); await plan.locator('.opencraft-chat-document li').first().waitFor(); await waitGeometry(false);
      assert.equal(await control.getAttribute('aria-expanded'), 'false', 'the same View keeps its explicit choice');
      await page.screenshot({path:join(output, `plan-preview-${touch ? 'touch' : 'mouse'}-${theme}.png`)});
      await update("plan-preview-fresh-complete"); await plan.locator('.opencraft-chat-document li').first().waitFor(); await waitGeometry(false);
      assert.equal(await control.getAttribute('aria-expanded'), 'true', 'fresh completed plan starts expanded');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => (window as any).resizeFeedback), []);
      results.push({touch, theme, shortNaturalHeight:true, longPreviewBounded:true, expansionNatural:true,
        shrinkMeasured:true, planRetained:true, explicitChoiceRestored:true, freshCompletedDefault:true});
      await page.close(); continue;
    }
    if (process.argv.includes("--late-body-only")) {
      await update("late-body-reset");
      // Mount the file row while no diff exists, before the late body arrives.
      const group = page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header button[aria-expanded="false"]');
      if (await group.count()) await activate(group.first());
      const row = page.locator('.thread-patch-activities > .thread-activity-item');
      await row.waitFor();
      const original = await row.elementHandle();
      assert.equal(await row.locator('.thread-activity-item__body-clip').count(), 0);
      for (const action of ["late-body-append", "late-body-remove", "late-body-return"]) {
        await update(action);
        assert.equal(await original!.evaluate(element => element.isConnected), true, "the same file row owns incoming details");
        if (action === "late-body-remove") {
          assert.equal(await row.locator('.thread-activity-item__body-clip').count(), 0);
          continue;
        }
        const clip = row.locator('.thread-activity-item__body-clip');
        await page.waitForFunction(() => {
          const row = document.querySelector('.thread-patch-activities > .thread-activity-item');
          const clip = row?.querySelector('.thread-activity-item__body-clip');
          const body = row?.querySelector('.thread-activity-item__body');
          return !!clip && !!body && body.scrollHeight > 0
            && Math.abs(clip.getBoundingClientRect().height - body.scrollHeight) <= 1;
        }, null, { timeout: 5000 });
        const height = await clip.evaluate(element => element.getBoundingClientRect().height);
        assert.ok(height > 0, `${action}: arriving diff gets natural height`);
        assert.equal(await row.locator('.thread-unified-diff').isVisible(), true);
      }
      await page.screenshot({ path: join(output, `late-body-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      results.push({ touch, theme, lateBodyMeasured: true, removedBodyReleased: true, returningBodyMeasured: true, rowRetained: true });
      await page.close(); continue;
    }
    if (process.argv.includes("--reading-panels-only") || !process.argv.some(value => value.endsWith("-only"))) {
      const restoreView = async () => {
        const scroll = await page.locator('.thread-scroll').elementHandle();
        await update("restore"); await page.waitForFunction(element => !element?.isConnected, scroll);
        await page.locator('.thread-scroll').waitFor();
      };
      const images = page.locator('.thread-agent-activity__unit').filter({ has: page.locator('[data-action-glyph="image"]') });
      const plan = page.locator('.thread-plan');
      const imageToggle = (i: number) => images.nth(i).getByRole('button').first();
      const planToggle = () => plan.locator('header button[aria-expanded]');
      const reveal = async () => {
        const outer = page.locator('.thread-agent-activity__turn-toggle > button[aria-expanded="false"]');
        for (let n = 0; n < 8 && await outer.count(); n++) await activate(outer.first());
      };
      const choices = async () => ({ images: await Promise.all([0, 1].map(i => imageToggle(i).getAttribute('aria-expanded'))), plan: await planToggle().getAttribute('aria-expanded') });
      await update("reading-panels-reset"); await reveal(); await plan.waitFor();
      assert.equal(await images.count(), 2); assert.equal(await plan.count(), 1);
      assert.deepEqual(await choices(), { images: ['false', 'false'], plan: 'true' });
      await plan.locator('h1').waitFor();
      await activate(imageToggle(0)); await activate(planToggle()); const selected = await choices();
      await restoreView(); await reveal();
      assert.deepEqual(await choices(), selected, "View return retains explicit image expansion and plan collapse");
      await update("reading-panels-grow"); await reveal();
      assert.deepEqual(await choices(), selected);
      assert.ok((await plan.innerText()).includes('Updated reading plan'), "current plan content remains authoritative");
      assert.equal(await images.nth(0).locator('.thread-image-view__preview').getAttribute('title'), '/work/refreshed.png');
      await activate(imageToggle(0)); await activate(imageToggle(1)); await activate(planToggle());
      const opposite = await choices(); await restoreView(); await reveal();
      assert.deepEqual(await choices(), opposite, "separate image blocks and plan preserve independent reversed choices");
      await plan.locator('h1').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `reading-panels-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      await update("reading-panels-reset"); await reveal();
      assert.deepEqual(await choices(), { images: ['false', 'false'], plan: 'true' }, "new View uses original completed defaults");
      await update("reading-panels-running"); await reveal();
      assert.equal(await planToggle().getAttribute('aria-expanded'), 'false', "writing plan keeps its bounded preview default");
      await activate(planToggle()); await restoreView(); await reveal();
      assert.equal(await planToggle().getAttribute('aria-expanded'), 'true');
      await update("reading-panels-running-grow");
      assert.ok((await plan.innerText()).includes('Updated reading plan'));
      await activate(planToggle()); await update("reading-panels-complete"); await restoreView(); await reveal();
      assert.equal(await planToggle().getAttribute('aria-expanded'), 'false', "explicit plan collapse survives completion and View restoration");
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      results.push({ touch, theme, inspectedImagesAndPlanRestored: true, independentChoices: true, freshDefaults: true, writingCompletion: true, refreshedContent: true });
      if (process.argv.includes("--reading-panels-only")) { await page.close(); continue; }
    }
    for (const scene of ["subagent-details", "subagent-single", "subagent-wait", "subagent-many", "subagent-many-single"]) {
      await update(scene);
      const agents = page.locator('.thread-subagent-activity');
      const disclosure = agents.locator('.thread-subagent-activity__toggle');
      await disclosure.waitFor();
      if (await disclosure.getAttribute('aria-expanded') === 'false') await activate(disclosure);
      const rows = agents.locator('.thread-subagent-details__row');
      await rows.first().waitFor();
      const content = await agents.locator('.thread-subagent-details__inner').innerText();
      if (scene === "subagent-many" || scene === "subagent-many-single") {
        const header = agents.locator('.thread-subagent-activity__header');
        const chips = header.locator('.thread-subagent-chip');
        assert.equal(await chips.count(), 3, 'the initial summary retains a bounded preview');
        assert.ok(await chips.evaluateAll(nodes => nodes.every(node =>
          (node.querySelector('span:not(.thread-subagent-avatar)') as HTMLElement).clientWidth > 0)),
          'preview names retain visible space on narrow touch screens');
        await activate(header.getByRole('button', { name: '5 more', exact: true }));
        assert.equal(await chips.count(), 8);
        await activate(header.getByRole('button', { name: 'Open Hazel subagent', exact: true }));
        assert.deepEqual(await page.evaluate(() => (window as any).openedSubagents.slice(-1)),
          [{ threadId: 'density-agent-7', displayName: 'Hazel' }]);
        assert.equal(await rows.count(), 8);
        assert.match(content, scene === "subagent-many" ? /Inspect Hazel/ : /Wait for the density audit/);
      } else if (scene === "subagent-details") {
        assert.equal(await rows.count(), 2, 'one current detail per agent');
        const typography = rows.filter({ has: page.getByText('Typography', { exact: true }) });
        const icons = rows.filter({ has: page.getByText('Icons', { exact: true }) });
        assert.match(await typography.innerText(), /Messaged Typography: Inspect current typography/);
        assert.doesNotMatch(await typography.innerText(), /Inspect icons|Superseded typography task/);
        assert.match(await icons.innerText(), /Created Icons with the instructions: Inspect icons/);
        assert.doesNotMatch(await icons.innerText(), /Inspect current typography/);
        const before = await page.evaluate(() => (window as any).openedSubagents.length);
        await activate(agents.getByRole('button', { name: 'Open Icons subagent', exact: true }));
        assert.deepEqual(await page.evaluate(() => (window as any).openedSubagents.slice(-1)),
          [{ threadId: 'Icons', displayName: 'Icons' }]);
        assert.equal(await page.evaluate(() => (window as any).openedSubagents.length), before + 1);
      } else {
        assert.equal(await rows.count(), 1);
        assert.match(content, scene === "subagent-single" ? /Inspect typography/ : /Input: Wait for the audit/);
        assert.match(content, /Reasoning: high/);
        assert.match(content, /\/work\/agents\/Typography/);
      }
      await activate(disclosure);
      await activate(disclosure);
      assert.equal(await agents.locator('.thread-subagent-details__inner').innerText(), content,
        'folding retains the same assigned instructions');
      const visibleChipCount = await agents.locator('.thread-subagent-chip').count();
      await update("restore");
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true', 'View return retains explicit subagent detail expansion');
      assert.equal(await agents.locator('.thread-subagent-chip').count(), visibleChipCount,
        'View return retains the expanded member list independently');
      assert.equal(await agents.locator('.thread-subagent-details__inner').innerText(), content);
      await activate(disclosure);
      await update("restore");
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'false', 'View return retains explicit detail collapse');
      assert.equal(await agents.locator('.thread-subagent-chip').count(), visibleChipCount);
      await activate(disclosure);
      if (scene === "subagent-many" || scene === "subagent-many-single") {
        await update("subagent-grow");
        assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
        assert.equal(await agents.locator('.thread-subagent-chip').count(), 9,
          'new group members preserve the existing full-list choice');
        await update("restore");
        assert.equal(await disclosure.getAttribute('aria-expanded'), 'true',
          'single-operation to grouped presentation keeps the render unit owner');
        assert.equal(await agents.locator('.thread-subagent-chip').count(), 9);
        assert.match(await agents.locator('.thread-subagent-details__inner').innerText(), /Inspect Juniper/);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-${scene}.png`) });
      subagentDetails.push({ scene, theme, touch, content });
    }
    for (const [kind, label] of [
      ["started", "Compiler Reviewer started working"],
      ["interacted", "Compiler Reviewer updated"],
      ["interrupted", "Compiler Reviewer interrupted"],
      ["completed", null],
    ] as const) {
      await update("subagent-lifecycle-" + kind);
      const inline = page.locator('.thread-subagent-inline');
      if (label === null) {
        assert.equal(await inline.count(), 0, 'completed notices retain their existing aggregate presentation');
      } else {
        await inline.waitFor();
        assert.equal(await inline.locator('span:not(.thread-subagent-avatar)').last().innerText(), label);
        assert.equal(await page.locator('.thread-subagent-activity__status').count(), 0);
      }
      const before = await page.evaluate(() => (window as any).openedSubagents.length);
      // Tap the label, not just the avatar/name chip: the whole notice navigates.
      await activate(label === null ? page.getByRole('button', { name: 'Open Compiler Reviewer subagent', exact: true })
        : inline.locator('span:not(.thread-subagent-avatar)').last());
      assert.equal(await page.evaluate(() => (window as any).openedSubagents.length), before + 1);
      assert.deepEqual(await page.evaluate(() => (window as any).openedSubagents.slice(-1)),
        [{ threadId: 'lifecycle-child', displayName: 'Compiler Reviewer' }]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      subagentDetails.push({ scene: "subagent-lifecycle-" + kind, theme, touch, content: label });
    }
    if (process.argv.includes("--subagents-only")) {
      assert.deepEqual(errors, []);
      await page.close();
      continue;
    }
    await update("reset");
    await update("reset");
    if (process.argv.includes("--turn-entry-only")) {
      await page.evaluate(() => {
        const w = window as any; w.turnEntryFrames = []; w.turnEntryLabel = "baseline";
        const sample = () => {
          const row = document.querySelector<HTMLElement>(".thread-turn-diff-live");
          if (row) { const css = getComputedStyle(row); w.turnEntryFrames.push({ label: w.turnEntryLabel, opacity: Number(css.opacity), transform: css.transform }); }
        };
        const frame = () => { sample(); requestAnimationFrame(frame); };
        new MutationObserver(sample).observe(document.body, { subtree: true, childList: true }); requestAnimationFrame(frame);
      });
      const observe = async (label: string, action: string) => {
        await page.evaluate(label => { (window as any).turnEntryLabel = label; }, label);
        await update(action); await page.waitForTimeout(220);
        return page.evaluate(label => (window as any).turnEntryFrames.filter((f: any) => f.label === label), label);
      };
      const staticEntry = (frames: any[], label: string) => {
        assert.ok(frames.length > 0, label);
        assert.ok(frames.every(f => f.opacity === 1 && (f.transform === "none" || f.transform === "matrix(1, 0, 0, 1, 0, 0)")), `${label}: recovered resources must be visible and stationary from their first frame: ${JSON.stringify(frames)}`);
      };
      staticEntry(await observe("baseline", "turn-entry-baseline"), "baseline");
      const row = await page.locator('.thread-turn-diff-live').elementHandle();
      staticEntry(await observe("return", "restore"), "return");
      assert.equal(await row!.evaluate(element => element.isConnected), false);
      await observe("empty", "turn-entry-empty"); assert.equal(await page.locator('.thread-turn-diff-live').count(), 0);
      const fresh = await observe("fresh", "turn-entry-appear");
      if (touch) staticEntry(fresh, "reduced motion fresh entry");
      else assert.ok(fresh.some((f: any) => f.opacity < 1), "genuinely new live resources keep their entry motion");
      const live = await page.locator('.thread-turn-diff-live').elementHandle();
      staticEntry(await observe("update", "turn-entry-update"), "update");
      assert.equal(await live!.evaluate(element => element.isConnected), true);
      await activate(page.locator('.thread-turn-diff-live')); assert.equal(await page.evaluate(() => (window as any).reviewedLiveChanges), true);
      assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => (window as any).resizeFeedback), []);
      await writeFile(join(output, `turn-entry-${touch ? 'touch' : 'mouse'}-${theme}.json`), JSON.stringify(await page.evaluate(() => (window as any).turnEntryFrames)));
      results.push({ touch, theme, baselineStatic: true, returnedStatic: true, freshEntryPreserved: true, updatedNodePreserved: true, reviewWorks: true });
      await page.close(); continue;
    }
    if (process.argv.includes("--turn-files-only") || !process.argv.some(value => value.endsWith("-only"))) {
      const restoreView = async () => {
        const scroll = await page.locator('.thread-scroll').elementHandle(); await update("restore");
        await page.waitForFunction(element => !element.isConnected, scroll); await page.locator('.thread-scroll').waitFor();
      };
      await update("turn-files-reset");
      const row = page.locator('.thread-turn-diff');
      const more = row.locator('.thread-turn-diff__more');
      const files = row.locator('.thread-turn-diff__files > button:not(.thread-turn-diff__more)');
      assert.equal(await files.count(), 3); assert.equal(await more.getAttribute('aria-expanded'), 'false');
      await activate(more); assert.equal(await files.count(), 5);
      const original = await row.elementHandle(); await restoreView();
      assert.equal(await original!.evaluate(element => element.isConnected), false);
      assert.equal(await files.count(), 5, "the retained View keeps the explicitly expanded Turn file list");
      assert.equal(await more.getAttribute('aria-expanded'), 'true');
      const restored = await row.elementHandle(); await update("turn-files-append");
      assert.equal(await restored!.evaluate(element => element.isConnected), true);
      assert.equal(await files.count(), 6); assert.ok((await row.innerText()).includes('updated-file-6.ts'));
      await update("turn-files-shrink"); assert.equal(await files.count(), 2); assert.equal(await more.count(), 0);
      await update("turn-files-regrow"); assert.equal(await files.count(), 6); assert.equal(await more.getAttribute('aria-expanded'), 'true');
      await update("turn-files-other"); assert.equal(await files.count(), 3); assert.equal(await more.getAttribute('aria-expanded'), 'false');
      await update("turn-files-return"); assert.equal(await files.count(), 6); assert.equal(await more.getAttribute('aria-expanded'), 'true');
      await more.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `turn-files-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      await activate(more); await restoreView(); assert.equal(await files.count(), 3); assert.equal(await more.getAttribute('aria-expanded'), 'false');
      await activate(more); assert.equal(await files.count(), 6);
      await update("turn-files-reset"); assert.equal(await files.count(), 3); assert.equal(await more.getAttribute('aria-expanded'), 'false');
      assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => (window as any).resizeFeedback), [], "Turn file-list restore must not cause ResizeObserver feedback");
      results.push({ touch, theme, turnFilesRestored: true, refreshedFiles: true, transientShrink: true, separateTurns: true, explicitCollapse: true, freshViewIsolated: true });
      if (process.argv.includes("--turn-files-only")) { await page.close(); continue; }
    }
    if (process.argv.includes("--diff-hidden-only")) {
      await update("diff-position-reset");
      const rows = page.locator('.thread-activity-item[data-status="completed"]').filter({ has: page.locator('.thread-unified-diff') });
      const first = rows.nth(0), second = rows.nth(1);
      for (let index = 0; index < 8 && !await first.isVisible(); index++) {
        const group = page.locator('.thread-agent-activity__group button[aria-expanded="false"]').first();
        assert.ok(await group.count()); await activate(group);
      }
      const toggle = async (row: any) => {
        const trigger = row.locator(':scope > .thread-activity-item__header > button');
        if (touch) await trigger.tap({position:{x:8,y:8}}); else await trigger.click({position:{x:8,y:8}});
      };
      await toggle(first);
      const reader = first.locator('.thread-unified-diff');
      const position = () => reader.evaluate(element => [element.scrollTop, element.scrollLeft]);
      await reader.evaluate(element => { element.scrollTop = 180; element.scrollLeft = 90; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.deepEqual(await position(), [180, 90]);
      const original = await reader.elementHandle();
      await update("presentation-hide"); await update("diff-position-append"); await update("presentation-show");
      await reader.waitFor();
      assert.equal(await original!.evaluate(element => element.isConnected), true);
      assert.deepEqual(await position(), [180, 90], "hidden diff output keeps mounted View reading stationary");
      await update("presentation-hide");
      const hidden = await reader.elementHandle(); await update("restore");
      await page.waitForFunction(element => !element.isConnected, hidden);
      await reader.waitFor({state:"attached"});
      await update("presentation-show"); await reader.waitFor();
      assert.deepEqual(await position(), [180, 90], "hidden View replacement keeps both diff reading axes");
      assert.ok((await first.innerText()).includes('updated-position-219'));
      await toggle(second);
      assert.deepEqual(await second.locator('.thread-unified-diff').evaluate(element => [element.scrollTop, element.scrollLeft]), [0,0],
        "other files retain their independent reading origin");
      await toggle(first); await toggle(first);
      assert.deepEqual(await position(), [180,90], "explicit collapse preserves the existing diff reading choice");
      await first.locator(':scope > .thread-activity-item__header > button').scrollIntoViewIfNeeded();
      await page.screenshot({path:join(output, `diff-hidden-${touch ? 'touch' : 'mouse'}-${theme}.png`)});
      await update("diff-position-reset");
      for (let index = 0; index < 8 && !await first.isVisible(); index++) await activate(page.locator('.thread-agent-activity__group button[aria-expanded="false"]').first());
      await toggle(first); assert.deepEqual(await position(), [0,0], "a new View does not inherit diff reading coordinates");
      assert.deepEqual(errors, []); assert.deepEqual(await page.evaluate(() => (window as any).resizeFeedback), []);
      results.push({touch,theme,hiddenMountedReading:true,hiddenRemountReading:true,refreshedDiff:true,separateFiles:true,explicitCollapse:true,freshViewIsolated:true});
      await page.close(); continue;
    }
    if (process.argv.includes("--diff-position-only") || !process.argv.some(value => value.endsWith("-only"))) {
      const restoreView = async (action = "restore") => {
        const scroll = await page.locator('.thread-scroll').elementHandle();
        await update(action);
        await page.waitForFunction(element => !element.isConnected, scroll);
        await page.locator('.thread-scroll').waitFor();
      };
      await update("diff-position-reset");
      const rows = page.locator('.thread-activity-item[data-status="completed"]').filter({ has: page.locator('.thread-unified-diff') });
      const first = rows.nth(0), second = rows.nth(1);
      const unfoldGroup = async () => {
        for (let index = 0; index < 8 && !await first.isVisible(); index++) {
          const group = page.locator('.thread-agent-activity__group button[aria-expanded="false"]').first();
          assert.ok(await group.count()); await activate(group);
        }
      };
      const toggleRow = async (row: any) => {
        const trigger = row.locator(':scope > .thread-activity-item__header > button');
        if (touch) await trigger.tap({ position: { x: 8, y: 8 } });
        else await trigger.click({ position: { x: 8, y: 8 } });
      };
      const reader = first.locator('.thread-unified-diff');
      const position = (target = reader) => target.evaluate((element: HTMLElement) => ({ top: element.scrollTop, left: element.scrollLeft }));
      await unfoldGroup(); await toggleRow(first);
      await reader.evaluate((element: HTMLElement) => { element.scrollTop = 180; element.scrollLeft = 90; });
      assert.deepEqual(await position(), { top: 180, left: 90 });
      const original = await reader.elementHandle(); await restoreView();
      assert.equal(await original!.evaluate(element => element.isConnected), false);
      assert.deepEqual(await position(), { top: 180, left: 90 }, "the retained View restores both diff reader coordinates");
      const restored = await reader.elementHandle(); await update("diff-position-append");
      assert.equal(await restored!.evaluate(element => element.isConnected), true);
      assert.deepEqual(await position(), { top: 180, left: 90 }, "fresh output keeps manual reading stationary");
      assert.ok((await first.innerText()).includes('updated-position-219'));
      await toggleRow(second); assert.deepEqual(await position(second.locator('.thread-unified-diff')), { top: 0, left: 0 });
      await restoreView("diff-position-pending-restore");
      assert.equal(await page.evaluate(() => (window as any).pendingDiffScrollEvents), 0,
        "unmount before the browser delivers the queued scroll event");
      assert.deepEqual(await position(), { top: 260, left: 140 }, "teardown captures the actual DOM position without waiting for scroll events");
      await first.locator(':scope > .thread-activity-item__header > button').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `diff-position-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      await toggleRow(first); await restoreView(); assert.notEqual(await first.getAttribute('data-open'), 'true');
      await toggleRow(first); assert.deepEqual(await position(), { top: 260, left: 140 });
      await update("diff-position-reset"); await unfoldGroup(); await toggleRow(first);
      assert.deepEqual(await position(), { top: 0, left: 0 }, "a new View starts at the original reading origin");
      assert.deepEqual(errors, []);
      const resizeFeedback = await page.evaluate(() => (window as any).resizeFeedback);
      if (resizeFeedback.length > 0) console.log(JSON.stringify({ touch, theme, diffPositionResizeFeedback: resizeFeedback }));
      assert.deepEqual(resizeFeedback, [], "diff reading restoration must not cause ResizeObserver feedback");
      results.push({ touch, theme, diffPositionRestored: true, refreshedDiff: true, separateFiles: true, pendingNativeScroll: true, explicitCollapse: true, freshViewIsolated: true });
      if (process.argv.includes("--diff-position-only")) { await page.close(); continue; }
    }
    if (process.argv.includes("--diff-reading-only") || !process.argv.some(value => value.endsWith("-only"))) {
      const restoreView = async () => {
        const scroll = await page.locator('.thread-scroll').elementHandle();
        await update("restore");
        await page.waitForFunction(element => !element.isConnected, scroll);
        await page.locator('.thread-scroll').waitFor();
      };
      await update("diff-reading-reset");
      const rows = page.locator('.thread-activity-item[data-status="completed"]').filter({ has: page.locator('.thread-unified-diff') });
      const first = rows.nth(0), second = rows.nth(1);
      const unfoldGroup = async () => {
        for (let index = 0; index < 8 && !await first.isVisible(); index++) {
          const group = page.locator('.thread-agent-activity__group button[aria-expanded="false"]').first();
          assert.ok(await group.count()); await activate(group);
        }
      };
      const toggleRow = async (row: any) => {
        const trigger = row.locator(':scope > .thread-activity-item__header > button');
        if (touch) await trigger.tap({ position: { x: 8, y: 8 } });
        else await trigger.click({ position: { x: 8, y: 8 } });
      };
      const context = first.locator('.thread-unified-diff__collapsed');
      const more = first.locator('.thread-unified-diff__show-all');
      await unfoldGroup(); await toggleRow(first);
      assert.equal(await context.count(), 1); assert.equal(await more.count(), 1);
      await activate(context); await activate(more);
      assert.equal(await context.count(), 0); assert.equal(await more.count(), 0);
      const original = await first.elementHandle();
      await restoreView();
      assert.equal(await original!.evaluate(element => element.isConnected), false);
      assert.equal(await first.getAttribute('data-open'), 'true');
      assert.equal(await context.count(), 0, "the retained View keeps explicitly shown unchanged lines");
      assert.equal(await more.count(), 0, "the retained View keeps the explicitly shown long diff");
      const restored = await first.elementHandle();
      await update("diff-reading-append");
      assert.equal(await restored!.evaluate(element => element.isConnected), true);
      assert.ok((await first.innerText()).includes('updated-after-450'), "current diff output stays authoritative");
      assert.equal(await context.count(), 0); assert.equal(await more.count(), 0);
      await toggleRow(second);
      assert.equal(await second.locator('.thread-unified-diff__collapsed').count(), 1, "different files keep independent context choices");
      assert.equal(await second.locator('.thread-unified-diff__show-all').count(), 1);
      await toggleRow(first); await restoreView();
      assert.notEqual(await first.getAttribute('data-open'), 'true');
      await toggleRow(first);
      assert.equal(await context.count(), 0); assert.equal(await more.count(), 0);
      await first.locator(':scope > .thread-activity-item__header > button').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `diff-reading-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      await update("diff-reading-reset"); await unfoldGroup(); await toggleRow(first);
      assert.equal(await context.count(), 1, "a new View retains the original context default");
      assert.equal(await more.count(), 1, "a new View retains the original long-diff limit");
      assert.deepEqual(errors, []);
      results.push({ touch, theme, diffReadingRestored: true, refreshedDiff: true, separateFiles: true, explicitCollapse: true, freshViewIsolated: true });
      if (process.argv.includes("--diff-reading-only")) { await page.close(); continue; }
    }
    if (process.argv.includes("--detail-view-only") || !process.argv.some(value => value.endsWith("-only"))) {
      const restoreView = async () => {
        const scroll = await page.locator('.thread-scroll').elementHandle();
        await update("restore");
        await page.waitForFunction(element => !element.isConnected, scroll);
        await page.locator('.thread-scroll').waitFor();
      };
      for (const kind of ["patch", "mcp", "dynamic"]) {
        await update(`detail-view-${kind}-reset`);
        const row = page.locator('.thread-activity-item[data-status="completed"]').filter({
          has: page.locator('.thread-activity-item__body'),
        }).last();
        const unfoldGroup = async () => {
          for (let index = 0; index < 8 && !await row.isVisible(); index++) {
            const group = page.locator('.thread-agent-activity__group button[aria-expanded="false"]').first();
            assert.ok(await group.count());
            await activate(group);
          }
        };
        const toggleRow = async () => {
          const trigger = row.locator(':scope > .thread-activity-item__header > button');
          if (touch) await trigger.tap({ position: { x: 8, y: 8 } });
          else await trigger.click({ position: { x: 8, y: 8 } });
        };
        await unfoldGroup();
        assert.notEqual(await row.getAttribute('data-open'), 'true', "a fresh settled detail starts collapsed");
        await toggleRow();
        assert.equal(await row.getAttribute('data-open'), 'true');
        const first = await row.elementHandle();
        await restoreView();
        assert.equal(await first!.evaluate(element => element.isConnected), false);
        assert.equal(await row.getAttribute('data-open'), 'true', "explicit expansion survives restoration of the same View");
        const restored = await row.elementHandle();
        await update(`detail-view-${kind}-append`);
        assert.equal(await restored!.evaluate(element => element.isConnected), true);
        assert.equal(await row.getAttribute('data-open'), 'true');
        assert.ok((await row.innerText()).includes('Updated detail result'), "restoration does not cache stale tool output");
        await page.screenshot({ path: join(output, `detail-view-${kind}-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
        await toggleRow();
        await restoreView();
        assert.notEqual(await row.getAttribute('data-open'), 'true', "explicit collapse survives the same View");
        await update(`detail-view-${kind}-reset`);
        await unfoldGroup();
        assert.notEqual(await row.getAttribute('data-open'), 'true', "new Views do not inherit the old View choice");
      }
      assert.deepEqual(errors, []);
      results.push({ touch, theme, detailViewRestored: true, refreshedOutput: true, explicitCollapse: true, freshViewIsolated: true });
      if (process.argv.includes("--detail-view-only")) { await page.close(); continue; }
    }
    if (process.argv.includes("--command-view-only") || !process.argv.some(value => value.endsWith("-only"))) {
      const restoreView = async () => {
        const scroll = await page.locator('.thread-scroll').elementHandle();
        await update("restore");
        await page.waitForFunction(element => !element.isConnected, scroll);
        await page.locator('.thread-scroll').waitFor();
      };
      await update("command-view-reset");
      for (let index = 0; index < 8; index++) {
        if (await page.locator('.thread-shell-output').count()) break;
        const closed = page.locator('.thread-agent-activity__group button[aria-expanded="false"], .thread-activity-item__hit-target[aria-expanded="false"]');
        assert.ok(await closed.count(), "the original command disclosure is reachable");
        await activate(closed.first());
      }
      const viewport = page.locator('.thread-shell-output__output pre');
      await viewport.waitFor();
      await viewport.evaluate(element => { element.scrollTop = 180; element.scrollLeft = 90; });
      await page.waitForFunction(() => {
        const element = document.querySelector('.thread-shell-output__output pre');
        return element?.scrollTop === 180 && element.scrollLeft === 90;
      });
      const first = await viewport.elementHandle();
      await restoreView();
      await page.waitForFunction(element => !element.isConnected, first);
      await viewport.waitFor();
      assert.deepEqual(await viewport.evaluate(element => [element.scrollTop, element.scrollLeft]), [180, 90],
        "the same View restores both log reading axes");
      const restored = await viewport.elementHandle();
      await update("command-view-append");
      assert.equal(await restored!.evaluate(element => element.isConnected), true);
      assert.equal(await viewport.evaluate(element => element.scrollTop), 180, "new output does not take over manual reading");
      await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.waitForFunction(() => {
        const element = document.querySelector('.thread-shell-output__output pre')!;
        return element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
      });
      await restoreView();
      await viewport.waitFor();
      assert.ok(await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2),
        "following the latest output survives a View remount");
      await page.screenshot({ path: join(output, `command-view-${touch ? 'touch' : 'mouse'}-${theme}.png`) });
      const trigger = page.locator('.thread-activity-item[data-status] > .thread-activity-item__header button').last();
      await activate(trigger);
      await page.waitForFunction(() => document.querySelector('.thread-activity-item[data-status]')?.getAttribute('data-open') !== 'true');
      await restoreView();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false', "explicit collapse survives the same View restoration");
      await activate(trigger);
      await viewport.waitFor();
      assert.ok(await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2),
        "an explicit reopen still starts at latest output");
      await update("command-view-reset");
      assert.equal(await page.locator('.thread-shell-output').count(), 0, "a fresh View does not inherit another View's choice");
      assert.deepEqual(errors, []);
      results.push({ touch, theme, commandViewRestored: true, readingPosition: true, followIntent: true, freshViewIsolated: true });
      if (process.argv.includes("--command-view-only")) { await page.close(); continue; }
    }
    for (const [kind, label] of [
      ["started", "Compiler Reviewer started working"],
      ["interacted", "Compiler Reviewer updated"],
      ["interrupted", "Compiler Reviewer interrupted"],
      ["completed", null],
    ] as const) {
      await update("subagent-lifecycle-" + kind);
      const inline = page.locator('.thread-subagent-inline');
      if (label === null) {
        assert.equal(await inline.count(), 0, 'completed notices retain their existing aggregate presentation');
      } else {
        await inline.waitFor();
        assert.equal(await inline.locator('span:not(.thread-subagent-avatar)').last().innerText(), label);
        assert.equal(await page.locator('.thread-subagent-activity__status').count(), 0);
      }
      const before = await page.evaluate(() => (window as any).openedSubagents.length);
      // Tap the label, not just the avatar/name chip: the whole notice navigates.
      await activate(label === null ? page.getByRole('button', { name: 'Open Compiler Reviewer subagent', exact: true })
        : inline.locator('span:not(.thread-subagent-avatar)').last());
      assert.equal(await page.evaluate(() => (window as any).openedSubagents.length), before + 1);
      assert.deepEqual(await page.evaluate(() => (window as any).openedSubagents.slice(-1)),
        [{ threadId: 'lifecycle-child', displayName: 'Compiler Reviewer' }]);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      results.push({ scene: "subagent-lifecycle-" + kind, theme, touch, content: label });
    }
    if (process.argv.includes("--subagents-only")) {
      assert.deepEqual(errors, []); await page.close(); continue;
    }

    await update("reset");
    if (process.argv.includes("--subagents-only")) {
      for (const scene of ["subagent-many", "subagent-many-single"]) {
        await update(scene);
        const agents = page.locator('.thread-subagent-activity');
        const header = agents.locator('.thread-subagent-activity__header');
        await header.waitFor();
        const chips = header.locator('.thread-subagent-chip');
        assert.equal(await chips.count(), 3);
        assert.ok(await chips.evaluateAll(nodes => nodes.every(node =>
          (node.querySelector('span:not(.thread-subagent-avatar)') as HTMLElement).clientWidth > 0)));
        await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-${scene}.png`) });
        await activate(header.getByRole('button', { name: '5 more', exact: true }));
        assert.equal(await chips.count(), 8);
        await activate(header.getByRole('button', { name: 'Open Hazel subagent', exact: true }));
        assert.deepEqual(await page.evaluate(() => (window as any).openedSubagents.slice(-1)),
          [{ threadId: 'density-agent-7', displayName: 'Hazel' }]);
        const toggle = agents.locator('.thread-subagent-activity__toggle');
        if (await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
        const rows = agents.locator('.thread-subagent-details__row');
        await rows.last().waitFor(); assert.equal(await rows.count(), 8);
        const content = await agents.locator('.thread-subagent-details__inner').innerText();
        await activate(toggle); await activate(toggle);
        assert.equal(await agents.locator('.thread-subagent-details__inner').innerText(), content);
        assert.equal(await chips.count(), 8, 'detail disclosure retains the explicit full chip list');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        subagentDetails.push({ scene, theme, touch });
      }
      assert.deepEqual(errors, []); await page.close(); continue;
    }
    if (process.argv.includes("--command-completion-only")) {
      for (const mode of ["completed", "failed", "interrupted"]) {
        await update("command-completion-reset");
        await update(`command-completion-${mode}`);
        assert.equal(await page.locator('.thread-activity-item__hit-target').last().getAttribute('aria-expanded'), 'false',
          `${mode}: completion cannot expand a command the user never opened`);
        assert.equal(await page.locator('.thread-shell-output').count(), 0);
        await update("command-completion-reset");
        for (let index = 0; index < 8; index++) {
          const closed = page.locator('.thread-agent-activity__group button[aria-expanded="false"], .thread-activity-item__hit-target[aria-expanded="false"]');
          if (!await closed.count()) break;
          await activate(closed.first());
        }
        const viewport = page.locator('.thread-shell-output__output pre');
        const copy = page.locator('.thread-shell-output__output button');
        await viewport.waitFor();
        await viewport.evaluate(element => { element.scrollTop = 180; });
        await page.waitForFunction(() => document.querySelector('.thread-shell-output__output pre')?.scrollTop === 180);
        if (!touch) await copy.focus();
        const originalViewport = await viewport.elementHandle();
        const originalCopy = await copy.elementHandle();
        const top = await viewport.evaluate(element => element.scrollTop);
        await update(`command-completion-${mode}`);
        assert.equal(await originalViewport!.evaluate(element => element.isConnected), true, `${mode}: preserve the log DOM`);
        assert.equal(await originalCopy!.evaluate(element => element.isConnected), true, `${mode}: preserve the action DOM`);
        assert.equal(await page.locator('.thread-shell-output__command').isVisible(), true, `${mode}: retain explicit expansion`);
        assert.equal(await viewport.evaluate(element => element.scrollTop), top, `${mode}: preserve the reading position`);
        if (!touch) assert.equal(await originalCopy!.evaluate(element => element === document.activeElement), true, `${mode}: retain keyboard focus`);
        assert.equal(await page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header').count(), 0,
          `${mode}: completed singleton still has the plain-row presentation`);
        await update(`command-completion-${mode}`);
        assert.equal(await originalViewport!.evaluate(element => element.isConnected), true, `${mode}: repeated snapshot stays mounted`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        results.push({ touch, theme, commandCompletion: mode, top });
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-command-completion.png`) });
      await page.close();
      continue;
    }
    if (process.argv.includes("--commands-only")) {
      const summary = page.locator('.thread-activity-item[data-body-variant]:not(:has(.thread-activity-item[data-body-variant])) > .thread-activity-item__header .thread-activity-item__summary');
      const reveal = async () => {
        for (const toggle of await page.locator('.thread-agent-activity__turn-toggle button').all())
          if (await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
        for (const group of await page.locator('.thread-agent-activity__group').all()) {
          const toggle = group.getByRole('button').first();
          if (await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
        }
      };
      await update("command-timer"); await reveal();
      await page.waitForFunction(() => /Running command for [2-9]/u.test(document.querySelector('.thread-activity-item[data-body-variant]:not(:has(.thread-activity-item[data-body-variant])) > .thread-activity-item__header .thread-activity-item__summary')?.textContent ?? ""), undefined, { timeout: 8_000 });
      const readLabel = () => summary.evaluate(node => node.firstChild?.textContent ?? "");
      const first = await readLabel();
      await update("presentation-park");
      const parked = await readLabel();
      await page.waitForTimeout(2_200);
      assert.equal(await readLabel(), parked, 'the parked view has no ticking clock');
      await update("presentation-resume");
      await page.waitForFunction(previous => document.querySelector('.thread-activity-item[data-body-variant]:not(:has(.thread-activity-item[data-body-variant])) > .thread-activity-item__header .thread-activity-item__summary')?.firstChild?.textContent !== previous, parked, { timeout: 5_000 });
      const resumed = await readLabel();
      assert.match(resumed, /Running command for/u);
      await update("command-timer-complete");
      assert.match(await summary.innerText(), /in 4\s*(?:s|秒)/u, 'completion uses the returned duration');
      await update("command-timer-authoritative"); await reveal();
      assert.match(await summary.innerText(), /Running command for 9/u, 'known start time wins');
      await update("command-timer-background"); await reveal();
      assert.match(await summary.innerText(), /Started background terminal/u);
      assert.doesNotMatch(await summary.innerText(), /for \d/u);
      await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-command-elapsed.png`) });
      commandElapsed.push({ theme, touch, first, parked, resumed });
      assert.deepEqual(errors, []); await page.close(); continue;
    }
    if (process.argv.includes("--command-output-only")) {
      await update("command-output-reset");
      const observations = [];
      for (const [mode, expected] of [
        ["running-empty", ""], ["running-spaces", ""], ["running-output", "red\nready"],
        ["complete-empty", "No output"], ["complete-spaces", "No output"],
        ["failed", "No output"], ["missing", "Execution result unavailable"],
      ]) {
        await update("command-output-" + mode);
        for (let attempt = 0; attempt < 12; attempt++) {
          const groups = page.locator('.thread-agent-activity__group button[aria-expanded="false"]');
          if (await groups.count()) { await activate(groups.first()); continue; }
          const calls = page.locator('.thread-activity-item button[aria-expanded="false"]');
          if (await calls.count()) { await activate(calls.first()); continue; }
          break;
        }
        const output = page.locator('.thread-shell-output__output pre');
        await output.waitFor();
        assert.equal((await output.innerText()).trim(), expected, mode);
        const footer = (await page.locator('.thread-shell-output__footer').allTextContents()).join(' ').trim();
        if (mode.startsWith("running")) assert.equal(footer, "");
        else assert.match(footer, mode === "missing" ? /Result unknown/u : mode === "failed" ? /Exit code 2/u : /Success/u);
        if (mode === "running-output") {
          await activate(page.locator('.thread-shell-output__command button'));
          await activate(page.locator('.thread-shell-output__output button'));
          assert.deepEqual(await page.evaluate(() => (window as any).commandClipboard),
            ["printf 'ready\\n'", "\u001b[31mred\u001b[0m\nready"]);
        }
        observations.push({ mode, expected, footer });
      }
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-command-output.png`) });
      commandOutputStates.push({ theme, touch, observations });
      await page.close(); continue;
    }
    for (const engine of (process.argv.includes("--spacing-only") ? [] : ["codex", "hermes", "dsh"])) {
      await page.locator('.thread-reasoning').waitFor();
      await update("empty", engine);
      assert.equal(await page.locator('.thread-reasoning').count(), 0, 'empty reasoning cannot create an empty disclosure');
      assert.equal(await page.locator('.thread-thinking-placeholder').count(), 1, 'no content retains one noninteractive status');
      assert.equal(await page.locator('.thread-thinking-placeholder').evaluate(node => getComputedStyle(node).fontSize), '14px');
      await update("long-detail", engine);
      for (const phase of ["running", "settled"]) {
        const widths = await page.locator('.thread-reasoning').evaluate(element => {
          const summary = element.querySelector<HTMLElement>('.thread-activity-item__summary')!;
          const detail = element.querySelector<HTMLElement>('.thread-activity-item__detail')!;
          return { summary: [summary.clientWidth, summary.scrollWidth], detail: [detail.clientWidth, detail.scrollWidth] };
        });
        assert.ok(widths.summary[0] + 1 >= widths.summary[1], `${phase} thinking label must be fully visible`);
        assert.ok(widths.detail[0] + 1 < widths.detail[1], `${phase} long preview should truncate first`);
        if (phase === "running") await update("tools");
      }
      // Compare actual icon geometry in the shared activity rail, in every theme/viewport.
      const icons = await page.evaluate(() => {
        const thought = document.querySelector<SVGSVGElement>('.thread-reasoning .thread-activity-item__icon > svg')!;
        const slot = thought.parentElement!;
        const rect = (svg: SVGSVGElement) => {
          const box = svg.getBoundingClientRect();
          return { width: box.width, height: box.height, color: getComputedStyle(svg).color };
        };
        return { thought: rect(thought), isBrain: thought.getAttribute('data-activity-glyph') === 'thinking', slotColor: getComputedStyle(slot).color,
          renderedStroke: parseFloat(getComputedStyle(thought).strokeWidth) * thought.getBoundingClientRect().width / thought.viewBox.baseVal.width };
      });
      assert.equal(icons.isBrain, true, 'thinking retains the recognizable brain glyph');
      assert.equal(icons.thought.width, 20);
      assert.equal(icons.thought.height, 20);
      assert.equal(icons.thought.color, icons.slotColor, 'thinking inherits the shared activity slot color');
      assert.ok(Math.abs(icons.renderedStroke - 1.2) < 0.01, 'brain keeps a light stroke at its actual rendered scale');
      await page.screenshot({ path: join(output, `${engine}-${theme}-${touch ? 'touch' : 'mouse'}-long-detail.png`) });
      await update("reset", engine);
      const reason = page.locator('.thread-reasoning');
      const toggle = reason.getByRole('button');
      await reason.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', 'default collapsed even while streaming');
      assert.equal(await reason.locator('.thread-activity-item__prose').count(), 0);
      assert.match(await reason.locator('.thread-activity-item__detail').innerText(), /Current returned line/);
      assert.equal(await page.locator('.thread-thinking-placeholder').count(), 0, 'reasoning owns live status');
      assert.equal(await page.locator('.thread-reasoning[data-reasoning-active="true"]').count(), 1);
      await reason.evaluate(element => { (window as any).__reasoningNode = element; });
      await activate(toggle);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'first real touch/mouse activation works');
      await reason.locator('.thread-activity-item__prose').waitFor();
      await reason.locator('.opencraft-chat-document').waitFor();
      // Wait past the lazy raw fallback. Whitespace can be a source soft
      // break or a visual line wrap at phone width; text must be unchanged.
      assert.equal((await reason.locator('.thread-activity-item__prose').innerText()).replace(/\s+/gu, ' '),
        'First returned line Current returned line');
      assert.doesNotMatch(await reason.innerText(), /Alternate returned detail/);
      await update("grow");
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.match(await reason.locator('.thread-activity-item__prose').innerText(), /New returned line/);
      assert.equal(await page.evaluate(() => (window as any).__reasoningNode === document.querySelector('.thread-reasoning')), true);
      await update("tools");
      assert.equal(await reason.locator('.thread-command,.thread-agent-activity').count(), 0, 'tools cannot hang under reasoning');
      assert.equal(await page.locator('.thread-agent-activity .thread-reasoning').count(), 1,
        'thinking is inner response work, not inside a tool disclosure');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      const density = await reason.evaluate(element => {
        const unit = element.closest('.thread-agent-activity__unit')!;
        const next = unit.nextElementSibling!;
        const header = element.querySelector('.thread-activity-item__header')!;
        const frame = element.closest('.thread-frame')!;
        return {
          gap: next.getBoundingClientRect().top - unit.getBoundingClientRect().bottom,
          headerSize: parseFloat(getComputedStyle(header).fontSize),
          chatSize: parseFloat(getComputedStyle(frame).fontSize),
          expandedTextSize: parseFloat(getComputedStyle(element.querySelector('.opencraft-chat-document')!).fontSize),
        };
      });
      assert.ok(Math.abs(density.gap - 4) < 0.5, 'expanded reasoning preserves the activity row boundary');
      assert.equal(density.headerSize, 14, 'process summaries use the shared body role');
      assert.ok(density.headerSize <= density.chatSize, 'restored summary scale remains readable beside default prose');
      assert.equal(density.expandedTextSize, density.chatSize, 'returned reasoning keeps the reading scale');
      assert.equal(await page.locator('.thread-reasoning[data-reasoning-active="true"]').count(), 0, 'later work owns live feedback');
      await update("complete");
      const workToggle = page.locator('.thread-agent-activity__turn-toggle button');
      assert.equal(await workToggle.count(), 1);
      assert.equal(await workToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await reason.count(), 0, 'completion folds thinking and tools under the work container');
      assert.ok(await page.getByText('Final answer', { exact: true }).isVisible());
      await activate(workToggle);
      await reason.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'completion cannot write collapse choice');
      assert.match(await reason.locator('.thread-activity-item__detail').innerText(), /First returned line/);
      assert.equal(await page.locator('.thread-thinking-placeholder').count(), 0);
      assert.equal(await page.locator('.thread-reasoning[data-reasoning-active="true"]').count(), 0);
      await activate(workToggle);
      assert.equal(await reason.count(), 0);
      await activate(workToggle);
      await reason.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'work folding retains the inner choice');
      await reason.evaluate(element => { (window as any).__reasoningNode = element; });
      await update("prepend");
      assert.equal(await page.evaluate(() => (window as any).__reasoningNode === document.querySelector('.thread-reasoning')), true);
      await update("restore");
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'existing View restore receipt retains explicit choice');
      await activate(toggle);
      await page.waitForFunction(() => !document.querySelector('.thread-reasoning .thread-activity-item__prose'));
      await update("restore");
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      if (!touch) {
        await toggle.focus(); await page.keyboard.press("Enter");
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'native keyboard activation');
        await page.waitForFunction(() => {
          const clip = document.querySelector('.thread-reasoning .thread-activity-item__body-clip');
          const body = document.querySelector('.thread-reasoning .thread-activity-item__body');
          return clip && body && clip.getBoundingClientRect().height >= body.scrollHeight - 1 && getComputedStyle(clip).opacity === '1';
        });
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(output, `${engine}-${theme}-${touch ? 'touch' : 'mouse'}.png`) });
      for (const withClock of [false, true]) {
        await update(withClock ? "long-empty-clock" : "long-empty", engine);
        assert.equal(await page.locator('.thread-reasoning').count(), 0, 'thirteen empty reasoning Items create no content disclosures');
        const responseWork = page.locator('.thread-agent-activity__turn-toggle button');
        assert.equal(await responseWork.count(), 1, 'one response owns one outer work fold despite thirteen empty reasoning boundaries');
        assert.equal(await responseWork.getAttribute('aria-expanded'), 'false');
        const workLabel = (await page.locator('.thread-agent-activity__turn-toggle').innerText()).trim();
        assert.ok(workLabel.length > 0, 'timeless work still has a meaningful disclosure label');
        if (withClock) assert.doesNotMatch(workLabel, /previous message|历史消息/u,
          'an available Turn clock labels the one work disclosure rather than thirteen fragments');
        else assert.match(workLabel, /60/u, 'missing time metadata retains one existing sixty-item disclosure');
        assert.equal(await page.locator('.thread-work-status__label').count(), withClock ? 1 : 0,
          'one Turn clock stays attached to the response work owner, including a trailing empty Item');
        assert.ok(await page.getByText('Long response final answer', { exact: true }).isVisible());
        await page.screenshot({ path: join(output, `${engine}-${theme}-${touch ? 'touch' : 'mouse'}-empty-13-${withClock ? 'clock' : 'timeless'}.png`) });
        await activate(responseWork);
        assert.equal(await responseWork.getAttribute('aria-expanded'), 'true', 'first activation reveals current-response work');
        const innerGroups = page.locator('.thread-agent-activity__group-disclosure > .thread-activity-item__header button');
        for (let index = 0; index < await innerGroups.count(); index++) {
          const group = innerGroups.nth(index);
          if (await group.getAttribute('aria-expanded') === 'false') await activate(group);
        }
        const toolRows = page.locator('.thread-agent-activity__content .thread-activity-item[data-status]');
        assert.equal(await toolRows.count(), 60, 'opening the work surface retains all sixty tools once');
        const commands = await toolRows.locator(':scope > .thread-activity-item__header .thread-activity-item__summary').allTextContents();
        assert.deepEqual(commands.map((label: string) => label.match(/cycle-\d+-tool-\d+/u)?.[0]),
          [8, 6, 4, 4, 5, 5, 1, 5, 4, 4, 2, 5, 7].flatMap((count, cycle) =>
            Array.from({ length: count }, (_, index) => `cycle-${cycle}-tool-${index}`)),
          'hidden reasoning cannot reorder, duplicate or discard current-response tools');
        await activate(responseWork);
        assert.equal(await responseWork.getAttribute('aria-expanded'), 'false');
      }
      await update("middle-empty", engine);
      assert.equal(await page.locator('.thread-reasoning').count(), 0);
      assert.equal(await page.locator('.thread-agent-activity__turn-toggle button').count(), 0,
        'empty reasoning does not manufacture earlier completed response folds while streaming');
      const existingGroup = page.locator('.thread-agent-activity__group').first();
      const existingToggle = existingGroup.getByRole('button').first();
      await activate(existingToggle);
      assert.equal(await existingToggle.getAttribute('aria-expanded'), 'true');
      const existingIdentity = await existingGroup.getAttribute('data-activity-group-id');
      await existingGroup.evaluate(element => { (window as any).__existingToolGroupNode = element; });
      await update("middle-fill");
      assert.equal(await page.locator('.thread-agent-activity__group').first().getAttribute('data-activity-group-id'), existingIdentity,
        'a newly visible reasoning Item retains the first tool-source identity');
      assert.equal(await page.evaluate(() => (window as any).__existingToolGroupNode === document.querySelector('.thread-agent-activity__group')), true,
        'first actual reasoning text retains the already-mounted first tool group');
      assert.equal(await existingToggle.getAttribute('aria-expanded'), 'true', 'first text cannot reset an existing explicit tool choice');
      assert.equal(await page.locator('.thread-reasoning').getByRole('button').getAttribute('aria-expanded'), 'false');
      assert.deepEqual(await page.locator('.thread-agent-activity__group,.thread-reasoning').evaluateAll(elements =>
        elements.map(element => element.classList.contains('thread-reasoning') ? 'reasoning'
          : element.getAttribute('data-activity-group-id')?.includes('before-bash') ? 'before' : 'after')),
        ['before', 'reasoning', 'after'], 'visible reasoning is chronological and independent of both tool groups');
      await update("complete");
      const workFolds = page.locator('.thread-agent-activity__turn-toggle button');
      assert.equal(await workFolds.count(), 1, 'one response final folds all thinking and tools under one work owner');
      assert.equal(await workFolds.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.thread-reasoning').count(), 0);
      await activate(workFolds);
      assert.equal(await workFolds.getAttribute('aria-expanded'), 'true');
      const independentReason = page.locator('.thread-reasoning').getByRole('button');
      assert.equal(await independentReason.getAttribute('aria-expanded'), 'false');
      await activate(independentReason);
      await activate(workFolds);
      assert.equal(await page.locator('.thread-reasoning').count(), 0, 'outer collapse hides all inner work');
      await activate(workFolds);
      await page.locator('.thread-reasoning').waitFor();
      assert.equal(await independentReason.getAttribute('aria-expanded'), 'true', 'reopening restores the thinking choice');
      assert.equal(await existingToggle.getAttribute('aria-expanded'), 'true', 'reopening restores the first tool choice');
      await update("reasoning-only-complete", engine);
      const onlyWork = page.locator('.thread-agent-activity__turn-toggle button');
      assert.equal(await onlyWork.count(), 1, 'reasoning alone is real collapsible work');
      assert.equal(await onlyWork.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.thread-reasoning').count(), 0, 'no completed thinking remains outside work');
      assert.equal(await page.locator('.thread-work-status__label').count(), 1);
      assert.ok(await page.getByText('Final answer', { exact: true }).isVisible());
      await activate(onlyWork);
      const onlyReason = page.locator('.thread-agent-activity .thread-reasoning');
      await onlyReason.waitFor();
      assert.equal(await onlyReason.getByRole('button').getAttribute('aria-expanded'), 'false');
      await activate(onlyReason.getByRole('button'));
      await onlyReason.locator('.thread-activity-item__prose').waitFor();
      await activate(onlyWork);
      await activate(onlyWork);
      await onlyReason.waitFor();
      assert.equal(await onlyReason.getByRole('button').getAttribute('aria-expanded'), 'true');
      await page.screenshot({ path: join(output, `${engine}-${theme}-${touch ? 'touch' : 'mouse'}-reasoning-only.png`) });
      await update("markdown", engine);
      const markdownReason = page.locator('.thread-reasoning');
      const markdownToggle = markdownReason.locator(':scope > .thread-activity-item > .thread-activity-item__header button');
      assert.equal(await markdownToggle.getAttribute('aria-expanded'), 'false');
      assert.equal((await markdownReason.locator('.thread-activity-item__detail').innerText()).trim(), 'Current check');
      await activate(markdownToggle);
      const markdownBody = markdownReason.locator('.opencraft-chat-document');
      await markdownBody.locator('h1 strong').waitFor();
      assert.equal(await markdownBody.locator('h1 strong').innerText(), 'Checking the result');
      assert.equal(await markdownBody.locator('em').innerText(), 'carefully');
      assert.equal(await markdownBody.locator('ul li').count(), 2);
      assert.ok(await markdownBody.locator('code').filter({ hasText: 'a_b' }).count() >= 1);
      assert.ok(await markdownBody.getByText('const a_b = 42;', { exact: true }).count() >= 1);
      assert.equal(await markdownBody.locator('script').count(), 0);
      assert.equal(await page.evaluate(() => (window as any).__unsafeReasoning), undefined);
      assert.equal(await markdownBody.locator('[href^="javascript:"]').count(), 0);
      const fileLink = markdownBody.getByRole('link', { name: 'The file', exact: true });
      await activate(fileLink);
      assert.equal(await markdownToggle.getAttribute('aria-expanded'), 'true', 'resource activation cannot collapse thinking');
      assert.deepEqual(await page.evaluate(() => (window as any).openedReasoningResources.at(-1)),
        { target: 'file:///work/a.ts', kind: 'file' }, 'thinking resources use the existing Host opener');
      await markdownReason.evaluate(element => { (window as any).__markdownReasoningNode = element; });
      await update("markdown-grow");
      assert.equal(await markdownToggle.getAttribute('aria-expanded'), 'true');
      assert.equal((await markdownReason.locator('.thread-activity-item__detail').innerText()).trim(), 'New returned line');
      await markdownBody.locator('strong').filter({ hasText: /^returned$/ }).waitFor();
      assert.equal(await page.evaluate(() => (window as any).__markdownReasoningNode === document.querySelector('.thread-reasoning')), true);
      await update("complete");
      const markdownWork = page.locator('.thread-agent-activity__turn-toggle button');
      assert.equal(await markdownWork.getAttribute('aria-expanded'), 'false');
      await activate(markdownWork);
      assert.equal(await markdownToggle.getAttribute('aria-expanded'), 'true');
      assert.equal((await markdownReason.locator('.thread-activity-item__detail').innerText()).trim(), 'Checking the result');
      await markdownBody.locator('h1 strong').waitFor();
      await page.screenshot({ path: join(output, `${engine}-${theme}-${touch ? 'touch' : 'mouse'}-markdown.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      results.push({ engine, theme, touch, defaultCollapsed: true, independentTools: true, choiceRestored: true, markdown: true,
        firstTextPreservesExistingToolChoice: true, oneResponseWorkFold: true, thirteenEmptyItemsRetainSixtyTools: true });
    }
    await update("activity-scale", "codex");
    const compactGaps = await page.locator('.thread-agent-activity__content').evaluateAll(lists => lists.flatMap(list => {
      const units = [...list.children];
      return units.slice(1).map((unit, index) => unit.getBoundingClientRect().top - units[index]!.getBoundingClientRect().bottom);
    }));
    assert.ok(compactGaps.length >= 3, 'mixed command/image/reasoning fixture crosses activity group boundaries');
    for (const gap of compactGaps) assert.ok(Math.abs(gap - 4) < 0.5, `collapsed summaries share 4px spacing, got ${gap}`);

    await page.locator('.thread-activity-item__icon > [data-action-glyph="image"]').waitFor();
    await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-collapsed-spacing.png`) });
    const imageRow = page.locator('.thread-agent-activity__unit').filter({ has: page.locator('[data-action-glyph="image"]') });
    const imageToggle = imageRow.getByRole('button').first();
    const imageBoundaryGap = () => imageRow.evaluate(unit => unit.nextElementSibling!.getBoundingClientRect().top - unit.getBoundingClientRect().bottom);
    await activate(imageToggle);
    assert.equal(await imageToggle.getAttribute('aria-expanded'), 'true');
    const waitForImageGap = (expected: number) => page.waitForFunction(expected => {
      const icon = document.querySelector('.thread-agent-activity__unit [data-action-glyph="image"]');
      const unit = icon?.closest('.thread-agent-activity__unit');
      return unit && unit.nextElementSibling && Math.abs(unit.nextElementSibling.getBoundingClientRect().top - unit.getBoundingClientRect().bottom - expected) < 0.5;
    }, expected, { timeout: 3_000 });
    await waitForImageGap(4);
    const expandedImageGap = await imageBoundaryGap();
    assert.ok(Math.abs(expandedImageGap - 4) < 0.5, `expanded image details preserve the activity row boundary: ${theme}/${touch} got ${expandedImageGap}`);
    await activate(imageToggle);
    assert.equal(await imageToggle.getAttribute('aria-expanded'), 'false');
    await waitForImageGap(4);
    assert.ok(Math.abs(await imageBoundaryGap() - 4) < 0.5, 'collapsing image restores the shared compact rhythm');

    for (const group of await page.locator('.thread-agent-activity__group').all()) {
      const toggle = group.getByRole('button').first();
      if (await toggle.getAttribute('aria-expanded') === 'false') await activate(toggle);
    }
    await page.locator('.thread-activity-item__icon > [data-opencraft-activity-icon="read"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const measureScale = () => page.evaluate(() => Array.from(document.querySelectorAll<SVGSVGElement>(
      '.thread-activity-item__icon > svg')).map(svg => {
      const rail = svg.parentElement!;
      const header = rail.closest('.thread-activity-item__header')!;
      const summary = header.querySelector('.thread-activity-item__summary')!;
      const box = svg.getBBox(), screen = svg.getBoundingClientRect(), slot = rail.getBoundingClientRect();
      const type = getComputedStyle(summary);
      return { glyph: svg.getAttribute('data-activity-glyph') ?? svg.getAttribute('data-opencraft-activity-icon') ?? svg.getAttribute('data-action-glyph'), paths: svg.innerHTML,
        fontSize: parseFloat(type.fontSize), weight: type.fontWeight,
        width: screen.width, visibleWidth: box.width * screen.width / svg.viewBox.baseVal.width,
        centerOffset: Math.abs(screen.x + screen.width / 2 - slot.x - slot.width / 2),
        renderedStroke: parseFloat(getComputedStyle(svg).strokeWidth) * screen.width / svg.viewBox.baseVal.width };
    }).filter((icon, index, all) => all.findIndex(candidate => candidate.glyph === icon.glyph) === index));
    const current = await measureScale();
    assert.equal(current.length, 4, 'real renderer covers brain, terminal, image and read');
    for (const icon of current) {
      assert.equal(icon.fontSize, 14, `${icon.glyph}: shared body scale`);
      assert.equal(icon.weight, '400');
      assert.ok(icon.visibleWidth >= 14.5 && icon.visibleWidth <= 15.5, `${icon.glyph}: balanced visible silhouette`);
      assert.ok(icon.centerOffset < 0.1, `${icon.glyph}: centered shared rail`);
      assert.ok(typeof icon.glyph === 'string' && icon.glyph.length > 0, 'Measured icons expose their shared artwork identity');
    }
    await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-activity-scale.png`) });
    // Reproduce the previous proportions on the same real consumer, then remove
    // the scoped probe. Glyph identity and interaction remain unchanged.
    const oldScale = await page.addStyleTag({ content: `
      .thread-activity-item__header { font: var(--typography-chat-font) !important; }
      .thread-activity-item__header, .thread-activity-item__header * { transition: none !important; }
      .thread-activity-item__icon { width:16px; }
      .thread-activity-item__icon > svg { width:16px; height:16px; }
      .thread-activity-item__icon > .activity-glyph[data-activity-glyph] { width:16px; height:16px; stroke-width:1.8; }
      .thread-activity-item__icon > .ui-action-glyph { width:16px; height:16px; stroke-width:2; }
      .thread-activity-item__icon > [data-activity-glyph="thinking"] { width:14px; height:14px; stroke-width:1.8; }
      .thread-activity-item__icon > [data-opencraft-activity-icon="read"] { width:15px; height:15px; }
    ` });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.thread-activity-item__summary'))
      .every(node => getComputedStyle(node).fontSize === getComputedStyle(document.documentElement).getPropertyValue('--typography-chat-size').trim()));
    const previous = await measureScale();
    for (let index = 0; index < current.length; index++) {
      assert.equal(previous[index].paths, current[index].paths, 'rendering adjustment preserves glyph paths');
      assert.equal(previous[index].fontSize, current[index].fontSize, `${current[index].glyph}: restore readable copy without shrinking text`);
      assert.ok(previous[index].visibleWidth < current[index].visibleWidth, 'previous silhouette was smaller');
    }
    await page.screenshot({ path: join(output, `${theme}-${touch ? 'touch' : 'mouse'}-activity-scale-before.png`) });
    await oldScale.evaluate(node => node.remove());
    activityScales.push({ theme, touch, dpr: touch ? 2 : 1,
      previous: previous.map(({ paths, ...metrics }) => metrics), current: current.map(({ paths, ...metrics }) => metrics) });
    assert.deepEqual(errors, []);
    const resizeFeedback = await page.evaluate(() => (window as any).resizeFeedback);
    assert.deepEqual(resizeFeedback.filter((event: any) => !['long-empty', 'long-empty-clock', 'middle-empty'].includes(event.action)), [],
      'Markdown and normal thinking interactions must not introduce ResizeObserver feedback');
    // Preserve evidence of the separate, pre-existing long-tool-group reflow
    // sequence instead of suppressing browser error delivery or calling it clean.
    if (resizeFeedback.length > 0) console.log(JSON.stringify({ theme, touch,
      existingToolGroupResizeWarnings: resizeFeedback.map((event: any) => event.action) }));
    await page.close();
  }
  const localizedLabels = process.argv.includes("--detail-view-only") || process.argv.includes("--diff-reading-only") || process.argv.includes("--diff-position-only") || process.argv.includes("--turn-files-only") || process.argv.includes("--turn-entry-only") || process.argv.includes("--command-view-only") ? [] : [
    ["zh-Hant", "思考中…", "思考過程"],
    ["id-ID", "Sedang berpikir…", "Proses berpikir"],
    ["es", "Pensando…", "Razonamiento"],
    ["ja-JP", "思考中…", "思考過程"],
    ["ko-KR", "생각하는 중…", "사고 과정"],
  ] as const;
  for (const [locale, running, settled] of ((process.argv.includes("--commands-only") || process.argv.includes("--subagents-only") || process.argv.includes("--command-completion-only")) ? [] : localizedLabels)) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true });
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=light&locale=${locale}`);
    await page.locator('[data-revision="0"]').waitFor();
    await page.evaluate(() => (window as any).update("long-detail", "codex"));
    await page.locator('[data-revision="1"]').waitFor();
    for (const [label, revision] of [[running, 1], [settled, 2]] as const) {
      const header = await page.locator('.thread-reasoning').evaluate(element => {
        const summary = element.querySelector<HTMLElement>('.thread-activity-item__summary')!;
        const detail = element.querySelector<HTMLElement>('.thread-activity-item__detail')!;
        return { label: summary.firstChild?.textContent, summary: [summary.clientWidth, summary.scrollWidth],
          detail: [detail.clientWidth, detail.scrollWidth] };
      });
      assert.equal(header.label, label, `${locale} reasoning label`);
      assert.ok(header.summary[0] + 1 >= header.summary[1], `${locale} reasoning label must fit`);
      assert.ok(header.detail[0] + 1 < header.detail[1], `${locale} long preview should truncate`);
      if (revision === 1) {
        await page.evaluate(() => (window as any).update("tools"));
        await page.locator('[data-revision="2"]').waitFor();
      }
    }
    await page.screenshot({ path: join(output, `opencraft-${locale}-touch-long-detail.png`) });
    await page.close();
  }
  await writeFile(join(output, 'subagent-details.json'), JSON.stringify(subagentDetails, null, 2));
  await writeFile(join(output, 'command-elapsed.json'), JSON.stringify(commandElapsed, null, 2));
  await writeFile(join(output, 'command-output-states.json'), JSON.stringify(commandOutputStates, null, 2));
  await writeFile(join(output, 'activity-scales.json'), JSON.stringify(activityScales, null, 2));
  console.log(JSON.stringify({ passed: results, subagentDetails, commandOutputStates, localizedLabels: ["--subagents-only", "--command-completion-only", "--commands-only", "--command-output-only"].some(flag => process.argv.includes(flag)) ? [] : localizedLabels.map(([locale]) => locale), output,
    scope: 'Real shared projector and Conversation/disclosure/viewport; engine text synthetic, not paid model or native iPhone acceptance.' }));
} finally { await browser?.close(); await vite.close(); }
