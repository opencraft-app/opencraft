import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isAnonymousShellAccount,
  shellAccountEntranceLabel,
  type ShellAccount,
} from "../apps/workbench-web/src/components/shell-navigation/navigation-content";

function account(phase: "anonymous" | "authenticated", name: string | null = null): ShellAccount {
  return {
    snapshot: {
      revision: 1,
      phase,
      name,
      avatarUrl: null,
      planLabel: null,
      usageRemainingPercent: null,
      error: null,
      applicationIntervention: null,
    },
    onOpen: () => undefined,
    onRefresh: async () => undefined,
    onSignOut: async () => undefined,
  };
}

test("anonymous identity is an explicit Sign in action, not an Account identity", () => {
  const anonymous = account("anonymous");
  assert.equal(isAnonymousShellAccount(anonymous), true);
  assert.equal(shellAccountEntranceLabel(anonymous), "Sign in");
  assert.equal(shellAccountEntranceLabel(null), null);
  assert.equal(shellAccountEntranceLabel(account("authenticated", "Ada")), "Ada");
  assert.equal(shellAccountEntranceLabel(account("authenticated")), "Account");
});

test("anonymous sign in uses an action glyph while authenticated accounts retain identity avatars", () => {
  const source = readFileSync(
    new URL("../apps/workbench-web/src/components/shell-navigation/navigation-content.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /function AccountLeadingVisual[\s\S]*?isAnonymousShellAccount\(account\)[\s\S]*?<LogIn[\s\S]*?: <AccountAvatar/u);
});

test("menu login progress and recoverable failure stay visible at the account entrance", () => {
  const anonymous = account("anonymous");
  const signIn = { options: [], pending: true, error: null, select() {}, cancel() {}, retry() {} };
  assert.equal(shellAccountEntranceLabel({ ...anonymous, signIn }), "正在登录…");
  assert.equal(shellAccountEntranceLabel({ ...anonymous, signIn: { ...signIn, pending: false, error: "Retry" } }), "登录未完成");
});

test("anonymous sign-in menu exposes Settings without selecting a login provider", () => {
  const menu = readFileSync(
    new URL("../apps/workbench-web/src/components/shell-navigation/account-sign-in-menu.tsx", import.meta.url),
    "utf8",
  );
  const navigation = readFileSync(
    new URL("../apps/workbench-web/src/components/shell-navigation/index.tsx", import.meta.url),
    "utf8",
  );
  assert.match(menu, /<DropdownMenu\.Separator className="shell-sign-in-menu__separator" \/>/u);
  assert.match(menu, /textValue="设置"/u);
  assert.match(menu, /onOpenSettings\(\)/u);
  assert.match(navigation, /onOpenSettings=\{config\.onOpenSettings\}/u);
});

test("both Workbench shells preserve the anonymous provider for user-initiated sign in", () => {
  for (const path of [
    "../apps/workbench-web/src/app.tsx",
    "../apps/workbench-web/src/components/hostless-workbench.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /account\.snapshot\.phase === "anonymous" \? null/u);
  }
  const accountView = readFileSync(
    new URL("../plugins/lightvela-platform/src/account/lightvela-account-view.tsx", import.meta.url),
    "utf8",
  );
  assert.match(accountView, /<LightVelaLoginOptions account=\{account\} snapshot=\{snapshot\}[\s\S]*?reason="account-settings"/u);
});

test("cloud account availability cannot replace the selected workspace or force Bot creation", () => {
  const app = readFileSync(new URL("../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /snapshot\.applicationIntervention/);
  assert.match(app, /hostConnectionIntervention\?\.providerId === activeHostProviderId/);
  const intervention = readFileSync(new URL("../plugins/lightvela-hermes/src/settings/lightvela-hermes-empty-view.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(intervention, /LightVelaBotCreationGuide/);
  assert.match(intervention, /host\.openSettings\?\.\("connections"\)/);
});
