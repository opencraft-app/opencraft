import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Button } from "../plugins/lightvela-hermes/src/upstream/mono2/components/ui/button";
import { Checkbox } from "../plugins/lightvela-hermes/src/upstream/mono2/components/ui/checkbox";
import { Switch } from "../plugins/lightvela-hermes/src/upstream/mono2/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../plugins/lightvela-hermes/src/upstream/mono2/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../plugins/lightvela-hermes/src/upstream/mono2/components/ui/select";

// These render the generated consumer with OpenCraft's installed React/Radix.
// Browser interaction and computed light/dark styles are verified separately
// in the real Workbench ModalSurface fixture; SSR does not prove focus behavior.
test("generated Button renders semantic native/Slot controls and host color roles", () => {
  const primary = renderToStaticMarkup(h(Button, { disabled: true }, "Save"));
  assert.match(primary, /^<button\b/);
  assert.match(primary, /class="[^"]*lv-button lv-button--primary/);
  assert.match(primary, /style="color:var\(--color-text-button-primary\)"/);
  assert.match(primary, /disabled=""/);
  const secondary = renderToStaticMarkup(h(Button, { variant: "secondary" }, "Cancel"));
  assert.match(secondary, /lv-button--secondary/);
  assert.match(secondary, /color:var\(--color-text-button-secondary\)/);
  const link = renderToStaticMarkup(h(Button, { asChild: true, variant: "outline" }, h("a", { href: "#details" }, "Details")));
  assert.match(link, /^<a\b[^>]*href="#details"/);
  assert.doesNotMatch(link, /<button/);
});

test("generated Checkbox preserves all controlled states, native disabling and one Radix indicator", () => {
  for (const [checked, aria, state] of [[false, "false", "unchecked"], [true, "true", "checked"], ["indeterminate", "mixed", "indeterminate"]] as const) {
    const html = renderToStaticMarkup(h(Checkbox, { checked, disabled: true, "aria-label": "Choose skills", onCheckedChange: () => {} }));
    assert.match(html, new RegExp(`role="checkbox" aria-checked="${aria}" data-state="${state}"`));
    assert.match(html, /class="lv-checkbox /);
    assert.match(html, /disabled=""/);
    assert.equal((html.match(/class="group flex items-center justify-center"/g) ?? []).length, checked ? 1 : 0);
  }
});

test("generated Switch exposes the selected value and the host-sized Radix thumb", () => {
  for (const checked of [false, true]) {
    const html = renderToStaticMarkup(h(Switch, { checked, "aria-label": "Hidden files", onCheckedChange: () => {} }));
    assert.match(html, new RegExp(`role="switch" aria-checked="${checked}" data-state="${checked ? "checked" : "unchecked"}"`));
    assert.match(html, /class="lv-switch /);
    assert.match(html, /class="lv-switch__thumb /);
  }
});

test("generated controlled Tabs retain selected/disabled semantics and content ownership", () => {
  const html = renderToStaticMarkup(h(Tabs, { value: "active", onValueChange: () => {} },
    h(TabsList, { "aria-label": "Tasks" },
      h(TabsTrigger, { value: "active" }, "Active"),
      h(TabsTrigger, { value: "ended", disabled: true }, "Ended")),
    h(TabsContent, { value: "active" }, "Active content"),
    h(TabsContent, { value: "ended" }, "Ended content")));
  assert.match(html, /role="tablist"[^>]*aria-label="Tasks"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*data-state="active"/);
  assert.match(html, /role="tab" aria-selected="false"[^>]*data-state="inactive"[^>]*disabled=""/);
  assert.match(html, /lv-segmented-control__item/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /Active content/);
  assert.doesNotMatch(html, /Ended content/);
});

test("generated Select keeps the original Radix value owner and accessible disabled trigger", () => {
  assert.equal(Select, SelectPrimitive.Root);
  const html = renderToStaticMarkup(h(Select, { value: "provider/model:raw", disabled: true, onValueChange: () => {} },
    h(SelectTrigger, { "aria-label": "Model", id: "model-select" }, h(SelectValue, { placeholder: "Choose model" })),
    h(SelectContent, null, h(SelectItem, { value: "provider/model:raw" }, "Friendly model"))));
  assert.match(html, /role="combobox"[^>]*aria-expanded="false"/);
  assert.match(html, /class="lv-select-trigger /);
  assert.match(html, /aria-label="Model"/);
  assert.match(html, /id="model-select"/);
  assert.match(html, /disabled=""/);
  // Option registration happens after mount; SSR proves the native form
  // mirror is excluded from the accessible tree, not its post-mount value.
  assert.match(html, /<select[^>]*aria-hidden="true"[^>]*disabled=""/);
});
