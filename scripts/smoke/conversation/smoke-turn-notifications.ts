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
    res.end('<html><head><title>OpenCraft notification verification</title></head><body><div id="root"></div><script type="module" src="/tests/fixtures/turn-notifications.tsx"></script></body></html>');
  }); } }],
});
let browser: any;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
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
  console.log(`PASS real Chat Settings/Intl/IndexedDB/typed Clients/Notification Worker: conversation title and corresponding user request, explicit opt-in, three independent Host clients, terminal states, dedup/reconnect, history suppression, Settings/View switching, disable/persistence, denied permission, click navigation port. OS popup clicking is simulated. Screenshot: ${screenshot}`);
} finally { await browser?.close(); await vite.close(); }
