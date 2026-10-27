import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { CONNECTOR_CATALOG } from "@opencraft/connector-core";
import { ConnectorIcon } from "../../apps/workbench-web/src/components/connectors/connector-icon";

test("service catalog retains one specific guide and a decorative local icon per entry", () => {
  for (const entry of CONNECTOR_CATALOG) {
    assert.equal(entry.steps.length, 1);
    assert.ok(!entry.steps[0].includes("在此填写并保存配置"));
    const dom = new JSDOM(renderToStaticMarkup(createElement(ConnectorIcon, { id: entry.id })));
    assert.equal(dom.window.document.querySelectorAll("svg").length, 1, entry.id);
    assert.equal(dom.window.document.querySelector("svg")?.closest("[aria-hidden=true]") !== null, true, entry.id);
    assert.equal(dom.window.document.querySelector("img, image, use"), null, entry.id);
    dom.window.close();
  }
});

test("unknown and externally provided connector IDs render without fetching an image", () => {
  for (const id of ["custom-server", "https://example.invalid/icon.svg", "../private-logo"]) {
    const markup = renderToStaticMarkup(createElement(ConnectorIcon, { id }));
    assert.match(markup, /<svg/);
    assert.doesNotMatch(markup, /(?:href|src)=/);
    assert.doesNotMatch(markup, /example\.invalid|private-logo/);
  }
});
