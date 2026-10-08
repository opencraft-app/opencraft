import assert from "node:assert/strict";
import { createServer } from "vite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const output = await mkdtemp("/tmp/opencraft-reasoning-disclosure-");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", esbuild: { jsx: "automatic" },
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-reasoning-disclosure",
  server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "reasoning-disclosure", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== "/" && !request.url?.startsWith("/?")) return next();
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/tests/fixtures/reasoning-disclosure.tsx"></script>');
    });
  } }] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const results = [];
  for (const touch of [false, true]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: touch ? 390 : 1024, height: 900 }, hasTouch: touch,
      isMobile: touch, reducedMotion: touch ? "reduce" : "no-preference" });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name=value=>value");
    await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}/?theme=${theme}&locale=${touch ? "zh" : "en"}`);
    const update = async (action: string, engine?: string) => {
      const before = Number(await page.locator('[data-revision]').getAttribute('data-revision'));
      await page.evaluate(([action, engine]) => (window as any).update(action, engine), [action, engine]);
      await page.locator(`[data-revision="${before + 1}"]`).waitFor();
    };
    const activate = (target: any) => touch ? target.tap() : target.click();
    for (const engine of ["codex", "hermes", "dsh"]) {
      await page.locator('.thread-reasoning').waitFor();
      await update("empty", engine);
      assert.equal(await page.locator('.thread-reasoning').count(), 0, 'empty reasoning cannot create an empty disclosure');
      assert.equal(await page.locator('.thread-thinking-placeholder').count(), 1, 'no content retains one noninteractive status');
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
      assert.equal(await reason.locator('.thread-activity-item__prose').innerText(), 'First returned line\nCurrent returned line');
      assert.doesNotMatch(await reason.innerText(), /Alternate returned detail/);
      await update("grow");
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.match(await reason.locator('.thread-activity-item__prose').innerText(), /New returned line/);
      assert.equal(await page.evaluate(() => (window as any).__reasoningNode === document.querySelector('.thread-reasoning')), true);
      await update("tools");
      assert.equal(await reason.locator('.thread-command,.thread-agent-activity').count(), 0, 'tools cannot hang under reasoning');
      assert.equal(await page.locator('.thread-agent-activity .thread-reasoning').count(), 0);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.thread-reasoning[data-reasoning-active="true"]').count(), 0, 'later work owns live feedback');
      await update("complete");
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'completion cannot write collapse choice');
      assert.match(await reason.locator('.thread-activity-item__detail').innerText(), /First returned line/);
      assert.equal(await page.locator('.thread-thinking-placeholder').count(), 0);
      assert.equal(await page.locator('.thread-reasoning[data-reasoning-active="true"]').count(), 0);
      const workToggle = page.locator('.thread-agent-activity__turn-toggle button');
      if (await workToggle.count()) {
        await activate(workToggle);
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'work fold choice is independent');
      }
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
      assert.equal(await workFolds.count(), 1, 'one response final grants one nearest meaningful outer work fold');
      assert.equal(await workFolds.getAttribute('aria-expanded'), 'false');
      assert.equal(await existingToggle.getAttribute('aria-expanded'), 'true', 'completion retains the earlier inline tool choice');
      await activate(workFolds);
      assert.equal(await workFolds.getAttribute('aria-expanded'), 'true');
      const independentReason = page.locator('.thread-reasoning').getByRole('button');
      assert.equal(await independentReason.getAttribute('aria-expanded'), 'false');
      await activate(independentReason);
      await activate(workFolds);
      assert.equal(await independentReason.getAttribute('aria-expanded'), 'true', 'closing tools leaves returned reasoning open');
      assert.equal(await existingToggle.getAttribute('aria-expanded'), 'true', 'closing the current work fold does not close earlier inline tools');
      results.push({ engine, theme, touch, defaultCollapsed: true, independentTools: true, choiceRestored: true,
        firstTextPreservesExistingToolChoice: true, oneResponseWorkFold: true, thirteenEmptyItemsRetainSixtyTools: true });
    }
    assert.deepEqual(errors, []); await page.close();
  }
  console.log(JSON.stringify({ passed: results, output, scope: 'Real shared projector and Conversation/disclosure/viewport; engine text synthetic, not paid model or native iPhone acceptance.' }));
} finally { await browser?.close(); await vite.close(); }
