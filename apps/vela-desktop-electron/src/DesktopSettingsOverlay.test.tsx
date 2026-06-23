import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopSettingsOverlay } from "./DesktopSettingsOverlay";

test("desktop settings render as host overlay with velad connection context", () => {
  const html = renderToStaticMarkup(
    <DesktopSettingsOverlay
      apiBaseUrl="/api/v1"
      hostLabel="Browser preview"
      sessionsCount={3}
      onClose={() => {}}
    />,
  );

  assert.match(html, /class="vela-desktop-settings-overlay"/);
  assert.match(html, /aria-label="Desktop settings"/);
  assert.match(html, />Desktop settings</);
  assert.match(html, />Browser preview</);
  assert.match(html, />\/api\/v1</);
  assert.match(html, />3 sessions</);
  assert.doesNotMatch(html, /thread-panel-stack/);
});
