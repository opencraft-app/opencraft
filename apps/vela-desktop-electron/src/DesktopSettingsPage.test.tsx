import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  DesktopSettingsPage,
  DesktopSettingsSidebar,
} from "./DesktopSettingsPage";

test("desktop settings render as shell-owned page with backend selection", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsPage
      apiBaseUrl="/api/v1"
      backends={[
        {
          kind: "codex",
          status: "available",
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
        },
      ]}
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
  assert.match(html, />Backend</);
  assert.match(html, />默认 backend</);
  assert.match(html, /Codex/);
  assert.match(html, />\/api\/v1</);
  assert.match(html, /role="switch"/);
  assert.match(html, /class="vela-shell-switch"/);
  assert.doesNotMatch(html, /Desktop settings/);
  assert.doesNotMatch(html, /vela-desktop-settings-overlay/);
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
