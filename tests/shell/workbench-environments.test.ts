import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { createWorkbenchDraftLocation } from "@opencraft/workbench-runtime";
import {
  createApplicationNavigation,
  parseApplicationRouteUrl,
} from "../../apps/workbench-web/src/runtime/workbench-navigation";

test("Environment is removed from both application shells", () => {
  const connected = readFileSync(new URL("../../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  const hostless = readFileSync(new URL("../../apps/workbench-web/src/components/hostless-workbench.tsx", import.meta.url), "utf8");
  for (const source of [connected, hostless]) {
    assert.doesNotMatch(source, /shell\.environments|EnvironmentNavigation|EnvironmentContent|EnvironmentBreadcrumbs|openEnvironments/);
  }
  assert.equal(existsSync(new URL("../../apps/workbench-web/src/components/environments-page.tsx", import.meta.url)), false);
  assert.equal(existsSync(new URL("../../apps/workbench-web/src/components/environment-breadcrumbs.tsx", import.meta.url)), false);
});

test("local Model Services is a normal Settings page bound by its local service", () => {
  const extension = readFileSync(new URL("../../plugins/builtin-agents/src/index.ts", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../../apps/workbench-web/src/components/settings-page.tsx", import.meta.url), "utf8");
  assert.match(extension, /LocalAgentSettingsService\(options\.requestHost, "local"\)/);
  assert.match(extension, /title: "模型服务"/);
  assert.doesNotMatch(extension, /environment:\s*\{/);
  assert.doesNotMatch(settings, /page\.environment|section === "connections"|连接环境/);
});

test("legacy Environment URLs migrate to Settings without reviving the removed route", () => {
  assert.deepEqual(parseApplicationRouteUrl(new URL("https://app.test/environments")), {
    kind: "settings",
    slug: "appearance",
  });
  assert.deepEqual(parseApplicationRouteUrl(new URL("https://app.test/environments?section=connections")), {
    kind: "settings",
    slug: "appearance",
  });
  assert.deepEqual(parseApplicationRouteUrl(new URL("https://app.test/environments?environment=local&section=opencraft.builtin-agents.model-services")), {
    kind: "settings",
    slug: "opencraft.builtin-agents.model-services",
  });
});

test("navigation normalizes a legacy Environment URL to its Settings replacement", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const urls: string[] = [];
  const history = {
    state: null as unknown,
    replaceState(value: unknown, _title: string, url: string) { this.state = value; urls.push(url); },
    pushState(value: unknown, _title: string, url: string) { this.state = value; urls.push(url); },
    back() {}, forward() {}, go() {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "https://app.test/environments?environment=local&section=opencraft.builtin-agents.model-services" },
    history, addEventListener() {}, removeEventListener() {},
  } });
  const navigation = createApplicationNavigation(createWorkbenchDraftLocation("local", "draft"));
  try {
    assert.deepEqual(navigation.getSnapshot().applicationRoute, {
      kind: "settings",
      slug: "opencraft.builtin-agents.model-services",
    });
    assert.equal(navigation.getSnapshot().url, "/settings/opencraft.builtin-agents.model-services");
  } finally {
    navigation.dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  }
});
