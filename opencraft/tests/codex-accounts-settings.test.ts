import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Dialog from "@radix-ui/react-dialog";

import type { HostProtocolRequest } from "../plugins/builtin-agents/src/local-agent-settings-service.js";
import { CodexAccountsService } from "../plugins/builtin-agents/src/codex-accounts/service.js";
import { CodexDeviceLoginContent, createCodexAccountsView } from "../plugins/builtin-agents/src/codex-accounts/view.js";

test("Codex account row shares touch-safe hover and a reachable actions target", () => {
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/codex-accounts.scss", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../apps/workbench-web/src/styles/settings-panel.scss", import.meta.url), "utf8");
  const controls = readFileSync(new URL("../packages/design-system/src/controls.web.scss", import.meta.url), "utf8");
  const menu = readFileSync(new URL("../packages/design-system/src/menu.web.scss", import.meta.url), "utf8");
  assert.match(styles, /\.codex-account__row\s*\{[\s\S]*?@include controls\.hover-capable/u);
  assert.doesNotMatch(styles, /&:hover,\s*&:focus-within\s*\{\s*background/u);
  assert.match(styles, /:root\[data-touch-interaction\] \.settings-icon-button\.codex-account__menu-trigger\s*\{\s*opacity: 1;/u);
  assert.match(settings, /@media \(any-pointer: coarse\), \(hover: none\)[\s\S]*?\.settings-control-button\.settings-icon-button\s*\{ width: 44px; height: 44px; \}/u);
  assert.match(controls, /@mixin hover-capable\s*\{\s*@media \(any-hover: hover\) and \(any-pointer: fine\)[\s\S]*?:root:not\(\[data-touch-interaction\]\) &/u);
  assert.match(menu, /@include controls\.hover-capable/u);
  assert.match(menu, /@media \(any-pointer: coarse\), \(hover: none\) \{ min-height: 44px; \}/u);
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
  assert.match(render(), /user@example\.com/);
  assert.match(render(), /codex-account__plan[^>]*>Pro/);
  assert.match(render(), /codex-account__status-copy[^>]*>可用/);
  assert.match(render(), /<small>5H<\/small><strong>25%<\/strong><time[^>]*dateTime="2026-09-26T10:00:00\.000Z"[^>]*>/);
  assert.match(render(), /<small>7D<\/small><strong>50%<\/strong><span class="codex-account__reset">重置未知<\/span>/);
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
