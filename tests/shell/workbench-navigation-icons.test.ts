import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { resolveWorkbenchPresentation } from "../../apps/workbench-web/src/workbench-presentation";
import { WorkbenchPresentationContext } from "../../apps/workbench-web/src/workbench-product";
import { NavigationIcon } from "../../apps/workbench-web/src/components/shell-navigation/navigation-action";

const render = (name: string, selected = false, iconStyle: "standard" | "classic" = "standard") => renderToStaticMarkup(
  createElement(WorkbenchPresentationContext.Provider, {value:resolveWorkbenchPresentation({iconStyle})}, createElement(NavigationIcon, { name, selected })),
);

test("navigation glyph state is projected without changing the semantic name or SVG box", () => {
  for (const name of ["write", "chat", "message-circle", "cloud", "folder", "applications", "settings", "bot", "server", "unknown"]) {
    const normal = render(name);
    const selected = render(name, true);
    assert.match(normal, /data-navigation-glyph-variant="outline"/);
    assert.match(selected, /data-navigation-glyph-variant="selected"/);
    for (const svg of [normal, selected]) {
      assert.match(svg, /aria-hidden="true"/);
      assert.match(svg, /focusable="false"/);
      assert.match(svg, /width="14"/);
      assert.match(svg, /height="14"/);
    }
  }
});

test("Downstream navigation retains its existing silhouette and detailed selected state", () => {
  for (const name of ["chat", "message-circle", "cloud", "folder", "applications"]) {
    assert.match(render(name, false, "classic"), /fill="none"/);
    assert.match(render(name, true, "classic"), /fill="currentColor"/);
  }
  for (const name of ["bot", "database", "hard-drive", "server"]) {
    assert.match(render(name, true, "classic"), /fill="none"/);
    assert.match(render(name, true, "classic"), /stroke-width="2.5"/);
  }
  assert.match(render("message-circle"), /data-action-glyph="chat"/);
});

test("core navigation uses the downstream outline role without boldening selected glyphs", () => {
  for (const name of ["chat", "start", "columns", "server", "settings"]) {
    for (const selected of [false, true]) {
      assert.match(render(name, selected), name === "settings" ? /stroke-width="1.5"/ : /stroke-width="2"/);
      assert.match(render(name, selected), /fill="none"/);
    }
    const shape = (svg: string) => svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("<"));
    assert.equal(shape(render(name)), shape(render(name, true)));
  }
});
