import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
const { chromium } = await import("playwright");
const artifacts = process.env.OPENCRAFT_NOTIFICATION_ARTIFACTS ?? "/tmp/opencraft-notification-design";
await mkdir(artifacts, { recursive: true });
const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-notification-destinations",
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/turn-notifications.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
});
let browser: any;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${(vite.httpServer!.address() as any).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1200, height: 860 },
      hasTouch: touch,
      isMobile: touch,
      permissions: touch ? [] : ["notifications"],
    });
    const page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript("window.__name = value => value");
    let config: any = {
      actorId: "human-a",
      enabled: true,
      hosts: ["local-codex"],
      destinations: [],
      imTargets: [
        { channelId: "slack", senderId: "UTEST", label: "Slack · 我的私聊" },
        {
          channelId: "product.connection",
          senderId: "TSELF",
          label: "我的企业微信",
          methodId: "product.wecom",
          methodLabel: "企业微信",
        },
      ],
    };
    const saved: any[] = [];
    let rejectSave = true,
      rejectTest = false;
    await context.route("**/__opencraft_notifications", async (route: any) => {
      const request = route.request();
      let result: any = config;
      if (request.method() === "POST") {
        const input = request.postDataJSON();
        if (input.operation === "save" && rejectSave) {
          rejectSave = false;
          await route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: "invalid_destination" }),
          });
          return;
        }
        if (input.operation === "test" && rejectTest) {
          rejectTest = false;
          await route.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({ error: "notification_delivery_failed" }),
          });
          return;
        }
        if (input.operation === "save") {
          saved.push(input);
          const id = input.id ?? "destination-" + saved.length;
          const selected =
            input.target.kind === "im"
              ? config.imTargets.find(
                  (value: any) =>
                    value.channelId === input.target.channelId && value.senderId === input.target.senderId,
                )
              : null;
          const destination = {
            id,
            kind: input.target.kind,
            label: selected?.label ?? "api.day.app / ••••••",
            enabled: true,
            authorized: true,
            ...(selected ?? {}),
          };
          config = { ...config, destinations: [...config.destinations.filter((d: any) => d.id !== id), destination] };
          result = { ...config, savedId: id };
        } else if (input.operation === "test") result = { sent: true };
        else if (input.operation === "master") result = config = { ...config, enabled: input.enabled };
        else if (input.operation === "enable")
          result = config = {
            ...config,
            destinations: config.destinations.map((d: any) =>
              d.id === input.id ? { ...d, enabled: input.enabled } : d,
            ),
          };
        else if (input.operation === "remove")
          result = config = { ...config, destinations: config.destinations.filter((d: any) => d.id !== input.id) };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
    });
    await page.goto(origin);
    const activate = async (locator: any) => (touch ? locator.tap() : locator.click());
    await page.getByRole("switch", { name: "回答结束时通知我", exact: true }).waitFor();
    await activate(page.getByRole("button", { name: "添加通知方式", exact: true }));
    await activate(page.getByRole("menuitem", { name: "Bark", exact: true }));
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page
      .getByLabel("推送地址", { exact: true })
      .fill("curl -X GET https://api.day.app/demo-key/title/body?group=example&ttl=600");
    await dialog.evaluate((element: HTMLElement) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
    await page.screenshot({ path: join(artifacts, touch ? "mobile-bark.png" : "desktop-bark.png"), fullPage: true });
    const geometry = await dialog.boundingBox();
    assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= (touch ? 391 : 1201));
    if (touch) assert.ok(geometry.y + geometry.height <= 845, JSON.stringify(geometry));
    await activate(page.getByRole("button", { name: "保存并测试", exact: true }));
    await page
      .getByText("地址格式不正确。请粘贴完整的 HTTPS 推送链接；Bark 也支持 GET curl 示例。", { exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("推送地址", { exact: true }).inputValue(),
      "curl -X GET https://api.day.app/demo-key/title/body?group=example&ttl=600",
    );
    assert.equal(saved.length, 0);
    assert.equal(await dialog.isVisible(), true);
    await page.screenshot({
      path: join(artifacts, touch ? "mobile-address-error.png" : "desktop-address-error.png"),
      fullPage: true,
    });
    await activate(page.getByRole("button", { name: "保存并测试", exact: true }));
    await dialog.waitFor({ state: "detached" });
    assert.equal(saved.length, 1);
    assert.match(saved[0].target.url, /ttl=600/);
    await page.getByRole("switch", { name: "启用Bark", exact: true }).waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("demo-key"));
    await activate(page.getByRole("switch", { name: "回答结束时通知我", exact: true }));
    assert.equal(await page.getByRole("switch", { name: "启用Bark", exact: true }).isDisabled(), true);
    await activate(page.getByRole("switch", { name: "回答结束时通知我", exact: true }));
    await activate(page.getByRole("button", { name: "添加通知方式", exact: true }));
    await activate(page.getByRole("menuitem", { name: "已连接的 IM", exact: true }));
    rejectTest = true;
    await activate(page.getByRole("button", { name: "通知到", exact: true }));
    await activate(page.getByRole("menuitemradio", { name: "Slack · 我的私聊", exact: true }));
    await activate(page.getByRole("button", { name: "保存并测试", exact: true }));
    await dialog.waitFor({ state: "detached" });
    assert.equal(saved[1].target.senderId, "UTEST");
    await page
      .getByText("设置已保存。未能完成测试发送。请检查推送地址或接收服务状态，再从通知方式菜单重试。", { exact: true })
      .waitFor();
    for (const close of await page.locator('[data-sonner-toast] button[aria-label="关闭"]').all()) await close.click();
    await activate(page.getByRole("button", { name: "添加通知方式", exact: true }));
    await activate(page.getByRole("menuitem", { name: "企业微信", exact: true }));
    await activate(page.getByRole("button", { name: "通知到", exact: true }));
    assert.equal(await page.getByRole("menuitemradio", { name: "Slack · 我的私聊", exact: true }).count(), 0);
    await activate(page.getByRole("menuitemradio", { name: "我的企业微信", exact: true }));
    await page.getByRole("menuitemradio", { name: "我的企业微信", exact: true }).waitFor({ state: "hidden" });
    await dialog.evaluate((element: HTMLElement) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
    await page.screenshot({ path: join(artifacts, touch ? "mobile-wecom.png" : "desktop-wecom.png"), fullPage: true });
    await activate(page.getByRole("button", { name: "保存并测试", exact: true }));
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(saved[2].target, { kind: "im", channelId: "product.connection", senderId: "TSELF" });
    await page.getByRole("switch", { name: "启用企业微信", exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, touch ? "mobile-list.png" : "desktop-list.png"), fullPage: true });
    await page.evaluate(() => (window as any).__turnNotificationFixture.theme("dark"));
    await activate(page.getByRole("button", { name: "添加通知方式", exact: true }));
    await activate(page.getByRole("menuitem", { name: "企业微信", exact: true }));
    await activate(page.getByRole("button", { name: "通知到", exact: true }));
    await activate(page.getByRole("menuitemradio", { name: "我的企业微信", exact: true }));
    await page.getByRole("menuitemradio", { name: "我的企业微信", exact: true }).waitFor({ state: "hidden" });
    await dialog.evaluate((element: HTMLElement) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
    await page.screenshot({
      path: join(artifacts, touch ? "mobile-dark-wecom.png" : "desktop-dark-wecom.png"),
      fullPage: true,
    });
    await activate(page.getByRole("button", { name: "取消", exact: true }));
    await activate(page.getByRole("button", { name: "添加通知方式", exact: true }));
    await activate(page.getByRole("menuitem", { name: "Webhook", exact: true }));
    await activate(page.getByRole("button", { name: "高级设置", exact: true }));
    await page.getByLabel("Authorization 请求头（可选）").fill("Bearer synthetic");
    await page.screenshot({
      path: join(artifacts, touch ? "mobile-dark-webhook.png" : "desktop-dark-webhook.png"),
      fullPage: true,
    });
    if (touch) {
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.timelineTracksVisualViewport = "true";
        root.style.setProperty("--timeline-available-viewport-height", "430px");
        root.style.setProperty("--timeline-available-viewport-width", "390px");
      });
      await dialog.evaluate((element: HTMLElement) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))),
      );
      const button = await page.getByRole("button", { name: "保存并测试", exact: true }).boundingBox();
      assert.ok(button.y >= 0 && button.y + button.height <= 431, JSON.stringify(button));
      const panel = await dialog.boundingBox();
      assert.ok(panel.y >= 0, JSON.stringify(panel));
      await page.screenshot({ path: join(artifacts, "mobile-keyboard-frame.png"), fullPage: true });
      await page.evaluate(() => {
        const root = document.documentElement;
        delete root.dataset.timelineTracksVisualViewport;
        root.style.removeProperty("--timeline-available-viewport-height");
        root.style.removeProperty("--timeline-available-viewport-width");
      });
    }
    await activate(page.getByRole("button", { name: "取消", exact: true }));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "PASS desktop and touch: Bark save/test, redaction, pause, IM and contributed WeCom selection, dark Webhook and overflow. Artifacts: " +
      artifacts,
  );
} finally {
  await browser?.close();
  await vite.close();
}
