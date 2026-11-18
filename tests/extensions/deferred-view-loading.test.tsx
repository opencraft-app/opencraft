import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { createIntl, RawIntlProvider } from "react-intl";
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
  assert.match(html, /aria-label="Loading…"/);
  assert.match(html, /class="deferred-view__indicator" aria-hidden="true"/);
  assert.equal(calls, 0, "server render does not eagerly load");
});

test("a deferred view uses the active locale when provided", () => {
  const View = createDeferredView(async () => () => <div>Ready</div>);
  const intl = createIntl({
    locale: "zh-CN",
    messages: { "chat.composer.loading": "正在加载…", "common.retry": "重试" },
  });
  const html = renderToStaticMarkup(
    <RawIntlProvider value={intl}>
      <View />
    </RawIntlProvider>,
  );
  assert.match(html, /aria-label="正在加载…"/);
});
