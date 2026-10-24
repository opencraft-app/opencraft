import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { appearanceBootstrap } from "../../apps/workbench-web/appearance-bootstrap.vite";
import { builtinAppearanceThemes } from "../../apps/workbench-web/src/appearance-catalog";
import { resolveWorkbenchPresentation } from "../../apps/workbench-web/src/workbench-presentation";
import { readWindowPresentation, resolveWindowPresentation } from "../../apps/workbench-web/src/runtime/window-presentation";
import { projectWindowAppearance, resolveWindowAppearanceIntent } from "../../apps/workbench-web/src/runtime/window-appearance";

function fixture(values: Record<string, string> = {}, dark = false, overlay = true) {
  const properties = new Map<string, string>();
  const style = { colorScheme: "", backgroundColor: "", setProperty: (key: string, value: string) => properties.set(key, value) };
  let meta = "initial";
  const view: any = { navigator: {}, matchMedia: (query: string) => ({ matches: query.includes("prefers-color-scheme") && dark }),
    localStorage: { getItem: (key: string) => values[key] ?? null, setItem: () => { throw Error("bootstrap must not write preferences"); } } };
  view.top = view;
  const document: any = { defaultView: view, documentElement: { style, dataset: {}, classList: { add() {} } },
    querySelector: (selector: string) => selector.includes("apple-mobile-web-app-status-bar-style")
      ? overlay ? {} : null
      : ({ setAttribute: (_key: string, value: string) => { meta = value; } }) };
  return { document, view, properties, meta: () => meta };
}
function bootstrap(policy = {}) {
  const plugin = appearanceBootstrap(resolveWorkbenchPresentation(policy));
  const hook = plugin.transformIndexHtml as { handler: (html: string) => string };
  return hook.handler("/* OPENCRAFT_BOOTSTRAP_APPEARANCE */");
}

test("host, display mode and system appearance authority are independent", () => {
  assert.equal(resolveWindowPresentation({ standalone: true }).appearanceControl, "document-and-hint");
  assert.equal(resolveWindowPresentation({ host: "electron" }).appearanceControl, "native-bridge");
  assert.equal(resolveWindowPresentation({ host: "native-container", standalone: true }).appearanceControl, "host-owned");
  assert.equal(resolveWindowPresentation({ host: "embedded", fullscreen: true }).displayMode, "fullscreen");
  const { view } = fixture(); view.navigator.standalone = true;
  assert.equal(readWindowPresentation(view).displayMode, "standalone");
  view.top = {}; assert.equal(readWindowPresentation(view).host, "embedded");
  view.top = view; view.opencraftMobile = {}; view.ReactNativeWebView = { postMessage() {} };
  assert.equal(readWindowPresentation(view).host, "browser", "an invalid bridge identity is not a native container");
});

test("generated head bootstrap paints every built-in before the application loads", () => {
  const source = bootstrap(); assert.ok(!source.includes("OPENCRAFT_BOOTSTRAP_APPEARANCE"));
  for (const entry of builtinAppearanceThemes) for (const mode of ["light", "dark"] as const) {
    const f = fixture({ "opencraft.appearance-theme-id": entry.descriptor.id, "opencraft.appearance-theme": mode });
    vm.runInNewContext(source, { document: f.document });
    assert.equal(f.document.documentElement.style.backgroundColor, entry.palettes[mode].surface, `${entry.descriptor.id}/${mode}`);
    assert.equal(f.meta(), entry.palettes[mode].surface);
    assert.equal(f.document.documentElement.dataset.windowAppearancePhase, "bootstrap");
  }
});

test("bootstrap shares visibility, defaults, aliases, key precedence and system mode", () => {
  const f = fixture({ "opencraft.appearance-theme-id": "  vela.core.lavender  ", "opencraft.appearance-theme": "system", "vela.appearance-theme": "light" }, true);
  vm.runInNewContext(bootstrap(), { document: f.document });
  assert.equal(f.meta(), builtinAppearanceThemes.find(e => e.descriptor.id.endsWith(".lavender"))!.palettes.dark.surface);
  const hidden = fixture({ "opencraft.appearance-theme-id": "opencraft.core.mist" });
  vm.runInNewContext(bootstrap({ defaultThemeId: "opencraft.core.canvas", hiddenBuiltinThemeIds: ["opencraft.core.mist"] }), { document: hidden.document });
  assert.equal(hidden.meta(), builtinAppearanceThemes.find(e => e.descriptor.id.endsWith(".canvas"))!.palettes.light.surface);
  assert.equal(hidden.document.documentElement.dataset.windowAppearancePhase, "fallback");
});

