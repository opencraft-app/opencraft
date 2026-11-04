import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-turn-notifications-test", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "notification-fixture", configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url?.split("?")[0] !== "/") return next();
    res.setHeader("content-type", "text/html");
    res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenCraft notification verification</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/turn-notifications.tsx"></script></body></html>');
  }); } }],
});
let browser: any;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const switchArtifacts = await mkdtemp(join(tmpdir(), "opencraft-settings-switch-"));
  await verifySettingsSwitches(browser, origin, switchArtifacts);
  console.log(`PASS Chat Settings switch geometry, touch target, keyboard, disabled and themes. Screenshots: ${switchArtifacts}`);
  if (!process.env.OPENCRAFT_SETTINGS_SWITCH_ONLY) {
  const context = await browser.newContext({ permissions: ["notifications"], viewport: { width: 1100, height: 800 } });
  const page = await context.newPage(); const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.addInitScript("window.__name = value => value");
  await page.goto(origin);
  const toggle = page.getByRole("switch", { name: "轮次结束提醒", exact: true });
  await toggle.waitFor(); assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click(); await page.waitForFunction(() => (window as any).__turnNotificationFixture.preference() === true);
  const notifications = () => page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const values = await Promise.all(registrations.map(async registration => (await registration.getNotifications()).map(notification => ({ title: notification.title, tag: notification.tag, body: notification.body, data: notification.data }))));
    return values.flat();
  });
  const waitCount = async (count: number) => { await page.waitForFunction(async expected => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const lists = await Promise.all(registrations.map(value => value.getNotifications()));
    return lists.flat().length === expected;
  }, count); };
  for (const [host, status] of [["host-a", "completed"], ["host-b", "failed"], ["host-c", "interrupted"]]) {
    await page.evaluate(host => (window as any).__turnNotificationFixture.context(host, `${host} 对话`, `我给 ${host} 的请求`), host);
    await page.evaluate(([host, status]) => (window as any).__turnNotificationFixture.emit(host, "turn-1", status), [host, status]);
  }
  await waitCount(3);
  const shown = await notifications();
  assert.deepEqual(shown.map((value: any) => value.title).sort(), ["host-a 对话 · OpenCraft · 本轮已完成", "host-b 对话 · OpenCraft · 本轮执行失败", "host-c 对话 · OpenCraft · 本轮已停止"].sort());
  assert.ok(shown.every((value: any) => value.data.clientId && value.data.ownerId && value.body === `你：我给 ${value.data.completion.hostId} 的请求`));
  await page.evaluate(async () => { const f = (window as any).__turnNotificationFixture; await f.emit("host-a", "turn-1"); await f.reconnect(); await f.emit("host-a", "turn-1"); await f.emit("host-a", "phase", "completed", "item/completed"); await f.emit("host-a", "history", "completed", "thread/read"); });
  assert.equal((await notifications()).length, 3);
  // A worker click message must target the original Application nonce and call its existing navigation port.
  await page.evaluate(data => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { kind: "opencraft-turn-click", ownerId: data.ownerId, completion: data.completion } })), shown[0].data);
  await page.waitForFunction(() => (window as any).__turnNotificationFixture.opened.length === 1);
  await page.evaluate(() => (window as any).__turnNotificationFixture.settings());
  await page.locator("[data-conversation]").waitFor();
  await page.evaluate(() => (window as any).__turnNotificationFixture.emit("host-a", "turn-2")); await waitCount(4);
  assert.ok((await notifications()).some(value => value.data.completion.turnId === "turn-2" && value.title === "#thread · OpenCraft · 本轮已完成"), "missing metadata still identifies the conversation");
  await page.evaluate(() => (window as any).__turnNotificationFixture.settings()); await toggle.waitFor();
  await toggle.click(); await page.waitForFunction(() => (window as any).__turnNotificationFixture.preference() === false);
  await page.evaluate(() => (window as any).__turnNotificationFixture.emit("host-a", "turn-3"));
  assert.equal((await notifications()).length, 4);
  await page.reload(); await toggle.waitFor(); assert.equal(await toggle.getAttribute("aria-checked"), "false");
  const workers = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(value => ({ scope: value.scope, script: value.active?.scriptURL })));
  assert.ok(workers.every(value => value.scope.includes("/turn-notifications/") && value.script?.includes("turn-notification-worker")));
  const artifacts = await mkdtemp(join(tmpdir(), "opencraft-turn-notifications-"));
  await writeFile(join(artifacts, "notification-content-evidence.json"), JSON.stringify(shown, null, 2));
  const screenshot = join(artifacts, "chat-settings.png");
  await page.screenshot({ path: screenshot });
  assert.deepEqual(errors, []);
  await context.close();
  const denied = await browser.newContext(); const deniedPage = await denied.newPage();
  await deniedPage.goto(origin); const deniedToggle = deniedPage.getByRole("switch", { name: "轮次结束提醒", exact: true });
  await deniedToggle.waitFor(); await deniedToggle.click();
  await deniedPage.getByText("尚未获得通知权限，你可以稍后重新开启。").waitFor();
  assert.equal(await deniedPage.evaluate(() => (window as any).__turnNotificationFixture.preference()), false);
  await denied.close();
  assert.deepEqual(errors, []);
  console.log(`PASS real Chat Settings/Intl/IndexedDB/typed Clients/Notification Worker: conversation title and corresponding user request, explicit opt-in, three independent Host clients, terminal states, dedup/reconnect, history suppression, Settings/View switching, disable/persistence, denied permission, click navigation port. OS popup clicking is simulated. Screenshot: ${screenshot}`);
  }
} finally { await browser?.close(); await vite.close(); }

