import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { AppHostServer } from "@opencraft/app-host-server";
import { CodexEngineAdapter } from "../../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { SshCodexTransport } from "../../../apps/opencraft-daemon/src/ssh-codex-transport.js";
import { SshManagement } from "../../../apps/opencraft-daemon/src/ssh-management.js";
import { createWorkbenchWebServer } from "../../serve-workbench-web.mjs";
import { assertHeadlessWebRelease } from "../../headless-web-release.mjs";

const webRoot = process.env.OPENCRAFT_SSH_UI_WEB_ROOT;
const publicAccess = process.env.OPENCRAFT_SSH_UI_PUBLIC_ACCESS === "true";
const sharedAccess = process.env.OPENCRAFT_SSH_UI_SHARED_ACCESS === "true";
const colorScheme = process.env.OPENCRAFT_SSH_UI_COLOR_SCHEME ?? "light";
assert.ok(colorScheme === "light" || colorScheme === "dark");
assert.ok(webRoot, "Provide an isolated headless Web build");
await assertHeadlessWebRelease(resolve(webRoot));
const directory = await mkdtemp(join(tmpdir(), "opencraft-ssh-management-smoke-"));
const key = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), randomBytes(32)]).toString("base64");
const hostKey = `fixture.invalid ssh-ed25519 ${key}`;
const calls: Array<{ hostId: string; method: string; params: any }> = [];
let management: SshManagement;
const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport(hostId) {
  if (hostId.startsWith("ssh:")) management.store.binding(hostId); // Enforce real saved enablement/trust/credential boundary.
  return new CodexEngineAdapter({ kind: "remote", logDiagnostic: () => undefined,
    transport: new SshCodexTransport({ hostname: "fixture.invalid", port: 22, username: "fixture", knownHostsFile: "/synthetic/known_hosts", authentication: { kind: "agent" },
      spawnSsh: (args, env) => {
        const child = spawn(process.execPath, [new URL("../../../tests/fixtures/fake-codex-ssh-proxy.mjs", import.meta.url).pathname, args.at(-1)!], { stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...env, FIXTURE_WORKBENCH_UI: "1", ...(!hostId.startsWith("ssh:") ? { FIXTURE_WORKBENCH_UI_EMPTY_HISTORY: "1" } : {}) } });
        child.on("message", (frame: any) => calls.push({ hostId, method: frame.method, params: frame.params })); return child;
      },
    }) });
} });
management = new SshManagement({ directory, publicAccess, accessMode: sharedAccess ? "shared" : "access-key", scanHostKey: async () => hostKey, resetConnection: id => appHost.resetHost(id), connectConnection: (id, assertAdmission) => appHost.ensureHostConnected(id, assertAdmission), connectionState: id => appHost.hostState(id) });
const second = management.store.save(null, 0, { displayName: "Second fixture", hostname: "fixture.invalid", port: 22, username: "fixture", enabled: false, workspaceBrowseRoots: ["/remote"], password: "synthetic" }, hostKey);
const web = await createWorkbenchWebServer({ root: resolve(webRoot), appServerTarget: null, appHostServer: appHost, loopbackOnly: !publicAccess, sshManagement: management, onAppHostDiagnostic: () => undefined });
let browser: any;
let activePage: any;
try {
  const address = await web.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${address.port}`;
  const access = sharedAccess ? null : await readFile(join(directory, "access.key"), "utf8");
  const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const errors: string[] = [];
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: touch, hasTouch: touch, locale: "en-US", colorScheme });
    await context.addInitScript((preference: string) => localStorage.setItem("opencraft.appearance-theme", preference), colorScheme);
    await context.route("**/*", (route: any) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); activePage = page;
    const showSidebar = async () => {
      // A touch drawer has its own transient header. Only the persistent
      // Shell control owns opening it; an already-open drawer needs no toggle.
      if (await page.locator(".sidebar-tasks").isVisible()) return;
      const show = page.getByRole("button", { name: "Show sidebar", exact: true })
        .and(page.locator('[data-chrome-action-host-role="persistent"]'));
      if (await show.isVisible()) await show.click();
    };
    const openChat = async () => {
      const applications = page.getByRole("navigation", { name: "Applications", exact: true });
      if (!await applications.isVisible()) await showSidebar();
      await applications.getByRole("button", { name: "Home", exact: true }).click();
      await showSidebar();
    };
    page.on("pageerror", (error: Error) => errors.push(error.message));
    // An existing bookmark is canonicalized by the actual Shell/Router.
    await page.goto(`${origin}/settings/opencraft.server-connections.ssh`);
    if (!sharedAccess) {
      await page.getByLabel("访问密钥", { exact: true }).waitFor({ timeout: 30000 });
      await page.getByLabel("访问密钥", { exact: true }).fill(access!);
      await page.getByRole("button", { name: "解锁", exact: true }).click();
    }
    await page.getByRole("button", { name: "添加", exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, "/settings/opencraft.server-connections.ssh");
    if (sharedAccess) {
      assert.equal(await page.getByLabel("访问密钥", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "锁定管理", exact: true }).count(), 0);
      await page.route("**/__opencraft_ssh/session", (route: any) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
      await context.clearCookies(); await page.reload();
      await page.getByText("无法刷新连接，请稍后重试。", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("访问密钥", { exact: true }).count(), 0, "shared renewal failure is retryable, not a key challenge");
      await page.unroute("**/__opencraft_ssh/session");
      await page.getByRole("button", { name: "重试", exact: true }).click();
      await page.getByRole("button", { name: "添加", exact: true }).waitFor();
      assert.equal(await page.getByLabel("访问密钥", { exact: true }).count(), 0);
    }
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), colorScheme);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加远程连接", exact: true });
    await dialog.getByRole("textbox", { name: "名称", exact: true }).fill(touch ? "Touch fixture" : "Desktop fixture");
    const name = touch ? "Touch fixture" : "Desktop fixture";
    await dialog.getByRole("textbox", { name: "地址", exact: true }).fill("fixture.invalid");
    await dialog.getByRole("textbox", { name: "用户名", exact: true }).fill("fixture");
    await dialog.getByLabel("密码", { exact: true }).fill("synthetic-no-real-credential");
    await dialog.getByRole("textbox", { name: "工作目录", exact: true }).fill("/remote");
    assert.equal(await dialog.getByRole("button", { name: "保存", exact: true }).isEnabled(), false);
    await dialog.getByRole("button", { name: "核对身份", exact: true }).click();
    await dialog.getByRole("switch", { name: "信任此服务器", exact: true }).click();
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: `连接操作：${name}`, exact: true }).waitFor();
    const serverId = management.store.list().find(row => row.displayName === name)!.serverId;
    assert.equal(calls.some(call => call.hostId === serverId && call.method === "thread/list"), false,
      "Saving/enabling a remote recipe must not dial it to discover history");
    await page.reload();
    await page.getByRole("button", { name: `连接操作：${name}`, exact: true }).waitFor({ timeout: 30000 });
    const menu = page.getByRole("button", { name: `连接操作：${name}`, exact: true });
    const activate = async (target: any) => touch ? target.tap() : target.click();
    for (const action of ["删除", "设置", "删除"]) {
      await activate(menu);
      await activate(page.getByRole("menuitem", { name: action, exact: true }));
      const cancelled = page.getByRole("dialog", { name: action === "删除" ? "删除连接" : "连接设置", exact: true });
      await cancelled.waitFor();
      await activate(cancelled.getByRole("button", { name: "取消", exact: true }));
      await cancelled.waitFor({ state: "hidden" });
      await page.waitForFunction(() => getComputedStyle(document.body).pointerEvents !== "none", null, { timeout: 3000 });
      await page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, `连接操作：${name}`, { timeout: 3000 });
      assert.equal(management.store.get(serverId).displayName, name, "Cancelled dialogs keep the saved recipe");
    }
    await menu.click(); assert.equal(await page.getByRole("menu").count(), 1);
    await page.getByRole("menu").evaluate(async (surface: Element) => {
      await Promise.all(surface.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
    });
    const geometry = await page.getByRole("menuitem").evaluateAll((items: Element[]) => items.map(item => {
      const icon = item.querySelector("svg")!.getBoundingClientRect();
      const label = item.querySelector("span");
      const range = document.createRange();
      if (label) range.selectNodeContents(label);
      else range.selectNode(item.lastChild!);
      const text = range.getBoundingClientRect();
      const style = getComputedStyle(item);
      return { display: style.display, gap: parseFloat(style.gap), iconWidth: icon.width,
        centerDifference: Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2),
        textAfterIcon: text.x >= icon.right + 5, height: item.getBoundingClientRect().height };
    }));
    for (const item of geometry) {
      assert.equal(item.display, "flex", "SSH menu must use shared menu item geometry, not a Radix internal attribute");
      assert.ok(item.gap >= 6 && item.textAfterIcon);
      assert.ok(Math.abs(item.iconWidth - 14) < 0.1, "menu icons must use the shared 14px scale");
      assert.ok(item.centerDifference <= 2, "menu icon and label must share their vertical center");
      if (touch) assert.ok(item.height >= 44);
    }
    await page.getByRole("menuitem", { name: "连接", exact: true }).click();
    await page.waitForFunction(name => [...document.querySelectorAll('.settings-control-list-item')].find(row => row.textContent?.includes(String(name)))?.querySelector('.ssh-connections__status')?.getAttribute('data-state') === 'open', name);
    assert.equal(appHost.hostState(management.store.list().find(row => row.displayName === name)!.serverId), "open");
    // No target selection, Thread resume, or page navigation is needed to
    // discover history after explicit Connect. Settings and Chat share the
    // same Application-owned catalog readiness, not a menu-local callback.
    const readDeadline = Date.now() + 30_000;
    while (!calls.some(call => call.hostId === serverId && call.method === "thread/list") && Date.now() < readDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(calls.some(call => call.hostId === serverId && call.method === "thread/list"));
    assert.ok(calls.filter(call => call.hostId === serverId && call.method === "thread/list").every(call => call.params.useStateDbOnly === true),
      "Actual Workbench SSH catalog reads must use the native index, not scan rollouts");
    assert.equal(calls.some(call => call.hostId === serverId && call.method === "thread/resume"), false);
    // Settings has its own navigation sidebar. Return through the actual
    // Home command to inspect the history list without changing chat target.
    await openChat();
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-tasks')].some(sidebar => sidebar.textContent?.includes("Remote history fixture")));
    assert.doesNotMatch(await page.getByRole("button", { name: "Work in", exact: true }).innerText(), new RegExp(name));
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) {
      await page.screenshot({ path: join(process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR, `ssh-catalog-${touch ? "touch" : "desktop"}-${colorScheme}.png`) });
    }
    await page.reload();
    await page.getByRole("button", { name: "Work in", exact: true }).waitFor();
    await showSidebar();
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-tasks')].some(sidebar => sidebar.textContent?.includes("Remote history fixture")));
    // Reload directly into Chat with an authorized physical connection, but
    // fail startup management reads. No Settings View is mounted to poll.
    let unavailable = true, discoveryReads = 0, explicitConnects = 0;
    const countConnect = (request: any) => {
      if (request.method() === "POST" && /\/(connect|reconnect)$/.test(new URL(request.url()).pathname)) explicitConnects++;
    };
    page.on("request", countConnect);
    await page.route("**/__opencraft_ssh/connections", (route: any) => {
      discoveryReads++;
      return unavailable ? route.abort("failed") : route.continue();
    });
    for (const recovery of ["automatic", "retry", "online"] as const) {
      unavailable = true;
      await page.reload();
      await page.getByRole("button", { name: "Work in", exact: true }).waitFor();
      await showSidebar();
      await page.getByText("Couldn't load remote connections", { exact: true }).waitFor();
      if (recovery === "automatic" && process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) {
        await page.screenshot({ path: join(process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR, `ssh-discovery-error-${touch ? "touch" : "desktop"}-${colorScheme}.png`) });
      }
      const readsBefore = discoveryReads;
      assert.ok(!new URL(page.url()).pathname.startsWith('/settings'), 'Settings cannot own recovery');
      unavailable = false;
      if (recovery === "retry") await page.getByRole("button", { name: "Retry", exact: true }).click();
      if (recovery === "online") await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-tasks')].some(sidebar => sidebar.textContent?.includes("Remote history fixture")), null, { timeout: 20000 });
      assert.ok(discoveryReads > readsBefore);
      assert.equal(await page.getByText("Couldn't load remote connections", { exact: true }).count(), 0);
      assert.doesNotMatch(await page.getByRole("button", { name: "Work in", exact: true }).innerText(), new RegExp(name));
      assert.equal(explicitConnects, 0, 'Read recovery must not silently connect or reconnect');
    }
    await page.unroute("**/__opencraft_ssh/connections");
    page.off("request", countConnect);
    await page.goto(`${origin}/settings/opencraft.server-connections.ssh`);
    await menu.waitFor({ timeout: 30000 });
    await menu.click();
    await page.getByRole("menuitem", { name: "重新连接", exact: true }).click();
    await page.waitForFunction(name => [...document.querySelectorAll('.settings-control-list-item')].find(row => row.textContent?.includes(String(name)))?.querySelector('.ssh-connections__status')?.getAttribute('data-state') === 'open', name);
    await menu.click();
    await page.keyboard.press("Escape");
    await menu.focus(); await page.keyboard.press("ArrowDown");
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await menu.evaluate((trigger: Element) => trigger === document.activeElement), true);
    await page.getByRole("button", { name: "连接操作：Second fixture", exact: true }).click();
    assert.equal(await page.getByRole("menu").count(), 1);
    await page.keyboard.press("Escape");
    await menu.click(); await page.getByRole("menuitem", { name: "设置", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "连接设置", exact: true }); await editor.waitFor();
    assert.equal(await page.getByRole("menu").count(), 0);
    assert.equal(await editor.getByLabel("密码", { exact: true }).inputValue(), "");
    assert.equal(await editor.getByRole("textbox", { name: "地址", exact: true }).isEnabled(), false);
    const box = await editor.boundingBox(); const width = touch ? 390 : 1280;
    assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= (touch ? 844 : 900));
    await editor.getByRole("textbox", { name: "名称", exact: true }).fill(`${name} renamed`);
    await editor.getByRole("button", { name: "保存", exact: true }).click(); await editor.waitFor({ state: "hidden" });
    await page.getByRole("switch", { name: `启用连接：${name} renamed`, exact: true }).click();
    await page.waitForFunction(name => document.querySelector(`[aria-label="启用连接：${name} renamed"]`)?.getAttribute("aria-checked") === "false", name);
    await page.getByRole("switch", { name: `启用连接：${name} renamed`, exact: true }).click();
    await page.waitForFunction(name => document.querySelector(`[aria-label="启用连接：${name} renamed"]`)?.getAttribute("aria-checked") === "true", name);
    const tracks = await page.locator('.ssh-connections [role="switch"]').evaluateAll((buttons: Element[]) => buttons.map(button => ({ enabled: button.getAttribute("aria-checked") === "true", background: getComputedStyle(button).backgroundColor })));
    assert.notEqual(tracks.find(track => track.enabled)?.background, "rgba(0, 0, 0, 0)");
    assert.notEqual(tracks.find(track => track.enabled)?.background, tracks.find(track => !track.enabled)?.background);
    if (process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR) {
      await page.getByRole("button", { name: `连接操作：${name} renamed`, exact: true }).click();
      await page.screenshot({ path: join(process.env.OPENCRAFT_SSH_UI_ARTIFACT_DIR, `ssh-management-${touch ? "touch" : "desktop"}-${colorScheme}.png`) });
      await page.keyboard.press("Escape");
    }
    // Actual destination selector sees the live backend profile, no page reload.
    await page.goto(origin);
    const target = page.getByRole("button", { name: "Work in", exact: true }); await target.click();
    await page.locator(".new-thread-host-menu").getByRole("menuitem").filter({ hasText: `${name} renamed` }).click();
    await page.waitForFunction(name => document.querySelector('[aria-label="Work in"]')?.textContent?.includes(`${name} renamed`) && document.querySelector('[aria-label="Work in"] .workbench-connection-status')?.getAttribute("data-phase") === "ready", name, { timeout: 30000 });
    assert.match(await target.innerText(), new RegExp(name));
    await page.goto(`${origin}/settings/opencraft.server-connections.ssh`);
    const renamed = page.getByRole("button", { name: `连接操作：${name} renamed`, exact: true }); await renamed.waitFor({ timeout: 30000 });
    await renamed.click(); await page.getByRole("menuitem", { name: "重新连接", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ssh-connections [role="menu"]') === null);
    await renamed.click(); await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "删除连接", exact: true }); await remove.getByRole("button", { name: "删除", exact: true }).click();
    await remove.waitFor({ state: "hidden" }); await renamed.waitFor({ state: "hidden" });
    if (sharedAccess) {
      await context.clearCookies(); await page.reload();
      await page.getByRole("button", { name: "添加", exact: true }).waitFor();
    } else {
      await page.getByRole("button", { name: "锁定管理", exact: true }).click();
      await page.getByLabel("访问密钥", { exact: true }).waitFor();
    }
    await openChat();
    await page.locator('.sidebar-tasks').waitFor({ state: "attached" });
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar-tasks')].every(sidebar => !sidebar.textContent?.includes("Remote history fixture")));
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(calls.some(call => ["turn/start", "turn/steer", "thread/start", "fs/writeFile"].includes(call.method)), false);
  assert.equal(management.store.list().length, 1); assert.equal(management.store.get(second.serverId).displayName, "Second fixture");
  console.log(JSON.stringify({ ok: true, fullWorkbench: true, desktop: true, touch: true, colorScheme, publicAccess, sharedAccess, databaseCrud: true, explicitTrust: true, remoteCatalogWithoutSelection: true, catalogReloadAndRevocation: true, discoveryRecoveryWithoutSettings: ["automatic", "retry", "online"], recoveryDoesNotDial: true, liveTargetSelection: true, menuToDialog: true, writeOnlyCredential: true, remoteWrites: false }));
} catch (error) {
  console.error("Synthetic SSH management UI failure", await activePage?.locator("body").innerText().catch(() => "unavailable"));
  throw error;
} finally { await browser?.close(); await web.close(); await appHost.close(); management.close(); }
