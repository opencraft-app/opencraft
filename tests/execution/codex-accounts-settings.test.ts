import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CodexAccountView } from "../../packages/appserver-protocol/src/codex-accounts.js";

import type { HostProtocolRequest } from "../../plugins/builtin-agents/src/local-agent-settings-service.js";
import { CodexAccountsService } from "../../plugins/builtin-agents/src/codex-accounts/service.js";
import { CodexDeviceLoginContent, createCodexAccountsView } from "../../plugins/builtin-agents/src/codex-accounts/view.js";

// Use the same Dialog instance as the plugin content under test.
const pluginRequire = createRequire(new URL("../../plugins/builtin-agents/package.json", import.meta.url));
const dialogRoot = resolve(dirname(pluginRequire.resolve("@radix-ui/react-dialog")), "..");
const dialogManifest = JSON.parse(readFileSync(resolve(dialogRoot, "package.json"), "utf8"));
const Dialog: typeof import("@radix-ui/react-dialog") = await import(pathToFileURL(resolve(dialogRoot, dialogManifest.module)).href);

test("Codex reset credits render authoritative totals, zero, and unknown for old Hosts", async () => {
  Object.assign(globalThis, { React });
  for (const count of [undefined, null, 0, 2]) {
    const account: CodexAccountView = {
      id: "a", label: "person@example.test", priority: 1, enabled: true, credentialConfigured: true,
      email: null, subscriptionType: "pro", rateLimitTier: null, status: "ready", observedAt: null,
      heldUntil: null, lastUsedAt: null, lastUsedHostId: null, limitWindows: [],
      ...(count === undefined ? {} : { resetCredits: count === null ? null : { availableCount: count, observedAt: 1_000 } }),
    };
    const service = new CodexAccountsService((async () => ({ accounts: [account] })) as HostProtocolRequest, "local-codex");
    try {
      await service.refresh();
      const View = createCodexAccountsView(service);
      const markup = renderToStaticMarkup(createElement(View, {} as any));
      assert.match(markup, /<small>重置券<\/small>/);
      if (count == null) {
        assert.match(markup, /<small>重置券<\/small><strong>—<\/strong>/);
        assert.match(markup, /服务端尚未报告重置券数量/);
        assert.doesNotMatch(markup, /<strong>0 张<\/strong>/);
      } else {
        assert.ok(markup.includes(`<small>重置券</small><strong>${count} 张</strong>`));
        assert.match(markup, /查看数量不会使用重置券/);
      }
    } finally { service.dispose(); }
  }
});

