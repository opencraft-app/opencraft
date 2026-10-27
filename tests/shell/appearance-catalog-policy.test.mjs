import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

test("theme choices start with the visible product default independently of the saved selection", async () => {
  const cases = [
    [{}, ["Neutral", "Canvas", "Frost", "Longing", "Lavender", "Graphite", "Mist"]],
    [{ defaultThemeId: "opencraft.core.canvas", hiddenBuiltinThemeIds: ["opencraft.core.mist"] }, ["Canvas", "Neutral", "Frost", "Longing", "Lavender", "Graphite"]],
    [{ defaultThemeId: "opencraft.core.frost", hiddenBuiltinThemeIds: ["opencraft.core.neutral"] }, ["Frost", "Canvas", "Longing", "Lavender", "Graphite", "Mist"]],
    [{ defaultThemeId: "extension.paper" }, ["Neutral", "Canvas", "Frost", "Longing", "Lavender", "Graphite", "Mist"]],
    [{ hiddenBuiltinThemeIds: ["neutral", "canvas", "frost", "longing", "lavender", "graphite", "mist"].map(id => `opencraft.core.${id}`) }, ["Neutral"]],
    [{ defaultThemeId: "opencraft.core.zencode" }, ["Graphite", "Neutral", "Canvas", "Frost", "Longing", "Lavender", "Mist"]],
    [{ hiddenBuiltinThemeIds: ["opencraft.core.zencode"] }, ["Neutral", "Canvas", "Frost", "Longing", "Lavender", "Mist"]],
  ];
  for (const [policy, expected] of cases) {
    const { outputFiles } = await build({
      entryPoints: ["apps/workbench-web/src/appearance-theme.ts"], bundle: true,
      format: "iife", globalName: "appearance", platform: "browser", write: false,
      define: { "import.meta.env": JSON.stringify({ VITE_OPENCRAFT_PRESENTATION: JSON.stringify(policy) }), "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    for (const saved of [null, "opencraft.core.frost", "extension.missing", "opencraft.core.zencode"]) {
      const context = vm.createContext({ window: {
        matchMedia: () => ({ matches: false }),
        localStorage: { getItem: key => key === "opencraft.appearance-theme-id" ? saved : null },
      } });
      vm.runInContext(outputFiles[0].text, context);
      const snapshot = context.appearance.getAppearanceThemeSnapshot();
      assert.deepEqual(Array.from(snapshot.availableThemes, theme => theme.label), expected);
      if (saved) {
        const requested = saved.endsWith(".zencode") ? "opencraft.core.graphite" : saved;
        assert.equal(snapshot.requestedThemeId, requested);
        if (requested === "opencraft.core.graphite" && !policy.hiddenBuiltinThemeIds?.includes("opencraft.core.zencode") && !policy.hiddenBuiltinThemeIds?.includes("opencraft.core.graphite")) {
          assert.equal(snapshot.themeId, requested);
        }
      }
    }
  }
});
