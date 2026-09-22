import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Embedded Workbench owns one presentation root for theme and overlays", () => {
  const element = read("../apps/workbench-web/src/embedded-chat/embedded-workbench-element.tsx");
  const root = read("../apps/workbench-web/src/embedded-chat/embedded-chat-root.tsx");
  const app = read("../apps/workbench-web/src/app.tsx");
  const draft = read("../apps/workbench-web/src/components/new-thread-draft-page.tsx");
  const presentation = read("../apps/workbench-web/src/components/workbench-presentation-root.tsx");
  const policy = read("../apps/workbench-web/src/workbench-presentation-policy.ts");

  assert.match(presentation, /WorkbenchPresentationRootContext/u);
  assert.match(root, /<WorkbenchPresentationRootProvider target=\{portalContainer\}>/u);
  assert.match(root, /presentation=\{EMBEDDED_CORE_CHAT_PRESENTATION\}/u);
  assert.match(element, /applyAppearanceThemeToElement\(this, getAppearanceThemeSnapshot\(\)\)/u);
  assert.match(app, /portalContainer=\{portalContainer\}/u);
  assert.match(app, /showRightPanelAction=\{conversationSurfaceVisible && presentation\.rightPanel\}/u);
  assert.match(app, /rightPanel=\{!presentation\.rightPanel \? null : \(/u);
  assert.match(app, /presentation\.connectorLauncher \? connectorPresentation\.launcher : null/u);
  assert.match(app, /actionIds=\{presentation\.composerActions\}/u);
  assert.match(policy, /EMBEDDED_CORE_CHAT_PRESENTATION[\s\S]*?rightPanel:\s*false,[\s\S]*?connectorLauncher:\s*false,[\s\S]*?composerActions:\s*Object\.freeze\(\[\]\)/u);
  assert.equal(
    Array.from(draft.matchAll(/<DropdownMenu\.Portal container=\{portalContainer\}>/gu)).length,
    2,
  );
  assert.match(draft, /<CodexComposer[\s\S]*?portalContainer=\{portalContainer\}/u);
});
