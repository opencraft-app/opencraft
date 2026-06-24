import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopEmptySurface } from "./DesktopEmptySurface";

test("desktop empty surface renders workspace home composer", () => {
  const html = renderToStaticMarkup(
    <DesktopEmptySurface
      draft=""
      locationLabel="本地"
      modelLabel="GPT-5.3-Codex-Spark"
      permissionLabel="Default permissions"
      reasoningLabel="High"
      sourceLabel="QuantumNous/new-api"
      onDraftChange={() => {}}
      onSubmit={() => {}}
    />,
  );

  assert.match(html, /class="vela-desktop-empty"/);
  assert.match(html, />新建 workspace</);
  assert.match(html, /QuantumNous\/new-api/);
  assert.match(html, />本地</);
  assert.match(html, /给 Agent 发消息/);
  assert.match(html, /GPT-5\.3-Codex-Spark/);
  assert.match(html, />High</);
  assert.match(html, /Default permissions/);
});
