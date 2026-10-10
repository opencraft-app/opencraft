import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { NavigationIcon } from "../apps/workbench-web/src/components/shell-navigation/navigation-action";

const render = (name: string, selected = false) => renderToStaticMarkup(
  createElement(NavigationIcon, { name, selected }),
);

test("navigation glyph state is projected without changing the semantic name or SVG box", () => {
  for (const name of ["chat", "message-circle", "cloud", "folder", "applications", "settings", "bot", "server", "unknown"]) {
    const normal = render(name);
    const selected = render(name, true);
    assert.match(normal, /data-navigation-glyph-variant="outline"/);
    assert.match(selected, /data-navigation-glyph-variant="selected"/);
    for (const svg of [normal, selected]) {
      assert.match(svg, /aria-hidden="true"/);
      assert.match(svg, /focusable="false"/);
      assert.match(svg, /width="15"/);
      assert.match(svg, /height="15"/);
    }
  }
});

test("navigation silhouettes are explicit and do not fill over internal detail", () => {
  for (const name of ["chat", "message-circle", "cloud", "folder", "applications"]) {
    assert.match(render(name), /fill="none"/);
    assert.match(render(name, true), /fill="currentColor"/);
  }
  for (const name of ["bot", "database", "hard-drive", "server", "settings"]) {
    assert.match(render(name, true), /fill="none"/);
    assert.match(render(name, true), /stroke-width="2.5"/);
  }
  assert.match(render("message-circle"), /lucide-message-circle/);
});