test("Codex account row shares touch-safe hover and a reachable actions target", () => {
  const styles = readFileSync(new URL("../../apps/workbench-web/src/styles/engine-accounts.scss", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../packages/extension-react/src/settings-panel.tsx", import.meta.url), "utf8");
  const button = readFileSync(new URL("../../packages/design-system-web/src/button.web.scss", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("../../packages/design-system/src/tokens.web.scss", import.meta.url), "utf8");
  const interaction = readFileSync(new URL("../../packages/design-system/src/interaction-mixins.web.scss", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../../packages/design-system/src/controls.web.scss", import.meta.url), "utf8");
  const menu = readFileSync(new URL("../../packages/design-system/src/menu.web.scss", import.meta.url), "utf8");
  assert.match(styles, /\.engine-account__row\s*\{[\s\S]*?@include controls\.hover-capable/u);
  assert.doesNotMatch(styles, /&:hover,\s*&:focus-within\s*\{\s*background/u);
  assert.match(styles, /:root\[data-touch-interaction\] \.settings-icon-button\.engine-account__menu-trigger\s*\{\s*opacity: 1;/u);
  assert.match(settings, /return <IconButton/u);
  assert.match(button, /height: var\(--size-chrome-action\)/u);
  assert.match(tokens, /@mixin touch-density-tokens\s*\{[\s\S]*?--size-chrome-action: var\(--size-shell-header-action-mobile\)/u);
  assert.match(interaction, /@mixin hover-capable\s*\{\s*@media \(any-hover: hover\) and \(any-pointer: fine\)[\s\S]*?:root:not\(\[data-touch-interaction\]\) &/u);
  assert.match(menu, /@include controls\.hover-capable/u);
  assert.match(menu, /@include controls\.density-target\(0px, 28px\)/u);
  assert.match(controls, /min-height: max\(#\{\$height\}, var\(--size-control-hit-min\)\)/u);
});

test("Codex account Settings renders only redacted account state and device code", async () => {
  Object.assign(globalThis, { React });
  const calls: string[] = [];
  const account = {
    id: "account-a", label: "user@example.com", priority: 1, enabled: true, credentialConfigured: true,
    email: "user@example.com", subscriptionType: "pro", rateLimitTier: null, status: "ready" as const,
    observedAt: 1_000, heldUntil: null, lastUsedAt: null, lastUsedHostId: null,
    limitWindows: [
      { slot: "primary" as const, windowMinutes: 300, utilization: 0.25, resetAt: Date.UTC(2026, 8, 26, 10), observedAt: 1_000 },
      { slot: "secondary" as const, windowMinutes: 10_080, utilization: 0.5, resetAt: null, observedAt: 1_000 },
    ],
  };
  let poll = 0;
  const request = (async (_hostId: string, method: string) => {
    calls.push(method);
    if (method === "opencraft/codex/accounts/list") return { accounts: [account] };
    if (method === "opencraft/codex/accounts/deviceLogin/start") return {
      sessionId: "login-1", verificationUrl: "https://auth.openai.test/codex/device", userCode: "ABCD-1234", expiresAt: Date.now() + 60_000,
    };
    if (method === "opencraft/codex/accounts/deviceLogin/poll") return ++poll === 1 ? { status: "pending" } : { status: "complete", account };
    return { accounts: [account] };
  }) as HostProtocolRequest;
  const service = new CodexAccountsService(request, "local-codex");
  await service.refresh();
  const View = createCodexAccountsView(service);
  const render = () => renderToStaticMarkup(createElement(View, {} as any));
  assert.match(render(), /u\*\*\*er@e\*\*\*\.com/);
  assert.doesNotMatch(render(), /user@example\.com/);
  assert.match(render(), /engine-account__plan[^>]*>Pro/);
  assert.match(render(), /engine-account__status-copy[^>]*>可用/);
  assert.match(render(), /<small>5H<\/small><strong>25%<\/strong><time[^>]*dateTime="2026-09-26T10:00:00\.000Z"[^>]*>/);
  assert.match(render(), /<small>7D<\/small><strong>50%<\/strong><span class="engine-account__reset">重置未知<\/span>/);
  assert.match(render(), /添加账户/);
  assert.equal([...render().matchAll(/>添加账户</gu)].length, 1);
  assert.doesNotMatch(render(), /settings-control-row/);
  assert.doesNotMatch(render(), /accessToken|refreshToken|Bearer|sk-/);
  await service.startDeviceLogin();
  const login = service.getSnapshot().login;
  assert.ok(login);
  const loginMarkup = renderToStaticMarkup(createElement(Dialog.Root, { open: true }, createElement(CodexDeviceLoginContent, {
    login,
    canceling: false,
    onCancel: () => undefined,
  })));
  assert.match(loginMarkup, /ABCD-1234/);
  assert.match(loginMarkup, /打开验证页面/);
  assert.match(loginMarkup, /正在等待浏览器授权/);
  assert.equal((await service.pollDeviceLogin()).status, "pending");
  assert.equal((await service.pollDeviceLogin()).status, "complete");
  assert.equal(service.getSnapshot().login, null);
  assert.ok(calls.includes("opencraft/codex/accounts/list"));
  service.dispose();
});

test("Codex account read failure does not claim no accounts and can be retried", async () => {
  Object.assign(globalThis, { React });
  let fail = true;
  const service = new CodexAccountsService((async () => {
    if (fail) throw new Error("Host connection failed");
    return { accounts: [] };
  }) as HostProtocolRequest, "local-codex");
  const View = createCodexAccountsView(service);
  const render = () => renderToStaticMarkup(createElement(View, {} as any));
  try {
    await service.refresh();
    assert.match(render(), /账户读取失败/);
    assert.match(render(), /Host connection failed/);
    assert.match(render(), /刷新账户/);
    assert.doesNotMatch(render(), /还没有 Codex 账户|添加账户/);
    fail = false;
    await service.refresh();
    assert.match(render(), /还没有 Codex 账户/);
    assert.doesNotMatch(render(), /账户读取失败|Host connection failed/);
  } finally {
    service.dispose();
  }
});


test("returning or reloading reads server-owned accounts without retaining a device code", async () => {
  const account: CodexAccountView = { id: "recovered", label: "Recovered", priority: 1, enabled: true,
    credentialConfigured: true, email: null, subscriptionType: null, rateLimitTier: null, status: "ready",
    observedAt: null, heldUntil: null, lastUsedAt: null, lastUsedHostId: null, limitWindows: [] };
  let accounts: CodexAccountView[] = [];
  const request = (async () => ({ accounts })) as HostProtocolRequest;
  const oldPage = new CodexAccountsService(request, "local-codex");
  await oldPage.resume();
  assert.equal(oldPage.getSnapshot().accounts.length, 0);
  accounts = [account]; // Native authorization completed while the page was absent.
  await oldPage.resume();
  assert.equal(oldPage.getSnapshot().accounts[0]?.id, "recovered");
  oldPage.dispose();
  const reloadedPage = new CodexAccountsService(request, "local-codex");
  await reloadedPage.resume();
  assert.equal(reloadedPage.getSnapshot().login, null);
  assert.equal(reloadedPage.getSnapshot().accounts[0]?.id, "recovered");
  reloadedPage.dispose();
});

test("simultaneous resume events share one poll and late results cannot replace a new login", async () => {
  let resolvePoll!: (result: unknown) => void;
  let starts = 0, polls = 0;
  const service = new CodexAccountsService((async (_host: string, method: string) => {
    if (method.endsWith("/start")) return { sessionId: `login-${++starts}`, verificationUrl: "https://auth.openai.test", userCode: "TEST-1234", expiresAt: Date.now() + 60_000 };
    if (method.endsWith("/poll")) { polls++; return new Promise(resolve => { resolvePoll = resolve; }); }
    return { accounts: [] };
  }) as HostProtocolRequest, "local-codex");
  await service.startDeviceLogin();
  const resume = service.resume();
  assert.equal(service.resume(), resume);
  const poll = service.pollDeviceLogin();
  assert.equal(polls, 1);
  await service.startDeviceLogin();
  resolvePoll({ status: "error", message: "Old code expired" });
  await Promise.all([resume, poll]);
  assert.equal(service.getSnapshot().login?.sessionId, "login-2");
  assert.equal(service.getSnapshot().error, null);
  service.dispose();
});

test("disposing the page fences a late authorization result without cancelling server login", async () => {
  let resolvePoll!: (result: unknown) => void;
  const calls: string[] = [];
  const service = new CodexAccountsService((async (_host: string, method: string) => {
    calls.push(method);
    if (method.endsWith("/start")) return { sessionId: "pending", verificationUrl: "https://auth.openai.test", userCode: "TEST-1234", expiresAt: Date.now() + 60_000 };
    return new Promise(resolve => { resolvePoll = resolve; });
  }) as HostProtocolRequest, "local-codex");
  await service.startDeviceLogin();
  const before = service.getSnapshot();
  const polling = service.pollDeviceLogin();
  service.dispose();
  resolvePoll({ status: "error", message: "Late response" });
  await polling;
  assert.equal(service.getSnapshot(), before);
  assert.equal(calls.some(method => method.endsWith("/cancel")), false);
});


test("a synchronous disconnected Host error does not permanently poison login polling", async () => {
  let polls = 0;
  const service = new CodexAccountsService(((_host: string, method: string) => {
    if (method.endsWith("/start")) return Promise.resolve({ sessionId: "retryable", verificationUrl: "https://auth.openai.test", userCode: "TEST-1234", expiresAt: Date.now() + 60_000 });
    if (++polls === 1) throw new Error("Host disconnected");
    return Promise.resolve({ status: "pending" });
  }) as HostProtocolRequest, "local-codex");
  await service.startDeviceLogin();
  await assert.rejects(service.pollDeviceLogin(), /Host disconnected/);
  assert.equal((await service.pollDeviceLogin()).status, "pending");
  assert.equal(polls, 2);
  service.dispose();
});

test("a late account list cannot undo a committed credit policy", async () => {
  const account: CodexAccountView = {
    id: "a", label: "A", priority: 1, enabled: true, allowCredits: false, credentialConfigured: true,
    email: null, subscriptionType: "pro", rateLimitTier: null, status: "ready", observedAt: null,
    heldUntil: null, lastUsedAt: null, lastUsedHostId: null, limitWindows: [],
  };
  let resolveList!: (result: unknown) => void;
  const service = new CodexAccountsService((async (_host: string, method: string, params: any) => {
    if (method.endsWith("/list")) return new Promise(resolve => { resolveList = resolve; });
    assert.equal(method, "opencraft/codex/accounts/setAllowCredits");
    assert.deepEqual(params, { accountId: "a", allowCredits: true });
    return { accounts: [{ ...account, allowCredits: true }] };
  }) as HostProtocolRequest, "local-codex");
  try {
    const stale = service.refresh();
    await service.setAllowCredits("a", true);
    resolveList({ accounts: [account] });
    await stale;
    assert.equal(service.getSnapshot().accounts[0]?.allowCredits, true);
  } finally { service.dispose(); }
});

test("a maintenance-interrupted login shows a retry message without starting another login", async () => {
  Object.assign(globalThis, { React });
  for (const maintenance of [true, false]) {
    const calls: string[] = [];
    const request = (async (_hostId: string, method: string) => {
      calls.push(method);
      if (method.endsWith("/list")) return { accounts: [] };
      if (method.endsWith("/start")) return { sessionId: "session", verificationUrl: "https://example.test/device", userCode: "TEST", expiresAt: Date.now() + 60_000 };
      if (method.endsWith("/poll")) return { status: "error", message: "Login cancelled.", ...(maintenance ? { reason: "maintenance-interrupted" } : {}) };
      throw new Error(`Unexpected method ${method}`);
    }) as HostProtocolRequest;
    const service = new CodexAccountsService(request, "local-codex");
    try {
      await service.refresh();
      await service.startDeviceLogin();
      await service.pollDeviceLogin();
      const View = createCodexAccountsView(service);
      const html = renderToStaticMarkup(createElement(View, {} as any));
      if (maintenance) assert.match(html, /登录被维护中断，请重新登录/);
      else { assert.match(html, /Login cancelled\./); assert.doesNotMatch(html, /登录被维护中断/); }
      assert.equal(calls.filter(method => method.endsWith("/start")).length, 1);
    } finally { service.dispose(); }
  }
});
