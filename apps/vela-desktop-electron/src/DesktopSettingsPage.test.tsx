import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

register(new URL("../../../packages/vela-chat-web/tests/css-module-loader.mjs", import.meta.url));

const {
  DesktopSettingsPage,
  DesktopSettingsSidebar,
} = await import("./DesktopSettingsPage");

function codexBackend() {
  return {
    kind: "codex" as const,
    status: "available" as const,
    display_name: "Codex",
    capabilities: {
      streaming: true,
      cancel: true,
      permission_requests: true,
      structured_diff: true,
      session_agent_config: true,
    },
    models: [],
    permission_modes: [],
    features: [],
  };
}

function testClient() {
  return {
    getBackendSettings: async () => ({
      schema: "velad.backend_settings.v1",
      backend: "vela_engine",
      settings: { endpoint: "", api_key_set: false, model: "" },
      status: "unconfigured",
      missing_fields: ["endpoint", "api_key", "model"],
      updated_at: null,
    }),
    updateBackendSettings: async () => ({
      schema: "velad.backend_settings.v1",
      backend: "vela_engine",
      settings: { endpoint: "", api_key_set: false, model: "" },
      status: "unconfigured",
      missing_fields: ["endpoint", "api_key", "model"],
      updated_at: null,
    }),
  } as any;
}

test("desktop general settings stay separate from engine configuration", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      backends={[codexBackend()]}
      client={testClient()}
      hostLabel="Browser preview"
      appVersion="0.0.1"
      activePanel="general"
      selectedBackend="codex"
      sessionsCount={3}
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, /class="vela-settings-page"/);
  assert.match(html, />常规</);
  assert.match(html, /role="switch"/);
  assert.match(html, /class="vela-shell-switch"/);
  assert.match(html, />Shell host</);
  assert.match(html, />Browser preview</);
  assert.match(html, />Session cache</);
  assert.match(html, />3 sessions</);
  assert.doesNotMatch(html, />Backend</);
  assert.doesNotMatch(html, />默认 backend</);
  assert.doesNotMatch(html, />Vela 内置引擎 Endpoint</);
  assert.doesNotMatch(html, />velad API</);
  assert.doesNotMatch(html, /Desktop settings/);
  assert.doesNotMatch(html, /vela-desktop-settings-overlay/);
});

test("desktop engine settings render in their own sidebar tab", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      backends={[codexBackend()]}
      client={testClient()}
      hostLabel="Browser preview"
      appVersion="0.0.1"
      activePanel="engine"
      selectedBackend="codex"
      sessionsCount={3}
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, /aria-label="Engine settings"/);
  assert.match(html, />引擎</);
  assert.match(html, />默认 backend</);
  assert.match(html, /当前可用：Codex/);
  assert.match(html, />Vela 内置引擎</);
  assert.match(html, />Vela 内置引擎 Endpoint</);
  assert.match(html, />Vela 内置引擎 Key</);
  assert.match(html, />Vela 内置引擎 Model</);
  assert.match(html, />velad API</);
  assert.match(html, />\/api\/v1</);
  assert.doesNotMatch(html, />工作模式</);
  assert.doesNotMatch(html, />默认打开目标</);
});

test("desktop settings sidebar exposes return and navigation inside shell chrome", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsSidebar
      activePanel="general"
      showTrafficLights
      onClose={() => {}}
      onPanelChange={() => {}}
    />,
  );

  assert.match(html, /class="[^"]*vela-settings-sidebar/);
  assert.match(html, />返回应用</);
  assert.match(html, /placeholder="搜索设置\.\.\."/);
  assert.match(html, />常规</);
  assert.match(html, />引擎</);
  assert.match(html, />关于 LightVela</);
  assert.match(html, />已归档对话</);
  assert.doesNotMatch(html, />个人资料</);
  assert.doesNotMatch(html, />MCP 服务器</);
  assert.doesNotMatch(html, />工作树</);
});

test("desktop settings renders about panel with current version", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      appVersion="0.0.7"
      activePanel="about"
      backends={[]}
      client={testClient()}
      hostLabel="Browser preview"
      selectedBackend=""
      sessionsCount={0}
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, />关于 LightVela</);
  assert.match(html, />当前版本</);
  assert.match(html, />0\.0\.7</);
  assert.match(html, /云端专属个人 Agent/);
  assert.match(html, /https:\/\/lightvela\.com/);
  assert.doesNotMatch(html, />Backend</);
});
