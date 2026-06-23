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
      selectedBackend="codex"
      sessionsCount={3}
      onSelectedBackendChange={() => {}}
    />,
  );

  assert.match(html, /class="vela-settings-page"/);
  assert.match(html, />常规</);
  assert.match(html, />Backend</);
  assert.match(html, />默认 backend</);
  assert.match(html, />Codex</);
  assert.match(html, />\/api\/v1</);
  assert.match(html, /role="switch"/);
  assert.match(html, /class="vela-shell-switch"/);
  assert.doesNotMatch(html, /Desktop settings/);
  assert.doesNotMatch(html, /vela-desktop-settings-overlay/);
});

test("desktop settings sidebar exposes return and navigation inside shell chrome", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsSidebar showTrafficLights onClose={() => {}} />,
  );

  assert.match(html, /class="vela-settings-sidebar"/);
  assert.match(html, />返回应用</);
  assert.match(html, /placeholder="搜索设置\.\.\."/);
  assert.match(html, />个人资料</);
  assert.match(html, />MCP 服务器</);
  assert.match(html, />工作树</);
});
