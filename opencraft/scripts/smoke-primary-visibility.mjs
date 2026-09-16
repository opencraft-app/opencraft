import assert from "node:assert/strict";

// Connect only to a developer-launched preview; never discover another browser.
const playwrightModule = process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright";
const { chromium } = await import(playwrightModule);
const browser = await chromium.connectOverCDP(process.env.OPENCRAFT_CDP_URL ?? "http://127.0.0.1:19555");
const reduced = process.env.OPENCRAFT_REDUCED_MOTION === "1";
const page = browser.contexts()[0].pages()[0];
const entryUrl = new URL("/", page.url()).href;
try {
  if (reduced) {
    await page.emulateMedia({reducedMotion: "reduce"});
    await page.goto(entryUrl);
  }
  await page.bringToFront();
  const button = page.locator('.shell-navigation__entrance[data-surface="applications"]');
  const initiallyOpen = await button.getAttribute("aria-pressed") === "true";
  if (!initiallyOpen) await button.click();
  await page.waitForFunction(() => {
    const handle = document.querySelector('[aria-label="Resize applications"]');
    const width = document.querySelector(".shell-navigation__dock")?.getBoundingClientRect().width ?? 0;
    return handle && Math.abs(width - Number(handle.getAttribute("aria-valuenow"))) < 0.1;
  });
  // The resize owner's commit completes at spring end, not at a rounded DOM
  // width. Finish any caller-initiated resize before testing visibility alone.
  await page.waitForTimeout(600);
  const records = await page.evaluate(async () => {
    const button = document.querySelector('.shell-navigation__entrance[data-surface="applications"]');
    const read = () => {
      const pane = document.querySelector(".shell-navigation__dock");
      return {
        width: pane?.getBoundingClientRect().width ?? 0,
        mounted: pane !== null,
        inert: pane?.inert ?? true,
        footerX: button.getBoundingClientRect().x,
      };
    };
    const sample = (reverse = false) => new Promise(resolve => {
      const frames = [read()];
      const start = performance.now();
      let reversed = false;
      button.click();
      const tick = () => {
        frames.push(read());
        const elapsed = performance.now() - start;
        if (reverse && !reversed && elapsed >= 80) { button.click(); reversed = true; }
        if (elapsed < 850) requestAnimationFrame(tick);
        else resolve(frames);
      };
      requestAnimationFrame(tick);
    });
    const closing = await sample();
    const opening = await sample();
    const reversal = await sample(true);
    return {closing, opening, reversal};
  });
  console.log(JSON.stringify(records));
  const width = records.closing[0].width;
  for (const [name, frames] of Object.entries(records)) {
    const intermediate = frames.filter(f => f.width > 1 && f.width < width - 1).length;
    if (reduced) assert.equal(intermediate, 0, `${name}: reduced motion must land directly`);
    else assert.ok(intermediate >= 3, `${name}: no continuous intermediate frames`);
    assert.ok(frames.every(f => Math.abs(f.footerX - frames[0].footerX) < 0.5), `${name}: footer moved`);
  }
  assert.equal(records.closing.at(-1).mounted, false, "exit unmounts only at zero");
  if (!reduced) assert.ok(records.closing.some(f => f.width > 1 && f.width < width - 1 && f.mounted && f.inert), "exiting content stays painted but inert");
  assert.ok(Math.abs(records.opening.at(-1).width - width) < 0.2);
  assert.ok(Math.abs(records.reversal.at(-1).width - width) < 0.2);
  if (!reduced) assert.ok(records.reversal.every(f => f.mounted), "reversal remounted content");
  if (!initiallyOpen) await button.click();
} finally {
  if (reduced) {
    await page.emulateMedia({reducedMotion: null});
    await page.goto(entryUrl);
  }
  await browser.close();
}
