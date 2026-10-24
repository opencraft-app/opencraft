import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";

// Run against an isolated Electron preview profile, never a user's saved layout.
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const cdpUrl = process.env.OPENCRAFT_CDP_URL ?? "http://127.0.0.1:19333";
const electron = process.env.OPENCRAFT_ELECTRON_EXECUTABLE ? spawn(process.env.OPENCRAFT_ELECTRON_EXECUTABLE, [
  `--user-data-dir=${process.env.OPENCRAFT_TEST_PROFILE}`, `--remote-debugging-port=${new URL(cdpUrl).port}`,
  "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling",
], { stdio: "ignore" }) : null;
if (electron) {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${cdpUrl}/json/version`)).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "isolated Electron CDP startup");
  if (process.env.OPENCRAFT_SPACE_SCREENSHOTS === "0") execFileSync("osascript", ["-e", `tell application "System Events" to set visible of (first application process whose unix id is ${electron.pid}) to false`]);
}
const browser = await chromium.connectOverCDP(cdpUrl);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(10000);
const output = process.env.OPENCRAFT_SPACE_REPORT ?? "/tmp/opencraft-shell-space";
await mkdir(output, { recursive: true });
const errors: string[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
const evidence: unknown[] = [];
const measure = () => page.evaluate(() => {
  const rect = (selector: string) => {
    const e = document.querySelector(selector);
    return e ? Math.round(e.getBoundingClientRect().width * 100) / 100 : 0;
  };
  return {
    width: innerWidth,
    detent: document.querySelector(".app-shell-root")?.getAttribute("data-sidecar-primary-detent"),
    left: rect(".app-shell-sidecar"), navigation: rect(".shell-navigation__dock"),
    context: rect(".app-shell-left-panel"), main: rect(".main-content-viewport"), right: rect(".app-shell-right-panel"),
    rightFull: document.querySelector(".main-content-viewport")?.getAttribute("data-app-shell-right-panel-full-width"),
    rightHidden: document.querySelector(".app-shell-right-panel")?.getAttribute("aria-hidden"),
    prefs: ["opencraft.shell-navigation.v2", "opencraft.shell-navigation.width.v3", "sidebar-width"].map(k => localStorage.getItem(k)),
  };
});
const settle = async () => { await page.waitForTimeout(850); };
try {
  await page.addInitScript("globalThis.__name = value => value;");
  await page.setViewportSize({ width: 1800, height: 950 });
  await page.evaluate(() => {
    localStorage.setItem("opencraft.shell-navigation.v2", JSON.stringify({ applications: true, account: false, railDetent: "expanded" }));
    localStorage.setItem("opencraft.shell-navigation.width.v3", "520");
    localStorage.setItem("sidebar-width", "275");
  });
  await page.reload();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  await page.evaluate(() => { document.title = "OpenCraft · Layout QA"; });
  await settle();
  const showTools = page.getByRole("button", { name: "Show task details", exact: true });
  if (await showTools.count()) await showTools.click();
  await settle();
  const prefs = (await measure()).prefs;
  for (const width of [1800, 1500, 1200, 1100, 1000, 700, 540, 1000, 1200, 1800]) {
    await page.setViewportSize({ width, height: 950 }); await settle();
    await page.waitForFunction(() => {
      const w = (s: string) => document.querySelector(s)?.getBoundingClientRect().width ?? 0;
      return w('.main-content-viewport') >= Math.min(innerWidth, 480) - 1
        && Math.abs(w('.app-shell-sidecar') + w('.main-content-viewport') + w('.app-shell-right-panel') - innerWidth) < 2;
    }, undefined, { polling: 100 });
    const geometry = await measure();
    assert.ok(geometry.main >= Math.min(width, 480) - 1, JSON.stringify(geometry));
    assert.ok(Math.abs(geometry.left + geometry.main + geometry.right - width) < 2, JSON.stringify(geometry));
    assert.deepEqual(geometry.prefs, prefs);
    evidence.push({ case: "resize", ...geometry });
    console.log(JSON.stringify({ case: "resize", ...geometry }));
    if (process.env.OPENCRAFT_SPACE_SCREENSHOTS !== "0") await page.screenshot({ path: `${output}/width-${width}.png` });
  }
  await page.setViewportSize({ width: 1000, height: 950 }); await settle();
  await page.getByRole("button", { name: "Applications", exact: true }).click(); await settle();
  await page.locator('.shell-navigation__drawer').waitFor();
  assert.deepEqual((await measure()).prefs, prefs);
  await page.keyboard.press("Escape"); await settle();
  evidence.push({ case: "suppressed-applications-peek-keeps-pin", passed: true });
  await page.setViewportSize({ width: 700, height: 950 }); await settle();
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click(); await settle();
  assert.equal(await page.locator('[data-testid="app-shell-floating-left-panel"]').count(), 1);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("选择登录站点", { exact: true }).waitFor();
  await page.keyboard.press("Escape"); await settle();
  await page.keyboard.press("Escape"); await settle();
  evidence.push({ case: "floating-sidebar-and-login", passed: true });
  await page.getByRole("button", { name: "Show task details", exact: true }).click(); await settle();
  assert.equal((await measure()).rightFull, "true");
  await page.getByRole("button", { name: "Back to chat", exact: true }).click(); await settle();
  assert.ok((await measure()).main >= 480);
  evidence.push({ case: "narrow-tools-reveal-restore", passed: true });
  await page.setViewportSize({ width: 1800, height: 950 }); await settle();
  await page.getByRole("button", { name: "Show task details", exact: true }).click(); await settle();
  await page.getByRole("button", { name: "Hide task details", exact: true }).click(); await settle();
  await page.setViewportSize({ width: 700, height: 950 }); await settle();
  await page.setViewportSize({ width: 1800, height: 950 }); await settle();
  assert.equal((await measure()).right, 0);
  evidence.push({ case: "manual-close-survives-resize", passed: true });
  // A held pointer must leave saved geometry untouched; release commits once.
  const handle = page.getByRole("separator", { name: "Resize applications", exact: true });
  const bounds = await handle.boundingBox();
  assert.ok(bounds);
  const storedBeforeDrag = (await measure()).prefs[1];
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 180, bounds.y + 100, { steps: 12 });
  await settle();
  assert.equal((await measure()).prefs[1], storedBeforeDrag);
  await page.mouse.up(); await settle();
  assert.ok((await measure()).navigation < 520);
  assert.ok((await measure()).main >= 480);
  evidence.push({ case: "held-drag-and-release", passed: true });
  await page.getByRole("button", { name: "Settings", exact: true }).click(); await settle();
  await page.setViewportSize({ width: 700, height: 950 }); await settle();
  assert.ok((await measure()).main >= 480);
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click(); await settle();
  assert.equal(await page.locator('[data-testid="app-shell-floating-left-panel"]').count(), 1);
  await page.keyboard.press("Escape"); await settle();
  evidence.push({ case: "settings-context-floating", passed: true });
  await page.setViewportSize({ width: 1800, height: 950 }); await settle();
  await page.getByRole("button", { name: "Chat", exact: true }).click(); await settle();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify({ evidence, errors }, null, 2));
  await browser.close();
  electron?.kill("SIGTERM");
}
