import assert from "node:assert/strict";
import test from "node:test";
import { requiredStartupModule, startupResourceBudget, startupJavaScriptChunkBudget, startupResourceViolations } from "../../apps/workbench-web/startup-resource-policy.vite";
const report = (module: string, critical = true) => ({ critical: critical ? ["main.js"] : [], chunks: [{ file: "main.js", modules: [module] }], totals: { javascript: 1, css: 1, gzip: 1 } });
test("startup gates reject on-demand modules even when byte budgets are met", () => {
  for (const module of ["opencraft/packages/chat-render-web/src/renderers/visualization/visualization.tsx", "opencraft/packages/chat-render-web/src/renderers/visualization/sandbox.ts", "opencraft/apps/workbench-web/src/components/modal/adaptive-sheet-handle.tsx", "opencraft/packages/chat-render-web/src/extensions/katex/katex-math.tsx", "opencraft/node_modules/parse5/dist/index.js", "opencraft/node_modules/acorn/dist/acorn.mjs", "opencraft/plugins/cloud-desktop/src/panel.tsx"]) {
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
