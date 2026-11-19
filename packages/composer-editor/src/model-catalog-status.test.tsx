import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { LocaleRuntime } from "@opencraft/i18n";
import { ModelCatalogStatus } from "./model-catalog-status";
const render = (errorKind: "catalog" | "preferences") =>
  renderToStaticMarkup(
    createElement(IntlRuntimeProvider, {
      runtime: new LocaleRuntime([]),
      children: createElement(ModelCatalogStatus, { error: true, errorKind }),
    }),
  );
void test("personal preference failures do not falsely blame the Agent model catalog", () => {
  const html = render("preferences");
  assert.match(html, /model preferences/);
  assert.match(html, /Agent configuration is unchanged/);
  assert.doesNotMatch(html, /Agent&#x27;s setup|Couldn.*load models/);
});
void test("actual catalog failures retain the catalog diagnostic", () => {
  const html = render("catalog");
  assert.match(html, /load models/);
  assert.doesNotMatch(html, /model preferences/);
});
