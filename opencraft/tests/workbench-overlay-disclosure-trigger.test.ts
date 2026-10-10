import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OverlayDisclosureTrigger } from "../apps/workbench-web/src/components/overlay-disclosure-trigger";

test("activity disclosure uses one labelled overlay button, separate from presentation", () => {
  const html = renderToStaticMarkup(createElement(OverlayDisclosureTrigger, {
    className: "test-header",
    contentClassName: "test-content",
    labelId: "test-label",
    onToggle: () => {},
    open: false,
    children: createElement("span", { id: "test-label" }, "Worked for 2 seconds"),
  }));
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*aria-labelledby="test-label"[^>]*><\/button><span/u);
  assert.match(html, /<span id="test-label">Worked for 2 seconds<\/span>/u);
  assert.equal((html.match(/<button\b/gu) ?? []).length, 1);
  assert.ok(html.indexOf("</button>") < html.indexOf("Worked for 2 seconds"));
});

test("non-interactive activity heading does not expose an inert button", () => {
  const html = renderToStaticMarkup(createElement(OverlayDisclosureTrigger, {
    className: "test-header",
    contentClassName: "test-content",
    interactive: false,
    labelId: "test-label",
    onToggle: () => {},
    open: false,
    children: createElement("span", { id: "test-label" }, "Completed"),
  }));
  assert.doesNotMatch(html, /<button\b/u);
  assert.match(html, /Completed/u);
});

test("worked-for, activity rows and activity groups share the same trigger structure", () => {
  const sources = [
    "../apps/workbench-web/src/components/conversation-renderers/activity/work-status.tsx",
    "../apps/workbench-web/src/components/conversation-renderers/activity/activity-disclosure.tsx",
    "../apps/workbench-web/src/components/agent-activity-group-disclosure.tsx",
  ];
  for (const path of sources) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /<OverlayDisclosureTrigger\b/u, path);
  }
});

test("Worked-for touch presentation is stable before the first tap without a pointer fallback", () => {
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  const activity = readFileSync(new URL("../apps/workbench-web/src/components/conversation-renderers/activity/agent-activity-renderers.tsx", import.meta.url), "utf8");
  const touchRule = styles.match(/@media \(any-pointer: coarse\), \(hover: none\) \{\s*\.thread-frame--assistant:has\(\.thread-agent-activity__turn-header\) > \.thread-message-actions \{([^}]+)\}/u)?.[1];
  assert.ok(touchRule);
  assert.match(touchRule, /opacity:\s*1/u);
  assert.match(touchRule, /transition:\s*none/u);
  assert.doesNotMatch(activity, /activity-disclosure-trace|onPointerUp=|onTouchEnd=/u);
});

test("Web controls use app-owned touch feedback instead of Safari tap flash", () => {
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  assert.match(styles, /\*\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent/u);
  assert.match(styles, /\.overlay-disclosure-trigger__hit-target\s*\{[^}]*background:\s*transparent/u);
  assert.match(styles, /\.thread-agent-activity__turn-header\s*\{[\s\S]*?&:focus-visible\s*\{/u);
});
