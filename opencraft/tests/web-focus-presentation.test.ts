import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compile } from "sass";

const focusSource = new URL("../packages/design-system/src/focus.web.scss", import.meta.url);
const tableSource = new URL("../packages/chat-render-web/src/renderers/table/table-renderer.tsx", import.meta.url);
const tableStyle = new URL("../packages/chat-render-web/src/renderers/table/table.scss", import.meta.url);
const codeSource = new URL("../packages/chat-render-web/src/renderers/code/code-block.scss", import.meta.url);
const previewFocusSource = new URL("../packages/chat-render-web/src/preview-focus-origin.ts", import.meta.url);
const imageSource = new URL("../packages/chat-render-web/src/renderers/media/image-renderer.tsx", import.meta.url);
const mermaidSource = new URL("../packages/chat-render-web/src/extensions/mermaid/mermaid-diagram.tsx", import.meta.url);
const agentConsoleStyle = new URL("../plugins/lightvela-hermes/src/upstream/agent-console.css", import.meta.url);
const connectorSettingsSource = new URL("../plugins/lightvela-hermes/src/connectors/connectors-settings-view.tsx", import.meta.url);

test("Web focus baseline replaces UA outlines with a theme-owned keyboard indicator", () => {
  const css = compile(focusSource.pathname).css;
  assert.match(css, /:where\(:focus\)\s*\{\s*outline:\s*none/u);
  assert.match(css, /:where\(:root:not\(\[data-touch-interaction\]\) :is\([^{}]*\):focus-visible\)\s*\{[^}]*outline:\s*var\(--width-control-focus-ring\) solid var\(--color-border-focus\)/u);
  assert.match(css, /:root\[data-touch-interaction\] :focus-visible\s*\{[^}]*outline:\s*none !important;[^}]*box-shadow:\s*none !important/u);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*outline-color:\s*Highlight/u);
  for (const target of ["button", "input", "textarea", "summary", "[tabindex]"]) {
    assert.ok(css.includes(target), `${target} must be covered by the authored focus baseline`);
  }
});

test("Markdown table does not focus its wrapper while scrollable code keeps a custom focus ring", () => {
  const table = readFileSync(tableSource, "utf8");
  const tableCss = compile(tableStyle.pathname).css;
  const code = readFileSync(codeSource, "utf8");
  assert.match(table, /className="chat-table-container"/u);
  assert.doesNotMatch(table, /className="chat-table-container"[^>]*tabIndex/u);
  assert.match(tableCss, /\.chat-table-scroller\s*\{[^}]*outline:\s*none/u);
  assert.match(tableCss, /:root:not\(\[data-touch-interaction\]\) \.chat-table-scroller:focus-visible\s*\{[^}]*box-shadow:/u);
  assert.match(code, /\.chat-code-block__scroller\s*\{[\s\S]*?&:focus-visible\s*\{\s*box-shadow:/u);
});

test("pointer-opened native previews share focus origin until keyboard navigation", () => {
  const table = readFileSync(tableSource, "utf8");
  const image = readFileSync(imageSource, "utf8");
  const mermaid = readFileSync(mermaidSource, "utf8");
  const origin = readFileSync(previewFocusSource, "utf8");
  const css = compile(focusSource.pathname).css;
  assert.match(origin, /event\.detail > 0 \|\| pointerActivation\.current/u);
  assert.match(origin, /if \(event\.key === "Tab"\) setOpenedByPointer\(false\)/u);
  assert.match(css, /dialog\[data-opened-by-pointer=true\] :focus-visible\s*\{[^}]*outline:\s*none !important;[^}]*box-shadow:\s*none !important/u);
  for (const preview of [table, image, mermaid]) {
    assert.match(preview, /usePreviewFocusOrigin\(\)/u);
    assert.match(preview, /data-opened-by-pointer=/u);
    assert.match(preview, /onPointerDown=/u);
    assert.match(preview, /onPreviewKeyDown/u);
  }
});

test("embedded Agent Console focus-within and legacy glows honor touch mode", () => {
  const css = readFileSync(agentConsoleStyle, "utf8");
  assert.match(css, /:root\[data-touch-interaction\] \.lightvela-agent-console \.lv-option:focus-within\s*\{\s*outline:\s*none/u);
  assert.match(css, /:root\[data-touch-interaction\] \._lh-claw-bot-panel \.tea-input:focus-within/u);
  assert.match(css, /:root\[data-touch-interaction\] \.lh-std-model-panel__json-input:focus\s*\{\s*box-shadow:\s*none/u);
});

test("connector detail modal retains pointer origin until keyboard Tab", () => {
  const source = readFileSync(connectorSettingsSource, "utf8");
  assert.match(source, /dialog\?\.showModal\(\)/u);
  assert.match(source, /setDetailOpenedByPointer\(event\.detail > 0 \|\| pointerActivationRef\.current\)/u);
  assert.match(source, /data-opened-by-pointer=\{detailOpenedByPointer \|\| undefined\}/u);
  assert.match(source, /if \(event\.key === "Tab"\) setDetailOpenedByPointer\(false\)/u);
});
