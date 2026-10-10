import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertBrowserRuntimeDependencies } from "./browser-smoke-preflight.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
assertBrowserRuntimeDependencies(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ?? chromium.executablePath());
const assets = resolve("apps/workbench-web/dist/assets");
const css = (await Promise.all((await readdir(assets)).filter(name => name.endsWith(".css"))
  .map(name => readFile(join(assets, name), "utf8")))).join("\n");
assert.ok(css.includes(".cloud-desktop-panel__feedback"), "Build current production CSS first");
const bundle = await build({ entryPoints: ["tests/fixtures/cloud-desktop-panel-ui.tsx"],
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  // Styles are the complete current release CSS above, not a second fixture
  // compilation. The Shell's unused announcement asset remains a real data URL.
  loader: { ".scss": "empty", ".css": "empty", ".svg": "dataurl" },
  define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production" }) } });
const directory = await mkdtemp(join(tmpdir(), "opencraft-desktop-ui-"));
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0]!.contents); }
  else if (request.url === "/fixture.css") { response.setHeader("Content-Type", "text/css"); response.end(css); }
  else { response.setHeader("Content-Type", "text/html"); response.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body style="margin:0"><div id="root" style="width:100vw;height:100dvh"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
let browser: any;
const receipts: unknown[] = [];
try {
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const theme of (process.env.OPENCRAFT_DESKTOP_SHELL_ONLY === "true" ? [] : ["light", "dark", "custom"])) for (const width of [1024, 720, 320]) {
    const page = await browser.newPage({ viewport: { width, height: width === 1024 ? 900 : 480 }, hasTouch: width === 320,
      reducedMotion: theme === "light" ? "no-preference" : "reduce" });
    const activate = (button: any) => width === 320 ? button.tap() : button.click();
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await page.locator('[data-phase="connecting"]').waitFor();
    await page.evaluate(theme => {
      (window as any).__desktopUi.theme(theme);
      (window as any).__surfaceBefore = document.querySelector(".cloud-desktop-panel__surface");
    }, theme);
    const title = page.getByRole("heading", { name: "Connecting to desktop…" });
    await title.waitFor();
    const feedbackStyle = await title.evaluate(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { size: style.fontSize, line: style.lineHeight, weight: style.fontWeight,
        center: rect.x + rect.width / 2, width: rect.width };
    });
    assert.equal(feedbackStyle.size, "18px"); assert.equal(feedbackStyle.line, "24px");
    assert.equal(feedbackStyle.weight, "500"); assert.ok(Math.abs(feedbackStyle.center - width / 2) <= 1);
    const background = await page.locator(".cloud-desktop-panel__feedback").evaluate(element => getComputedStyle(element).backgroundColor);
    assert.equal(background, theme === "light" ? "rgb(255, 255, 255)" : theme === "dark" ? "rgb(24, 24, 24)" : "rgb(23, 35, 47)");
    const initialAction = page.locator('.ui-desktop-view__action');
    const controls = page.locator('.ui-desktop-view__controls');
    assert.equal(await controls.evaluate(element => getComputedStyle(element).visibility), 'hidden');
    assert.equal(await controls.getAttribute('aria-hidden'), 'true');
    assert.equal(await controls.evaluate(element => element.hasAttribute('inert')), true);
    assert.equal(await page.getByRole('button', { name: 'Take control', exact: true }).count(), 0,
      'connecting must not expose a duplicate disabled control strip');
    const reservedControls = await controls.boundingBox();
    assert.ok(reservedControls && reservedControls.height > 0, 'invisible controls still reserve geometry');
    const outline = await initialAction.evaluate(element => {
      const style = getComputedStyle(element); return { width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor };
    });
    assert.equal(outline.width, "0px", "rich ownership action is solid, not an outline toolbar action");
    const progress = page.locator(".cloud-desktop-panel .ui-progress-indicator");
    const motion = await progress.evaluate(element => {
      const style = getComputedStyle(element);
      return { name: style.animationName, duration: style.animationDuration,
        easing: style.animationTimingFunction, width: style.width, height: style.height };
    });
    assert.equal(motion.name, theme === "light" ? "ui-progress-rotate" : "none");
    assert.equal(motion.width, "24px"); assert.equal(motion.height, "24px");
    assert.deepEqual(await progress.locator("svg").evaluate(element => {
      const style = getComputedStyle(element); return { width: style.width, height: style.height };
    }), { width: "24px", height: "24px" }, "empty-state glyph sizing cannot enlarge a nested progress vector");
    assert.equal(await progress.evaluate(element => getComputedStyle(element).color),
      await page.locator(".cloud-desktop-panel__feedback").evaluate(element => getComputedStyle(element).color));
    assert.equal(await progress.locator("circle").getAttribute("opacity"), "0.3");
    let frameSamples: { time: number; matrix: string }[] = [];
    if (theme === "light") {
      assert.equal(motion.duration, "2s"); assert.equal(motion.easing, "steps(60)");
      // Deliberately mount later: all indicators must use the same clock phase.
      await page.waitForTimeout(120);
      await page.evaluate(() => (window as any).__desktopUi.mountProgressProbe());
      await page.waitForFunction(() => {
        const elements = [...document.querySelectorAll(".ui-progress-indicator")];
        return elements.length === 2 && elements.every(element => element.getAnimations()[0]?.startTime === 0);
      });
      const frames = await progress.evaluate(element => {
        // Sample the real CSS keyframes on the real DOM, without turning the
        // stylesheet-owned animation into a script-controlled persistent one.
        const effect = element.getAnimations()[0]!.effect as KeyframeEffect;
        const animation = new Animation(new KeyframeEffect(element, effect.getKeyframes(), effect.getTiming()), document.timeline);
        animation.pause();
        try {
          return [0, 16, 34, 1000, 1999].map(time => {
            animation.currentTime = time;
            return { time, matrix: getComputedStyle(element).transform };
          });
        } finally { animation.cancel(); }
      });
      frameSamples = frames;
      assert.equal(frames[0].matrix, frames[1].matrix, "steps must hold a frame, not interpolate");
      assert.notEqual(frames[1].matrix, frames[2].matrix);
      assert.equal(frames[3].matrix, "matrix(-1, 0, 0, -1, 0, 0)", "half-cycle is exactly a half-turn");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => [...document.querySelectorAll(".ui-progress-indicator")]
        .every(element => getComputedStyle(element).animationName === "none" && element.getAnimations().length === 0));
      assert.equal(await progress.evaluate(element => element.getAnimations().length), 0);
      assert.equal(await progress.evaluate(element => getComputedStyle(element).transform), "none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.waitForFunction(() => [...document.querySelectorAll(".ui-progress-indicator")]
        .every(element => element.getAnimations()[0]?.startTime === 0));
    }
    const disabledFeedback = await initialAction.evaluate(element => {
      const style = getComputedStyle(element);
      return { opacity: style.opacity, property: style.transitionProperty, transform: style.transform };
    });
    // Global reduced-motion CSS shortens duration to 0.01ms. The meaningful
    // invariant is no transitioned property, regardless of that fallback.
    assert.deepEqual(disabledFeedback, { opacity: "0.4", property: "none", transform: "none" });
    const buttonStyle = await initialAction.evaluate(element => {
      const style = getComputedStyle(element); return { size: style.fontSize, line: style.lineHeight,
        weight: style.fontWeight, radius: style.borderRadius, height: element.getBoundingClientRect().height };
    });
    assert.equal(buttonStyle.size, "12px"); assert.equal(buttonStyle.weight, "600");
    assert.equal(buttonStyle.radius, "999px"); assert.ok(buttonStyle.height >= (width === 320 ? 44 : 32));
    // The shared React Button always projects a size (md by default). Density
    // must beat every legacy size, not only raw plugin buttons without a size.
    for (const size of ["sm", "md", "lg", "toolbar"]) {
      const style = await initialAction.evaluate((element, size) => {
        (element as HTMLElement).dataset.size = size;
        const style = getComputedStyle(element), rect = element.getBoundingClientRect();
        return { size: style.fontSize, line: style.lineHeight, radius: style.borderRadius, height: rect.height };
      }, size);
      assert.deepEqual(style, { size: "12px", line: "16px", radius: "999px", height: width === 320 ? 44 : 32 },
        `compact density must override ${size} size`);
    }
    await initialAction.evaluate(element => delete (element as HTMLElement).dataset.size);
    await page.screenshot({ path: join(directory, `${theme}-${width}-connecting.png`) });
    await page.evaluate(() => (window as any).__desktopUi.ready());
    await page.locator('[data-phase="ready"]').waitFor();
    assert.equal(await controls.evaluate(element => getComputedStyle(element).visibility), 'visible');
    assert.equal(await controls.evaluate(element => element.hasAttribute('inert')), false);
    assert.equal((await controls.boundingBox())!.height, reservedControls!.height,
      'readiness changes visibility, not reserved control height');
    if (width === 320) {
      const pasteBounds = await page.getByRole("button", { name: "Paste", exact: true }).boundingBox();
      assert.ok(pasteBounds && pasteBounds.width >= 44 && pasteBounds.height >= 44,
        "icon-only touch actions also need a two-dimensional 44px hit target");
    }
    const surfaceBefore = await page.locator(".cloud-desktop-panel__surface").boundingBox();
    assert.ok(Math.abs(surfaceBefore!.width / surfaceBefore!.height - 1.6) < .01,
      "card geometry follows decoded framebuffer, not available panel aspect");
    const frameBefore = await page.locator('.ui-desktop-view__frame').boundingBox();
    assert.deepEqual(frameBefore, surfaceBefore);
    assert.equal(await page.locator('.ui-desktop-view__ring').evaluate(element => getComputedStyle(element).visibility), 'hidden');
    // Taking via the media surface shares intent/cancellation, never a second grant owner.
    await activate(page.locator('.cloud-desktop-panel__surface canvas'));
    await page.locator('[data-control="requesting"]').waitFor();
    assert.equal(await page.locator('.ui-desktop-view').getAttribute('data-owned'), 'false');
    await activate(page.getByRole('button', { name: 'Stop controlling', exact: true }));
    await page.locator('[data-control="observing"]').waitFor();
    const toolbarBefore = await page.locator(".cloud-desktop-panel__toolbar").boundingBox();
    const naturalStatus = await page.locator('.ui-desktop-view__status').evaluate(element => ({
      width: element.getBoundingClientRect().width,
      basis: getComputedStyle(element).flexBasis,
      islandMin: getComputedStyle(element.parentElement!).minWidth,
    }));
    assert.equal(naturalStatus.basis, 'auto');
    assert.equal(naturalStatus.islandMin, '0px');
    assert.ok(naturalStatus.width < 140, 'localized intrinsic width replaces the old 140px reservation');
    const shoulders = await page.locator('.ui-desktop-view__island').evaluate(element => {
      const left = getComputedStyle(element, '::before'), right = getComputedStyle(element, '::after');
      return { leftTop: left.top, rightTop: right.top, leftWidth: left.width, leftHeight: left.height, rightHeight: right.height };
    });
    assert.deepEqual(shoulders, width === 1024
      ? { leftTop: '-1px', rightTop: '-1.5px', leftWidth: '16px', leftHeight: '24px', rightHeight: '25px' }
      : { leftTop: '1.42969px', rightTop: '1.42969px', leftWidth: '17px', leftHeight: '24px', rightHeight: '25px' });
    const controlBounds = await page.getByRole("button", { name: "Take control", exact: true }).boundingBox();
    const pasteBefore = await page.getByRole("button", { name: "Paste", exact: true }).boundingBox();
    const takeAction = page.getByRole("button", { name: "Take control", exact: true });
    // Control variable: native click without implicit button focus (e.g. a
    // touch/AT activation). Take itself must focus, and a late grant cannot
    // steal focus back after the user moves to another task.
    const releaseBeforeFocusTest = (await page.evaluate(() => (window as any).__desktopUi.counts())).releases;
    await takeAction.evaluate(element => (element as HTMLButtonElement).click());
    await page.locator('[data-control="requesting"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "CANVAS",
      "Take acquires focus synchronously, before authorization");
    await page.evaluate(() => {
      const input = document.createElement("input"); input.id = "outside-focus-probe";
      document.body.append(input); input.focus();
      (window as any).__desktopUi.grant();
    });
    await page.locator('[data-control="observing"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "outside-focus-probe");
    assert.equal((await page.evaluate(() => (window as any).__desktopUi.counts())).releases, releaseBeforeFocusTest + 1);
    await page.locator("#outside-focus-probe").evaluate(element => element.remove());
    const expectedColors = await takeAction.evaluate(element => {
      const probe = document.createElement("span"); element.append(probe);
      probe.style.transition = "none";
      probe.style.backgroundColor = "var(--color-background-button-primary)";
      const base = getComputedStyle(probe).backgroundColor;
      probe.style.backgroundColor = "var(--color-background-button-primary-hover)";
      const hover = getComputedStyle(probe).backgroundColor;
      const rawHover = getComputedStyle(element).getPropertyValue("--color-background-button-primary-hover");
      probe.remove(); return { base, hover, rawHover };
    });
    // Sample a real held press, not just its post-click state. No scaling or
    // delayed visual feedback may move the action or the media viewport.
    const center = { x: controlBounds!.x + controlBounds!.width / 2, y: controlBounds!.y + controlBounds!.height / 2 };
    const touchSession = width === 320 ? await page.context().newCDPSession(page) : null;
    if (touchSession) await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [center] });
    else { await page.mouse.move(center.x, center.y); await page.mouse.down(); }
    const heldStyle = await takeAction.evaluate(element => {
      const style = getComputedStyle(element); return { background: getComputedStyle(element, '::before').backgroundColor,
        property: style.transitionProperty, transform: style.transform };
    });
    assert.deepEqual(heldStyle, { background: width === 320 ? expectedColors.base : expectedColors.hover,
      property: "none", transform: "none" }, JSON.stringify({ theme, width, expectedColors, modality: await page.evaluate(() => ({
        touch: document.documentElement.dataset.touchInteraction,
        hover: matchMedia("(any-hover: hover)").matches,
        coarse: matchMedia("(any-pointer: coarse)").matches,
        focused: document.activeElement?.tagName,
      })) }));
    assert.deepEqual(await takeAction.boundingBox(), controlBounds);
    assert.deepEqual(await page.locator(".cloud-desktop-panel__surface").boundingBox(), surfaceBefore);
    if (touchSession) {
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      // Keep this fixture-page session until page.close: detaching CDP can
      // reset Chromium's coarse-pointer emulation mid-geometry assertion.
    } else await page.mouse.up();
    const cancel = page.getByRole("button", { name: "Stop controlling", exact: true }); await cancel.waitFor();
    assert.equal(await page.locator('.ui-desktop-view').getAttribute('data-owned'), 'false');
    assert.equal(await cancel.locator(".ui-button__label").evaluate(element => getComputedStyle(element).opacity), "1");
    assert.deepEqual(await cancel.boundingBox(), controlBounds, "pending cannot move or resize the action");
    assert.deepEqual(await page.getByRole("button", { name: "Paste", exact: true }).boundingBox(), pasteBefore);
    assert.deepEqual(await page.locator(".cloud-desktop-panel__surface").boundingBox(), surfaceBefore,
      "pending control cannot move the desktop");
    await activate(cancel);
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    await activate(page.getByRole("button", { name: "Take control", exact: true }));
    await page.evaluate(() => (window as any).__desktopUi.grant());
    await page.getByRole("button", { name: "Stop controlling", exact: true }).waitFor();
    await page.locator('.ui-desktop-view[data-owned="true"]').waitFor();
    const desktopColors = await page.locator('.ui-desktop-view').evaluate(element => ({
      background: getComputedStyle(element).getPropertyValue('--desktop-control-background').trim(),
      foreground: getComputedStyle(element).getPropertyValue('--desktop-control-foreground').trim(),
      globalAccent: getComputedStyle(element).getPropertyValue('--codex-base-accent').trim(),
      trace: getComputedStyle(element.querySelector('.ui-desktop-view__trace > span')!).backgroundColor,
      wash: getComputedStyle(element.querySelector('.ui-desktop-view__visor-background > span')!).backgroundColor,
      status: getComputedStyle(element.querySelector('.ui-desktop-view__status')!).color,
    }));
    assert.equal(desktopColors.background, theme === 'light' ? '#8952ee' : '#7849d1');
    assert.match(desktopColors.foreground, /^#(?:fff|ffffff)$/u, 'minified white remains the explicit paired foreground');
    assert.notEqual(desktopColors.background, desktopColors.globalAccent, 'desktop does not borrow app accent');
    assert.equal(desktopColors.trace, theme === 'light' ? 'rgb(137, 82, 238)' : 'rgb(120, 73, 209)');
    assert.equal(desktopColors.wash, desktopColors.trace, 'ring and wash share the same appearance');
    assert.equal(desktopColors.status, 'rgb(255, 255, 255)', 'foreground is an explicit paired color');
    const buttonFade = await page.locator('.ui-desktop-view__action').evaluate(element => {
      const transitions = element.getAnimations({ subtree: true });
      for (const animation of transitions) { animation.pause(); animation.currentTime = 120; }
      const style = getComputedStyle(element, '::before');
      const sample = { count: transitions.length, opacity: Number(style.opacity), property: style.transitionProperty,
        duration: style.transitionDuration, transform: getComputedStyle(element).transform };
      for (const animation of transitions) animation.play();
      return sample;
    });
    assert.equal(buttonFade.transform, 'none', 'ownership transition does not scale the action');
    if (theme === 'light') {
      assert.equal(buttonFade.count, 1);
      assert.equal(buttonFade.property, 'opacity'); assert.equal(buttonFade.duration, '0.24s');
      assert.ok(buttonFade.opacity > 0 && buttonFade.opacity < 1, 'solid button layer fades rather than cuts');
    } else {
      assert.equal(buttonFade.count, 0); assert.equal(buttonFade.opacity, 0, 'reduced motion changes immediately');
    }
    if (theme === 'light' && width !== 1024) {
      const crossfade = await page.locator('.ui-desktop-view__shadow').evaluate(element => {
        const transitions = element.getAnimations({ subtree: true });
        for (const animation of transitions) { animation.pause(); animation.currentTime = 120; }
        const before = getComputedStyle(element, '::before'), after = getComputedStyle(element, '::after');
        const sample = { count: transitions.length, before: Number(before.opacity), after: Number(after.opacity) };
        for (const animation of transitions) animation.play();
        return sample;
      });
      assert.equal(crossfade.count, 2, 'both fixed shadow layers animate on confirmation');
      assert.ok(crossfade.before > 0 && crossfade.before < 1);
      assert.ok(crossfade.after > 0 && crossfade.after < 1);
      assert.ok(Math.abs(crossfade.before + crossfade.after - 1) < .001, 'mid-frame complementary opacity');
    }
    assert.equal(await page.locator('.ui-desktop-view__ring').evaluate(element => getComputedStyle(element).visibility), 'visible');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "CANVAS");
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ui-desktop-view__controls')!).transform === 'matrix(1, 0, 0, 1, 0, 0)');
    const joinedToolbar = await page.locator('.cloud-desktop-panel__toolbar').boundingBox();
    assert.equal(joinedToolbar!.y, toolbarBefore!.y - 8, 'ownership island joins the media edge');
    assert.equal(joinedToolbar!.height, toolbarBefore!.height);
    assert.ok(Math.abs(joinedToolbar!.x + joinedToolbar!.width / 2 - frameBefore!.x - frameBefore!.width / 2) < 1,
      'confirmed visor stays centered');
    const shadows = await page.locator('.ui-desktop-view__shadow').evaluate(element => {
      const before = getComputedStyle(element, '::before'), after = getComputedStyle(element, '::after');
      return { baseShadow: getComputedStyle(element).boxShadow, property: before.transitionProperty,
        duration: before.transitionDuration, afterDisplay: after.display };
    });
    assert.equal(shadows.baseShadow, 'none', 'fixed shadow layers crossfade instead of interpolating geometry');
    assert.equal(shadows.property, theme === 'light' ? 'opacity' : 'none');
    if (theme === 'light') assert.equal(shadows.duration, '0.24s');
    if (width === 1024) assert.equal(shadows.afterDisplay, 'none');
    assert.deepEqual(await page.locator('.cloud-desktop-panel__surface').boundingBox(), surfaceBefore);
    await page.waitForFunction(() => [...document.querySelectorAll('.ui-desktop-view__trace > span')]
      .every(element => getComputedStyle(element).transform === 'matrix(1, 0, 0, 1, 0, 0)'));
    const ringStyle = await page.locator('.ui-desktop-view__ring').evaluate(element => {
      const style = getComputedStyle(element); return { composite: style.maskComposite, padding: style.paddingTop,
        radius: style.borderRadius, transition: style.transitionProperty };
    });
    assert.ok(ringStyle.composite.split(',').every(value => value.trim() === 'exclude'));
    assert.equal(ringStyle.padding, width === 1024 ? '6.75px' : '4px');
    assert.equal(await page.locator('.ui-desktop-view__surface').evaluate(element => getComputedStyle(element).borderRadius),
      width === 1024 ? '23px' : '11.628px');
    if (theme !== 'light') assert.equal(ringStyle.transition, 'none');
    await page.screenshot({ path: join(directory, `${theme}-${width}-ready.png`) });
    // Complete native activation, not just direct controller/window-blur calls.
    const requestsBeforeStop = (await page.evaluate(() => (window as any).__desktopUi.counts())).requests;
    await activate(page.getByRole("button", { name: "Stop controlling", exact: true }));
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    const releaseFade = await page.locator('.ui-desktop-view__action').evaluate(element => {
      const transitions = element.getAnimations({ subtree: true });
      for (const animation of transitions) { animation.pause(); animation.currentTime = 120; }
      const opacity = Number(getComputedStyle(element, '::before').opacity);
      for (const animation of transitions) animation.play();
      return opacity;
    });
    if (theme === 'light') assert.ok(releaseFade > 0 && releaseFade < 1, 'release fades the solid layer back in');
    else assert.equal(releaseFade, 1);
    assert.equal((await page.evaluate(() => (window as any).__desktopUi.counts())).requests, requestsBeforeStop);
    await activate(page.getByRole("button", { name: "Take control", exact: true }));
    await page.evaluate(() => (window as any).__desktopUi.grant());
    const stop = page.getByRole("button", { name: "Stop controlling", exact: true });
    await stop.waitFor();
    await stop.evaluate(element => element.addEventListener("pointerdown", () => {
      (document.activeElement as HTMLElement)?.blur();
    }, { once: true }));
    const requestsBeforeBlur = (await page.evaluate(() => (window as any).__desktopUi.counts())).requests;
    await activate(stop); // pointerdown → real null focusout → click
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    assert.equal((await page.evaluate(() => (window as any).__desktopUi.counts())).requests, requestsBeforeBlur,
      "a single stop activation must never turn into a fresh control request");
    assert.deepEqual(await page.locator(".cloud-desktop-panel__surface").boundingBox(), surfaceBefore);
    for (const key of ["Enter", "Space"]) {
      const take = page.getByRole("button", { name: "Take control", exact: true });
      await take.focus(); await page.keyboard.press(key);
      await page.getByRole("button", { name: "Stop controlling", exact: true }).waitFor();
      await page.evaluate(() => (window as any).__desktopUi.grant());
      const release = page.getByRole("button", { name: "Stop controlling", exact: true });
      await release.waitFor(); await release.focus(); await page.keyboard.press(key);
      await take.waitFor();
      await take.focus(); await page.keyboard.press(key);
      await page.getByRole("button", { name: "Stop controlling", exact: true }).waitFor();
      await page.evaluate(() => (window as any).__desktopUi.grant());
      await release.waitFor(); await release.focus();
      await release.evaluate(element => element.addEventListener("keydown", () => (element as HTMLElement).blur(), { once: true }));
      const beforeKeyBlur = (await page.evaluate(() => (window as any).__desktopUi.counts())).requests;
      await page.keyboard.press(key); await take.waitFor();
      assert.equal((await page.evaluate(() => (window as any).__desktopUi.counts())).requests, beforeKeyBlur,
        "keyboard stop followed by null blur cannot become a take");
    }
    await activate(page.getByRole("button", { name: "Take control", exact: true }));
    await page.evaluate(() => (window as any).__desktopUi.grant());
    await page.getByRole("button", { name: "Stop controlling", exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.getByRole("button", { name: "Take control", exact: true }).waitFor();
    await page.evaluate(() => (window as any).__desktopUi.ready(false));
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.cloud-desktop-panel__actions button[aria-pressed]')?.disabled);
    assert.equal(await page.locator('.ui-desktop-view__action').isDisabled(), true);
    await page.evaluate(() => (window as any).__desktopUi.fail());
    await page.getByRole("heading", { name: "Desktop unavailable" }).waitFor();
    await page.screenshot({ path: join(directory, `${theme}-${width}-failed.png`) });
    await page.evaluate(() => (window as any).__desktopUi.connecting());
    await activate(page.getByRole("button", { name: "Reconnect", exact: true }));
    await title.waitFor();
    assert.equal(await controls.evaluate(element => getComputedStyle(element).visibility), 'hidden');
    assert.equal(await controls.getAttribute('aria-hidden'), 'true');
    assert.equal(await controls.evaluate(element => element.hasAttribute('inert')), true);
    const preview = page.locator('.ui-desktop-view__preview');
    await preview.waitFor();
    const cached = await preview.evaluate((element: HTMLImageElement) => ({
      src: element.src.startsWith('data:image/jpeg;base64,'),
      events: getComputedStyle(element).pointerEvents, width: element.naturalWidth, height: element.naturalHeight,
    }));
    assert.equal(cached.src, true); assert.equal(cached.events, 'none');
    await page.waitForFunction(() => (document.querySelector('.ui-desktop-view__preview') as HTMLImageElement)?.naturalWidth === 960);
    assert.equal(await page.locator('.ui-desktop-view').getAttribute('data-owned'), 'false');
    await page.screenshot({ path: join(directory, `${theme}-${width}-recovery-preview.png`) });
    await page.evaluate(() => (window as any).__desktopUi.ready());
    await page.locator('[data-phase="ready"]').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ui-desktop-view__preview')!).opacity === '0');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.cloud-desktop-panel__feedback')!).visibility === 'hidden');
    // Local native control explicitly has no clipboard capability: no dead icon.
    await page.evaluate(() => (window as any).__desktopUi.ready(true, false));
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Paste"]'));
    assert.equal(await page.locator(".cloud-desktop-panel__actions button").count(), 1);
    await page.screenshot({ path: join(directory, `${theme}-${width}-native-toolbar.png`) });
    const counts = await page.evaluate(() => (window as any).__desktopUi.counts());
    assert.equal(counts.preparations, 2); assert.equal(counts.mounts, 2);
    assert.equal(await page.evaluate(() => (window as any).__surfaceBefore === document.querySelector(".cloud-desktop-panel__surface")), true);
    await page.evaluate(() => (window as any).__desktopUi.locale("zh-CN"));
    const chineseTake = page.getByRole("button", { name: "接管桌面", exact: true });
    await chineseTake.waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ui-desktop-view__controls')!).transform === 'matrix(1, 0, 0, 1, 0, 8)');
    const chineseBounds = await chineseTake.boundingBox();
    await activate(chineseTake);
    const chineseCancel = page.getByRole("button", { name: "停止控制", exact: true });
    await chineseCancel.waitFor();
    assert.deepEqual(await chineseCancel.boundingBox(), chineseBounds);
    await page.evaluate(() => (window as any).__desktopUi.grant());
    const chineseStop = page.getByRole("button", { name: "停止控制", exact: true });
    await chineseStop.waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ui-desktop-view__controls')!).transform === 'matrix(1, 0, 0, 1, 0, 0)');
    const ownedBounds = await chineseStop.boundingBox();
    assert.equal(ownedBounds!.width, chineseBounds!.width);
    assert.equal(ownedBounds!.height, chineseBounds!.height);
    assert.ok(Math.abs(ownedBounds!.y - chineseBounds!.y + 8) < 1, "confirmed ownership joins the control island to the media edge");
    await page.waitForFunction(() => !document.querySelector('.ui-desktop-view__frame')!.getAnimations({ subtree: true })
      .some(animation => animation.playState === 'running'));
    await page.screenshot({ path: join(directory, `${theme}-${width}-zh-control.png`) });
    await activate(chineseStop); await chineseTake.waitFor();
    assert.equal(await page.locator(".cloud-desktop-panel__toolbar [role=status] > span").first().textContent(), "正在观看");
    await page.evaluate(() => (window as any).__desktopUi.unavailable());
    await page.getByRole("heading", { name: "桌面暂不可用" }).waitFor();
    await page.screenshot({ path: join(directory, `${theme}-${width}-unavailable.png`) });
    await page.getByRole("heading", { name: "桌面暂不可用" }).waitFor();
    await page.screenshot({ path: join(directory, `${theme}-${width}-zh-unavailable.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    receipts.push({ theme, width, feedbackStyle, motion, frameSamples, heldStyle, counts });
    await page.evaluate(() => (window as any).__desktopUi.dispose()); await page.close();
  }
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width === 390, reducedMotion: "reduce" });
    const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?shell`);
    await page.waitForFunction(() => Boolean((window as any).__desktopUi));
    await page.evaluate(() => (window as any).__desktopUi.show());
    try { await page.locator('[data-phase="connecting"]').waitFor({ timeout: 5000 }); }
    catch { throw new Error(JSON.stringify({ width, errors, fixture: await page.locator('body').innerText() })); }
    await page.evaluate(() => {
      (window as any).__desktopUi.ready(true, false);
      (window as any).__surfaceBefore = document.querySelector(".cloud-desktop-panel__surface");
    });
    const take = page.getByRole("button", { name: "Take control", exact: true });
    try { await take.waitFor({ timeout: 5000 }); }
    catch { throw new Error(JSON.stringify({ width, errors, fixture: await page.locator('body').innerText(), geometry: await page.evaluate(() =>
      [...document.querySelectorAll('.app-shell-right-panel,.right-panel-view,.right-panel-resident,.cloud-desktop-panel,.cloud-desktop-panel__toolbar')].map(element => ({
        class: element.className, rect: element.getBoundingClientRect().toJSON(), phase: element.getAttribute('data-phase'),
        hidden: element.getAttribute('aria-hidden'), inert: element.hasAttribute('inert'), display: getComputedStyle(element).display,
      }))) })); }
    if (width === 390) await take.tap(); else await take.click();
    await page.evaluate(() => (window as any).__desktopUi.grant());
    await page.waitForFunction(() => document.querySelector('.cloud-desktop-panel')?.getAttribute('data-control') === 'controlling');
    await page.evaluate(() => (window as any).__desktopUi.hide());
    await page.waitForFunction(() => {
      const panel = document.querySelector('.cloud-desktop-panel'), shell = document.querySelector('.app-shell-right-panel');
      return panel?.getAttribute('data-control') === 'observing' && shell?.hasAttribute('inert')
        && shell.getBoundingClientRect().width < 1;
    });
    assert.deepEqual(await page.evaluate(() => {
      const counts = (window as any).__desktopUi.counts();
      return { mounts: counts.mounts, preparations: counts.preparations, releases: counts.releases,
        connectionCloses: counts.connectionCloses, attachmentReleases: counts.attachmentReleases };
    }), { mounts: 1, preparations: 1, releases: 1, connectionCloses: 0, attachmentReleases: 0 });
    await page.evaluate(() => (window as any).__desktopUi.show());
    await take.waitFor();
    await page.waitForFunction(() => {
      const shell = document.querySelector('.app-shell-right-panel'), surface = document.querySelector('.cloud-desktop-panel__surface');
      if (!shell || !surface || shell.hasAttribute('inert')) return false;
      const frame = shell.getBoundingClientRect(), media = surface.getBoundingClientRect();
      return frame.width > 100 && media.x >= 0 && media.right <= innerWidth + 1 && media.height > 100;
    });
    const bounds = await page.locator('.cloud-desktop-panel__surface').boundingBox();
    assert.ok(bounds && bounds.width > 100 && bounds.height > 100, "resident surface must fill the reopened panel");
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, "reopened media must be inside the visible viewport, not merely attached");
    assert.equal(await page.evaluate(() => (window as any).__surfaceBefore === document.querySelector('.cloud-desktop-panel__surface')), true);
    assert.equal(await take.getAttribute('aria-pressed'), 'false', "reopening must not reacquire input");
    await page.screenshot({ path: join(directory, `shell-${width}-reopened.png`) });
    await page.evaluate(() => (window as any).__desktopUi.other());
    await page.locator('[data-other-tool]').waitFor();
    assert.equal(await page.locator('.right-panel-view').evaluate(element => getComputedStyle(element).overflowY), 'auto',
      "hidden desktop cannot take ownership of another tool's scroll policy");
    assert.equal(await page.locator('.right-panel-resident').getAttribute('hidden'), '');
    assert.equal(await page.locator('.cloud-desktop-panel').getAttribute('inert'), '');
    await page.evaluate(() => (window as any).__desktopUi.hide());
    await page.waitForFunction(() => !document.querySelector('[data-other-tool]'));
    assert.equal(await page.locator('.cloud-desktop-panel').count(), 1, "desktop residency cannot keep a normal tool alive after hiding");
    await page.evaluate(() => (window as any).__desktopUi.show());
    await page.locator('[data-other-tool]').waitFor();
    await page.evaluate(() => (window as any).__desktopUi.desktop());
    await take.waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-other-tool]'));
    assert.equal(await page.evaluate(() => (window as any).__surfaceBefore === document.querySelector('.cloud-desktop-panel__surface')), true);
    const toolCounts = await page.evaluate(() => (window as any).__desktopUi.counts());
    assert.equal(toolCounts.toolMounts, 2); assert.equal(toolCounts.toolCloses, 2);
    await page.evaluate(() => (window as any).__desktopUi.close());
    await page.waitForFunction(() => !document.querySelector('.cloud-desktop-panel'));
    const counts = await page.evaluate(() => (window as any).__desktopUi.counts());
    assert.equal(counts.connectionCloses, 1); assert.equal(counts.attachmentReleases, 1);
    assert.equal(counts.toolMounts, 3); assert.equal(counts.toolCloses, 2, "closing desktop selects the remaining ordinary tool");
    assert.deepEqual(errors, []); receipts.push({ shell: true, width, bounds, counts });
    await page.evaluate(() => (window as any).__desktopUi.dispose()); await page.close();
  }
  console.log(JSON.stringify({ passed: true, directory, receipts,
    scope: "Real panel/controller/current production CSS; only backend/media boundaries synthetic. Not native-control or production authorization acceptance." }, null, 2));
} finally {
  await browser?.close(); await new Promise<void>(yes => server.close(() => yes()));
}
