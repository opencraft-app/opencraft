import assert from "node:assert/strict";
import test from "node:test";
import { controlOwnershipViolations as check, sharedControlClassNames } from "../../scripts/check-control-ownership.mjs";

test("raw controls cannot bypass the owner through conditional or composed classes", () => {
  for (const source of [
    '<button className="chrome-button" />',
    '<button className="ui-disclosure-button" />',
    '<nav className="ui-navigation-list" />',
    '<button className="ui-navigation-item" />',
    '<button className={expanded ? "chrome-button" : "other"} />',
    '<button className={cx("other", "settings-control-button")} />',
    '<span className={`ui-button ${extra}`} />',
    'const controlClass = "chrome-button"; const alias = controlClass; <button className={alias} />',
  ]) assert.ok(check("apps/workbench-web/src/example.tsx", source).length, source);
  assert.deepEqual(check("apps/workbench-web/src/example.tsx", '<IconButton aria-label="Open" className="chrome-button" />'), []);
});

test("shared controls cannot be repainted with inline styles or import aliases", () => {
  assert.ok(check("packages/composer-editor/src/example.tsx", '<DisclosureButton style={{ backgroundColor: "white" }}>Permissions</DisclosureButton>').length);
  assert.ok(check("apps/workbench-web/src/example.tsx", '<IconButton aria-label="Open" style={{ backgroundColor: "white" }} />').length);
  assert.ok(check("plugins/example/src/view.tsx", 'import { Button as Action } from "@opencraft/design-system-web/button"; <Action style={{borderRadius: 99}} />').length);
  assert.deepEqual(check("apps/workbench-web/src/example.tsx", '<Button style={{width: "100%", marginInlineStart: "auto"}} />'), []);
});

test("consumer class names do not create another styling authority", () => {
  const classes = new Set(sharedControlClassNames("plugins/example/src/view.tsx", 'import { Button as Save } from "@opencraft/design-system-web/button"; <Save className="feature-save" />'));
  assert.ok(classes.has("feature-save"));
  const navigation = new Set(sharedControlClassNames("apps/workbench-web/src/navigation.tsx", '<NavigationList className="settings-categories"><NavigationItem className="settings-destination" /></NavigationList>'));
  assert.ok(check("apps/workbench-web/src/styles/navigation.scss", '.settings-categories { padding-inline: 0; } .settings-destination { background: red; }', navigation).length);
  assert.ok(check("plugins/example/src/styles.scss", '.feature-save { background: red; }', classes).length);
  const disclosures = new Set(sharedControlClassNames("packages/composer-editor/src/example.tsx", '<DisclosureButton className="permission-trigger">Permissions</DisclosureButton>'));
  for (const source of [
    '.permission-trigger:hover { background: red; }',
    '.permission-trigger[data-state="open"] { color: red; }',
    '.permission-trigger { &:active { border-radius: 99px; } }',
  ]) assert.ok(check("apps/workbench-web/src/styles/example.scss", source, disclosures).length, source);
  assert.deepEqual(check("plugins/example/src/styles.scss", '.feature-save { margin-inline-start: auto; width: 100%; }', classes), []);
});

test("material and projection attributes cannot be authored by features", () => {
  for (const source of [
    'import { LiquidGlassBackdrop as Background } from "@opencraft/design-system-web/liquid-glass";',
    '<button data-liquid-action="" />',
    '<div data-control-surface="floating" />',
    '<Button data-control-loading={working} />',
  ]) assert.ok(check("plugins/example/src/view.tsx", source).length, source);
  assert.deepEqual(check("packages/design-system-web/src/button.tsx", '<button className="ui-button" data-control-surface={surface} />'), []);
});

test("nested and functional selectors cannot repaint shared controls", () => {
  for (const source of [
    '.page { .ui-button { background: white; } }',
    '.ui-navigation-list { padding-inline: 0; }',
    '.ui-navigation-item { border-radius: 99px; }',
    '.ui-button { &:hover { background: white; } }',
    ':root :is(.chrome-button, .other) { border-radius: 99px; }',
    '.settings-control-button[aria-busy=true] { color: transparent; }',
    '.row { [data-control-surface=floating] { box-shadow: none; } }',
    '.button { @include glass.liquid; }',
    '[data-liquid-action] { @include material.liquid; }',
  ]) assert.ok(check("apps/workbench-web/src/styles/example.scss", source).length, source);
  assert.deepEqual(check("apps/workbench-web/src/styles/example.scss", '.toolbar .ui-button { margin-inline-start: auto; width: 100%; }'), []);
  assert.deepEqual(check("apps/workbench-web/src/styles/example.scss", '.row:has(.ui-button) { background: white; } .row > button:not(.ui-button) { padding: 8px; }'), []);
  assert.deepEqual(check("packages/design-system-web/src/button.web.scss", '.ui-button { background: var(--color-background-button-primary); }'), []);
});
