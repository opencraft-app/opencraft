import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopEmptySurface } from "./DesktopEmptySurface";

test("desktop empty surface stays a neutral runtime placeholder", () => {
  const html = renderToStaticMarkup(<DesktopEmptySurface />);

  assert.match(html, /class="vela-desktop-empty"/);
  assert.doesNotMatch(html, />Vela</);
  assert.doesNotMatch(html, /Create or select a session/);
  assert.doesNotMatch(html, /New Chat/);
});
