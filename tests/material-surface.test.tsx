import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialSurface } from "@opencraft/design-system-web/material-surface";

test("passive material panel preserves section semantics and owns exactly one backing", () => {
  const html = renderToStaticMarkup(<MaterialSurface className="preview-panel" aria-label="Phone preview"><h2>Preview</h2><button>Open</button></MaterialSurface>);
  assert.match(html, /^<section aria-label="Phone preview" class="ui-material-surface preview-panel">/);
  assert.equal((html.match(/class="ui-liquid-glass"/g) ?? []).length, 1);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /data-shape="rounded-rectangle"/);
  assert.match(html, /<h2>Preview<\/h2><button>Open<\/button><\/section>$/);
  assert.doesNotMatch(html, /data-control-surface|ui-button|role="button"/);
});


test("rich card action retains a native disabled trigger and unwrapped content slots", async () => {
  const { ObjectCardButton } = await import("@opencraft/design-system-web/object-controls");
  const html = renderToStaticMarkup(<ObjectCardButton disabled aria-label="History" className="record"><span>Title</span><span>Preview</span></ObjectCardButton>);
  assert.match(html, /^<button/);
  assert.match(html, /class="ui-button ui-object-card-button record"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-label="History"/);
  assert.match(html, /data-content-layout="row"/);
  assert.match(html, /<span>Title<\/span><span>Preview<\/span><\/button>$/);
  assert.doesNotMatch(html, /ui-button__label/);
});


test("media actions retain native retry semantics and direct thumbnail content", async () => {
  const { MediaActionButton } = await import("@opencraft/design-system-web/object-controls");
  const preview = renderToStaticMarkup(<MediaActionButton aria-label="Preview"><img src="/thumb.png" alt="" /></MediaActionButton>);
  assert.match(preview, /data-media-action="preview"/);
  assert.match(preview, /class="ui-button ui-media-action-button"/);
  assert.match(preview, /<img[^>]*\/><\/button>$/);
  const retry = renderToStaticMarkup(<MediaActionButton action="retry" disabled><span role="status">Loading</span></MediaActionButton>);
  assert.match(retry, /data-media-action="retry"/);
  assert.match(retry, /disabled=""/);
  assert.match(retry, /<span role="status">Loading<\/span><\/button>$/);
});