async function verifySettingsSwitches(browser: any, origin: string, artifacts: string) {
  const geometryErrors: string[] = [];
  // Exercise the actual Chat Settings with touch capability, including an
  // unsupported notification switch, rather than only resizing a pointer page.
  for (const touch of [false, true]) {
    const geometryContext = await browser.newContext({ hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    await geometryContext.addInitScript(() => { delete (window as any).Notification; });
    const geometryPage = await geometryContext.newPage();
    geometryPage.on("pageerror", (error: Error) => geometryErrors.push(error.message));
    await geometryPage.addInitScript("window.__name = value => value");
    await geometryPage.goto(origin);
    const followUp = geometryPage.getByRole("switch", { name: "回复时立即跟进", exact: true });
    await followUp.waitFor();
    for (const width of [320, 390, 820, 1280]) for (const theme of ["light", "dark"]) {
      await geometryPage.setViewportSize({ width, height: 900 });
      await geometryPage.evaluate(mode => (window as any).__turnNotificationFixture.theme(mode), theme);
      if (process.env.OPENCRAFT_SETTINGS_SWITCH_NEGATIVE_CONTROL) await geometryPage.addStyleTag({
        content: '.settings-control-switch::before { width: 48px; height: 44px; }',
      });
      for (const checked of [false, true]) {
        if (await followUp.getAttribute("aria-checked") !== String(checked)) {
          await followUp.focus(); await geometryPage.keyboard.press("Space");
          await geometryPage.waitForFunction(value => document.querySelector('[aria-label="回复时立即跟进"]')?.getAttribute("aria-checked") === String(value), checked);
        }
        const geometry = await geometryPage.locator('[role="switch"]').evaluateAll(elements => elements.map(element => {
          const hit = element.getBoundingClientRect(), track = getComputedStyle(element, "::before");
          const thumb = element.querySelector("span")!.getBoundingClientRect();
          return { hit: { width: hit.width, height: hit.height }, track: { width: parseFloat(track.width), height: parseFloat(track.height) },
            thumb: { width: thumb.width, height: thumb.height, x: thumb.x - hit.x, y: thumb.y - hit.y },
            checked: element.getAttribute("aria-checked") === "true", background: getComputedStyle(element).backgroundColor };
        }));
        for (const value of geometry) {
          assert.deepEqual(value.track, { width: 36, height: 20 }, "track stays elongated in every density");
          assert.equal(value.background, "rgba(0, 0, 0, 0)", "the hit area has no painted background");
          assert.equal(value.thumb.width, 16); assert.equal(value.thumb.height, 16);
          assert.equal(value.thumb.y, (value.hit.height - value.thumb.height) / 2, "thumb stays vertically centered");
          assert.equal(value.thumb.x, (value.hit.width - value.track.width) / 2 + 2 + (value.checked ? 16 : 0), "thumb stays inset at both endpoints");
          if (touch) assert.ok(value.hit.width >= 44 && value.hit.height >= 44, "touch target remains accessible");
        }
      }
      await geometryPage.waitForFunction(() => !document.querySelector('[aria-label="回复时立即跟进"]')?.hasAttribute("disabled"));
      await followUp.scrollIntoViewIfNeeded();
      const before = await followUp.getAttribute("aria-checked"), box = await followUp.boundingBox();
      // This point is outside the painted track in touch density.
      if (touch) await geometryPage.touchscreen.tap(box!.x + box!.width / 2, box!.y + 2);
      else await followUp.click();
      await geometryPage.waitForFunction(value => document.querySelector('[aria-label="回复时立即跟进"]')?.getAttribute("aria-checked") !== value, before);
      const disabledSwitch = geometryPage.getByRole("switch", { name: "轮次结束提醒", exact: true });
      assert.equal(await disabledSwitch.isDisabled(), true);
      assert.equal(await disabledSwitch.getAttribute("aria-checked"), "false");
      if (width === 390) await geometryPage.screenshot({ path: join(artifacts, `switch-${touch ? "touch" : "pointer"}-${theme}.png`) });
    }
    await geometryContext.close();
  }
  assert.deepEqual(geometryErrors, []);
}