test("unknown plugin preferences and denied storage do not persist a fallback", () => {
  const f = fixture({ "opencraft.appearance-theme-id": "extension.late" });
  vm.runInNewContext(bootstrap(), { document: f.document });
  assert.equal(f.document.documentElement.dataset.windowAppearancePhase, "fallback");
  f.view.localStorage.getItem = () => { throw Error("denied"); };
  vm.runInNewContext(bootstrap(), { document: f.document });
  assert.equal(f.meta(), builtinAppearanceThemes[0]!.palettes.light.surface);
});

test("Electron window material and document edge remain separate", () => {
  const entry = builtinAppearanceThemes.find(e => e.descriptor.id.endsWith(".longing"))!;
  const intent = resolveWindowAppearanceIntent("system", "light", entry.palettes.light);
  assert.notEqual(intent.backgroundColor, intent.edgeBackgroundColor);
  const f = fixture(); let native: unknown;
  f.view.opencraftDesktop = { kind: "electron", setWindowAppearance: (value: unknown) => { native = value; } };
  const projection = projectWindowAppearance(f.document, intent, readWindowPresentation(f.view), "resolved");
  assert.equal((native as any).backgroundColor, entry.palettes.light.surfaces!.window);
  assert.equal(f.document.documentElement.style.backgroundColor, "", "preserve native window transparency");
  assert.equal(f.properties.get("--shell-window-edge-background"), entry.palettes.light.surface);
  assert.equal(projection.systemAppearance, "unobserved");
});

test("host-owned system bars still permit painting our document", () => {
  const f = fixture(); const intent = resolveWindowAppearanceIntent("light", "light", builtinAppearanceThemes[4]!.palettes.light);
  projectWindowAppearance(f.document, intent, resolveWindowPresentation({ host: "native-container" }), "resolved");
  assert.equal(f.document.documentElement.style.backgroundColor, intent.edgeBackgroundColor);
  assert.equal(f.meta(), "initial", "no invented native appearance capability");
});

test("overlay requests and system color extension are mutually exclusive document policies", () => {
  const f = fixture(); f.view.navigator.standalone = true;
  const intent = resolveWindowAppearanceIntent("light", "light", builtinAppearanceThemes[0]!.palettes.light);
  const overlay = projectWindowAppearance(f.document, intent, readWindowPresentation(f.view), "resolved");
  assert.equal(overlay.edgeStrategy, "legacy-overlay-requested");
  assert.equal(f.document.documentElement.dataset.windowEdgeStrategy, overlay.edgeStrategy);
  assert.equal(overlay.systemAppearance, "unobserved");
  const ordinary = projectWindowAppearance(f.document, intent, resolveWindowPresentation({}), "resolved");
  assert.equal(ordinary.edgeStrategy, "system-color-extension", "the iOS-only request does not turn an ordinary tab into an overlay");
  const fallback = fixture({}, false, false); fallback.view.navigator.standalone = true;
  assert.equal(projectWindowAppearance(fallback.document, intent, readWindowPresentation(fallback.view), "resolved").edgeStrategy, "system-color-extension");
  assert.equal(projectWindowAppearance(f.document, intent, resolveWindowPresentation({ host: "native-container", standalone: true }), "resolved").edgeStrategy, "host-owned");
});


test("an unreadable mode key does not discard a readable saved palette", () => {
  const f = fixture();
  f.view.localStorage.getItem = (key: string) => {
    if (key === "opencraft.appearance-theme") throw Error("denied key");
    return key === "vela.appearance-theme" ? "dark" : key === "opencraft.appearance-theme-id" ? "opencraft.core.lavender" : null;
  };
  vm.runInNewContext(bootstrap(), { document: f.document });
  assert.equal(f.meta(), builtinAppearanceThemes.find(e => e.descriptor.id.endsWith(".lavender"))!.palettes.dark.surface);
});

test("Vite configuration loads in plain Node without a TypeScript loader", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    "import {loadConfigFromFile} from 'vite'; const config=await loadConfigFromFile({command:'serve',mode:'development'},'apps/workbench-web/vite.config.ts'); if(!config)throw Error('configuration missing');"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
});
