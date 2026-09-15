import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSearchSelect } from "../packages/extension-react/src/settings-search-select";

test("shared settings choice retains group identity for identical option labels", () => {
  const groups = ["Group A", "Group B"].map(id => ({ id, label: id, options: [
    { value: JSON.stringify([id, "shared"]), label: "Shared option" },
  ] }));
  const html = renderToStaticMarkup(createElement(SettingsSearchSelect, {
    id: "choice", label: "Options", value: JSON.stringify(["Group B", "shared"]), groups,
    onChange() { throw new Error("Rendering must not mutate state"); },
  }));
  assert.match(html, /Group B/); assert.doesNotMatch(html, /Group A/);
});
