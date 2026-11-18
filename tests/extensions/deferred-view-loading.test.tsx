import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDeferredView } from "../../packages/extension-react/src/deferred-view";

test("a deferred view exposes one polite status while hiding the decorative indicator", () => {
  let calls = 0;
  const View = createDeferredView(async () => {
    calls++;
    return () => <div>Ready</div>;
  });
  const html = renderToStaticMarkup(<View />);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-label="正在加载"/);
  assert.match(html, /class="deferred-view__indicator" aria-hidden="true"/);
  assert.equal(calls, 0, "server render does not eagerly load");
});
