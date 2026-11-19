import assert from "node:assert/strict";
import test from "node:test";
import { requiredStartupModule, startupResourceBudget, startupJavaScriptChunkBudget, startupResourceViolations } from "../../apps/workbench-web/startup-resource-policy.vite";
const report = (module: string, critical = true) => ({ critical: critical ? ["main.js"] : [], chunks: [{ file: "main.js", modules: [module] }], totals: { javascript: 1, css: 1, gzip: 1 } });
test("scroll-frame sampling and diagnostic export formatting remain demand-only", () => {
  for (const module of ["/repo/packages/timeline-host-web/src/scroll-frame-diagnostics.ts", "/repo/apps/workbench-web/src/runtime-diagnostic-snapshot.ts"]) {
    assert.match(startupResourceViolations(report(module)).join("\n"), /Demand-only/);
    assert.deepEqual(startupResourceViolations(report(module, false)), []);
  }
});
test("conversation icon picker remains outside the startup graph", () => {
  for (const module of ["/repo/apps/workbench-web/src/components/conversation-appearance-picker.tsx", "/repo/packages/design-system-web/src/color-input.tsx", "/repo/packages/design-system-web/src/color-input.web.scss"]) {
    assert.match(startupResourceViolations(report(module)).join("\n"), /Demand-only/);
    assert.deepEqual(startupResourceViolations(report(module, false)), []);
  }
});
test("startup gates reject on-demand modules even when byte budgets are met", () => {
  for (const module of ["/repo/apps/workbench-web/src/components/conversation-search-dialog.tsx", "/repo/apps/workbench-web/src/components/connectors/connector-library.tsx", "/repo/apps/workbench-web/src/components/connectors/connector-native-services.tsx", "/repo/apps/workbench-web/src/components/connectors/connector-setup.tsx", "/repo/apps/workbench-web/src/components/extensions/extension-library.tsx", "opencraft/packages/chat-render-web/src/renderers/visualization/visualization.tsx", "opencraft/packages/chat-render-web/src/renderers/visualization/sandbox.ts", "opencraft/apps/workbench-web/src/components/modal/adaptive-sheet-handle.tsx", "opencraft/packages/chat-render-web/src/extensions/katex/katex-math.tsx", "opencraft/node_modules/parse5/dist/index.js", "opencraft/node_modules/acorn/dist/acorn.mjs", "opencraft/plugins/cloud-desktop/src/panel.tsx"]) {
    assert.equal(startupResourceViolations(report(module)).length, 1, module);
    assert.deepEqual(startupResourceViolations(report(module, false)), [], module);
  }
});
test("trusted product exclusions add to core checks and byte limits", () => {
  const policy = { demandOnlyModules: [/\/sample-provider\/src\/settings\//] };
  const candidate = report("/external/sample-provider/src/settings/view.tsx");
  assert.deepEqual(startupResourceViolations(candidate), []);
  assert.match(startupResourceViolations(candidate, policy).join("\n"), /Demand-only/);
  assert.deepEqual(startupResourceViolations(report(candidate.chunks[0].modules[0], false), policy), []);
  candidate.totals.javascript = startupResourceBudget.javascript + 1;
  assert.match(startupResourceViolations(candidate, policy).join("\n"), /javascript/);
  assert.match(startupResourceViolations(report("/node_modules/parse5/dist/index.js"), policy).join("\n"), /Demand-only/);
});
test("splitting cannot bypass the request fanout budget", () => {
  const files = Array.from({ length: startupJavaScriptChunkBudget + 1 }, (_, index) => `${index}.js`);
  assert.match(startupResourceViolations({ critical: files, chunks: files.map(file => ({ file, modules: [] })), totals: { javascript: 1, css: 1, gzip: 1 } }).join("\n"), /JS chunks/);
});
test("budgets are independent: compression cannot hide parse cost or CSS growth", () => {
  for (const key of Object.keys(startupResourceBudget) as (keyof typeof startupResourceBudget)[]) {
    const candidate = report("opencraft/apps/workbench-web/src/main.tsx"); candidate.totals[key] = startupResourceBudget[key] + 1;
    assert.match(startupResourceViolations(candidate).join("\n"), new RegExp(key));
  }
});

test("HTML bootstrap dynamic main remains a required startup root", () => {
  assert.equal(requiredStartupModule.test("/repo/opencraft/apps/workbench-web/src/main.tsx"), true);
  assert.equal(requiredStartupModule.test("/repo/opencraft/apps/workbench-web/src/workbench-entry.tsx"), true);
  assert.equal(requiredStartupModule.test("/repo/opencraft/plugins/optional/src/main.ts"), false);
});

test("annotation editor and injected page code stay demand-loaded", () => {
  for (const module of [
    "/opencraft/apps/workbench-web/src/browser-annotation/annotation-layer.tsx",
    "/opencraft/apps/workbench-web/src/browser-annotation/screenshot.ts",
    "/opencraft/apps/workbench-web/src/browser-annotation/screenshot-geometry.ts",
    "/opencraft/apps/workbench-web/src/browser-annotation/composer-sink-runtime.tsx",
    "/opencraft/apps/workbench-web/src/browser-annotation/browser-annotation.scss",
    "/opencraft/apps/workbench-web/src/browser-annotation/frame/guest-annotator.ts",
    "/opencraft/apps/workbench-web/src/browser-annotation/frame/frame-source.ts",
    "/opencraft/packages/browser-preview-bridge/src/runtime.ts",
  ]) {
    assert.match(startupResourceViolations(report(module)).join("\n"), /Demand-only/);
    assert.deepEqual(startupResourceViolations(report(module, false)), []);
  }
});

test("optional inline document styles cannot join the startup JS closure", () => {
  for (const module of [
    "/repo/packages/file-preview-web/src/pdf.scss?inline",
    "/repo/plugins/office-preview/src/preview.web.scss?inline",
    "/repo/plugins/structured-preview/src/preview.web.scss?inline",
    "/repo/plugins/image-editor/src/editor.web.scss?inline",
  ]) {
    assert.match(startupResourceViolations(report(module)).join("\n"), /Demand-only/);
    assert.deepEqual(startupResourceViolations(report(module, false)), []);
  }
  assert.deepEqual(startupResourceViolations(report("/repo/packages/file-preview-web/src/preview.web.scss?inline")), []);
});

test("shared file and table preview implementations activate after intent", () => {
  for(const module of ["/repo/packages/file-preview-web/src/file-preview-view.tsx","/repo/packages/chat-render-web/src/renderers/table/table-preview.tsx","/repo/packages/design-system-web/src/preview-surface.tsx"]){
    assert.match(startupResourceViolations(report(module)).join("\n"),/Demand-only/);
    assert.deepEqual(startupResourceViolations(report(module,false)),[]);
  }
});

test('startup sidebar consumers use typography mixins without re-emitting global tokens', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['apps/workbench-web/src/components/applications-sidebar.scss', 'apps/workbench-web/src/components/connectors/connector-panel.scss']) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /typography-mixins\.web/);
    assert.doesNotMatch(source, /typography\.web/);
  }
});

