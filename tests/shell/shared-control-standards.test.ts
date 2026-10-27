import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buttonSizeMetrics } from "@opencraft/design-system/button";
import { typographyRole } from "@opencraft/design-system/typography";

const read = (path: string) => readFileSync(new URL(path, new URL("../", import.meta.url)), "utf8");
function block(source: string, selector: string): string {
  const start = source.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `missing ${selector}`);
  const open = source.indexOf("{", start);
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed ${selector}`);
}

test("compact titlebar paint reads live motion rather than terminal pane presence", () => {
  const tokens = read("../packages/design-system/src/tokens.web.scss");
  const navigation = read("../apps/workbench-web/src/components/shell-navigation/shell-navigation.scss");
  const styles = read("../apps/workbench-web/src/styles/app.scss");
  const shell = read("../apps/workbench-web/src/components/app-shell.tsx");
  assert.match(tokens, /--background-shell-compact-titlebar: var\(--color-surface\)/u);
  assert.doesNotMatch(tokens + navigation, /--(?:width|height|background)-shell-docked-edge/u);
  assert.doesNotMatch(shell + styles + navigation, /sidecarCompactOnly|data-sidecar-compact-only/u);
  assert.match(shell, /\[animatedNavigationWidth, animatedSidebarWidth, sidebarProgress\]/u);
  assert.match(block(styles, '.app-shell-header::before'), /width: var\(--app-shell-titlebar-extension-width/u);
  assert.match(block(styles, '.app-shell-header::before'), /background: var\(--background-shell-compact-titlebar\)/u);
  assert.match(block(styles, '.app-shell-header::before'), /box-shadow: var\(--opencraft-main-surface-elevation\)/u);
  assert.match(block(styles, '.app-shell-header::before'), /clip-path: inset\(0 0 calc\(-1 \* var\(--height-toolbar\)\) 0\)/u);
  assert.doesNotMatch(block(styles, '.app-shell-header::before'), /transition|animation/u);
  const horizontal = block(styles, '.app-shell-header::after');
  assert.match(horizontal, /height: 1px/u);
  assert.match(horizontal, /opacity: var\(--app-shell-titlebar-divider-progress/u);
  const divider = block(navigation, '.app-shell-sidecar::after');
  assert.match(divider, /inset: var\(--height-toolbar\) 0 0 auto/u);
  assert.match(divider, /pointer-events: none/u);
  const sidecar = block(navigation, ".app-shell-sidecar");
  assert.doesNotMatch(sidecar, /background-image|linear-gradient/u);
  assert.doesNotMatch(sidecar, /::(?:before|after)|padding|border-right/u);
  assert.doesNotMatch(navigation, /\.app-shell-sidecar\s*\+\s*\.main-content-surface/u);
  assert.doesNotMatch(tokens, /--elevation-shell-docked-content/u);
  assert.match(block(styles, ".main-content-surface"), /box-shadow: var\(--opencraft-main-surface-elevation\)/u);
  assert.doesNotMatch(block(styles, ".app-shell-left-panel"), /::after/u);
  assert.match(block(styles, ".app-shell-floating-left-panel__surface"), /box-shadow: var\(--elevation-sidebar\)/u);
});

test("button typography is projected from the registry without changing size geometry", () => {
  const sizes = ["sm", "md", "lg", "toolbar"] as const;
  const roles = ["controlSmall", "control", "controlLarge", "controlCompact"] as const;
  assert.deepEqual(sizes.map(size => buttonSizeMetrics[size].height), [32, 40, 44, 32]);
  assert.deepEqual(sizes.map(size => buttonSizeMetrics[size].horizontalPadding), [12, 16, 24, 8]);
  sizes.forEach((size, index) => {
    const role = typographyRole(roles[index], "native");
    assert.equal(buttonSizeMetrics[size].fontSize, role.fontSize);
    assert.equal(buttonSizeMetrics[size].lineHeight, role.lineHeight);
    assert.equal(buttonSizeMetrics[size].fontWeight, role.fontWeight);
  });
});

test("shared Web controls cannot introduce their own typography metrics", () => {
  const button = read("../packages/design-system-web/src/button.web.scss");
  assert.doesNotMatch(button, /font(?:-size|-family)?\s*:|line-height\s*:/u);
  assert.match(button, /font-weight: var\(--typography-primary-action-weight\)/u);
  assert.match(button, /typography\.role\(control/u);
  const settings = read("../apps/workbench-web/src/styles/app.scss");
  for (const selector of [".settings-control-page-header", ".settings-control-section__copy", ".settings-control-row__label", ".settings-control-row__description", ".settings-control-select-shell"]) {
    const rules = block(settings, selector);
    assert.match(rules, /typography\.role\(/u, selector);
    assert.doesNotMatch(rules, /font(?:-size|-weight|-family)?\s*:|line-height\s*:/u, selector);
  }
});

test("shared controls keep theme-owned focus, disabled and invalid states", () => {
  const button = read("../packages/design-system-web/src/button.web.scss");
  const settings = read("../apps/workbench-web/src/styles/app.scss");
  for (const source of [button]) {
    assert.match(source, /controls\.focus-indicator/u);
    assert.match(source, /controls\.disabled-feedback/u);
  }
  const input = block(settings, ".settings-control-select-shell");
  assert.match(input, /border-color: var\(--color-border-focus\)/u);
  assert.match(input, /controls\.disabled-feedback/u);
  assert.match(input, /forced-colors: active/u);
  assert.doesNotMatch(input, /controls\.focus-indicator/u);
  assert.match(settings, /:has\(\.settings-control-select\[aria-invalid="true"\]\)/u);
  assert.match(block(settings, ".settings-control-select-shell"), /controls\.invalid-feedback/u);
  const states = read("../packages/design-system/src/controls.web.scss") + read("../packages/design-system/src/interaction-mixins.web.scss");
  assert.match(states, /forced-colors: active/u);
  assert.match(states, /var\(--color-border-focus\)/u);
  assert.match(states, /var\(--opacity-control-disabled\)/u);
  assert.match(states, /var\(--color-text-danger\)/u);
});

test("loading retains its label footprint and respects reduced motion", () => {
  const button = read("../packages/design-system-web/src/button.web.scss");
  assert.match(block(button, ".ui-button__spinner"), /position: absolute/u);
  assert.match(block(button, ".ui-button__spinner"), /prefers-reduced-motion: reduce/u);
  assert.match(button, /\[data-control-loading="true"\] \.ui-button__label \{ opacity: 0;/u);
});

test("list action styling cannot repaint a switch's state or touch target", () => {
  const source = read("../apps/workbench-web/src/styles/app.scss");
  assert.match(block(source, ".settings-control-list-item__actions"), /> button:not\(\.settings-control-button\):not\(\.settings-control-switch\)/);
  const toggle = block(source, ".settings-control-switch");
  assert.match(toggle, /width: max\(36px, var\(--size-control-hit-min\)\);/);
  assert.match(toggle, /height: max\(20px, var\(--size-control-hit-min\)\);/);
  assert.match(toggle, /\[aria-checked="true"\][\s\S]*background: var\(--color-accent-blue\)/);
});
