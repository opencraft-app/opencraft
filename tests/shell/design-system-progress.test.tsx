import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";

test("shared progress has a stable decorative vector and caller-owned status", () => {
  const html = renderToStaticMarkup(<ProgressIndicator className="fixture-progress" />);
  assert.match(html, /class="ui-progress-indicator fixture-progress"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(html, /data-action-glyph="loading"/);
  assert.match(html, /stroke-width="1.5"/);
  assert.match(html, /r="7" opacity="0.3"/);
  assert.match(html, /d="M12 5a7 7 0 1 1-7 7"/);
  assert.doesNotMatch(html, /role="status"|aria-live|style=|tabindex/i);
});