test("desktop media, onboarding, model menu and translated payloads activate on demand", () => {
  for (const module of [
    "/repo/plugins/cloud-desktop/src/session-wire.ts",
    "/repo/plugins/cloud-desktop/src/rfb.ts", "/repo/plugins/cloud-desktop/src/rfb-client.ts",
    "/repo/plugins/cloud-desktop/src/pointer-input.ts", "/repo/plugins/cloud-desktop/src/text-input.ts",
    "/repo/plugins/cloud-desktop/src/clipboard-input.ts", "/repo/plugins/cloud-desktop/src/trackpad-input.ts",
    "/repo/plugins/cloud-desktop/src/frame-preview.ts",
    "/repo/apps/workbench-web/src/components/archived-threads-settings.tsx",
    "/repo/apps/workbench-web/src/components/agent-onboarding.tsx",
    "/repo/apps/workbench-web/src/components/agent-onboarding.scss",
    "/repo/apps/workbench-web/src/components/agent-management.tsx",
    "/repo/apps/workbench-web/src/components/agent-directory.tsx",
    "/repo/apps/workbench-web/src/components/agent-history-import.tsx",
    "/repo/apps/workbench-web/src/i18n/embedded-companion-messages.json",
    "/repo/packages/composer-editor/src/composer-model-menu.tsx",
    "/repo/packages/design-system-web/src/discrete-slider.tsx",
  ]) {
    assert.match(startupResourceViolations(report(module)).join("\n"), /Demand-only/, module);
    assert.deepEqual(startupResourceViolations(report(module, false)), [], module);
  }
});
