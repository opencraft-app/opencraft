import assert from "node:assert/strict";
import test from "node:test";
import { validateThemeOptions } from "@opencraft/design-system/theme-options";
import { buildCodexThemeCssProperties as build, codexThemePalette, velaThemePalette } from "@opencraft/design-system/theme-engine";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { isWindowAppearanceMessage, resolveWindowAppearance } from "../apps/workbench-electron/src/window-appearance";

test("optional theme surfaces override only named semantic roles and reset to defaults", () => {
  for (const mode of ["light", "dark"] as const) {
    const base = codexThemePalette[mode];
    const defaults = build(mode, base);
    const themed = build(mode, { ...base,
      surfaces: { window: "#111111", sidebar: "#222222", panel: "#333333", input: "#444444", popover: "#555555" },
      material: { window: "opaque", elevation: "flat" },
    });
    assert.equal(themed["--codex-window-material"], "#111111");
    assert.equal(themed["--codex-sidebar-material-background"], "#222222");
    assert.equal(themed["--codex-sidebar-material-filter"], "none");
    assert.equal(themed["--codex-main-surface-elevation"], "none");
    assert.equal(themed["--color-background-panel"], "#333333");
    assert.equal(themed["--color-background-input"], "#444444");
    assert.equal(themed["--color-background-elevated-primary-opaque"], "#555555");
    assert.equal(themed["--color-text"], defaults["--color-text"]);
    assert.deepEqual(build(mode, { ...base, surfaces: {}, material: {} }), defaults);
    assert.equal(build(mode, velaThemePalette[mode])["--codex-sidebar-material-filter"], "none");
    assert.equal(build(mode, { ...base, opaqueWindows: true })["--codex-sidebar-material-filter"], "none");
  }
});

test("theme options reject arbitrary CSS and unknown configuration", () => {
  for (const surfaces of [null, [], {panel:"url(https://example.test)"}, {input:"red"}, {selector:"#ffffff"}, {panel:123}]) assert.throws(()=>validateThemeOptions(surfaces,undefined));
  for (const material of [null, [], {window:"blur(20px)"}, {elevation:"huge"}, {css:"none"}]) assert.throws(()=>validateThemeOptions(undefined,material));
});

test("native policy retains blur safety, respects opaque themes and accepts old renderer messages", () => {
  for (const resolvedTheme of ["light","dark"] as const) {
    const message = {themeSource:"system" as const,resolvedTheme,backgroundColor:"#123456",opaqueWindows:false};
    assert.equal(isWindowAppearanceMessage(message),true);
    assert.deepEqual(resolveWindowAppearance(message,"darwin",true),{backgroundColor:"#00000000",vibrancy:"menu"});
    for (const focused of [true,false]) {
      assert.deepEqual(resolveWindowAppearance({...message,opaqueWindows:true},"darwin",focused),{backgroundColor:"#123456",vibrancy:null});
      assert.deepEqual(resolveWindowAppearance(message,"win32",focused),{backgroundColor:"#123456",vibrancy:null});
    }
    assert.deepEqual(resolveWindowAppearance(message,"darwin",false),{backgroundColor:"#123456",vibrancy:null});
  }
  assert.equal(isWindowAppearanceMessage({themeSource:"light",resolvedTheme:"light"}),true);
  assert.equal(isWindowAppearanceMessage({themeSource:"light",resolvedTheme:"light",backgroundColor:"transparent"}),false);
  assert.equal(isWindowAppearanceMessage({themeSource:"light",resolvedTheme:"light",opaqueWindows:"yes"}),false);
});

test("extension palettes freeze nested options and reject invalid activation atomically", async () => {
  const supervisor = new ExtensionSupervisor({platform:"web"});
  const surfaces={panel:"#eeeeee"};
  const material={window:"opaque" as const};
  const definition=(bad=false)=>({manifest:{manifestVersion:1 as const,id:"vela.theme-test",name:"Theme test",version:"1.0.0",apiVersion:1 as const,trust:"trusted" as const,platforms:["web" as const],activationEvents:["onStartupFinished"]},activate(api: any){
    api.commands.register({id:"vela.theme-test.command",title:"Test"},()=>{});
    api.themes.register({id:"vela.theme-test.palette",label:"Theme",palettes:{light:{...codexThemePalette.light,surfaces:bad?{panel:"url(x)"}:surfaces,material},dark:codexThemePalette.dark}});
  }});
  await assert.rejects(supervisor.activate(definition(true)),/Invalid theme surface/u);
  assert.equal(supervisor.contributions.getSnapshot().themes.length,0);
  assert.equal(supervisor.contributions.getSnapshot().commands.length,0);
  await supervisor.activate(definition());
  const palette=supervisor.contributions.getSnapshot().themes[0]!.contribution.palettes.light;
  surfaces.panel="#000000";
  assert.equal(palette.surfaces!.panel,"#eeeeee");
  assert.ok(Object.isFrozen(palette.surfaces)); assert.ok(Object.isFrozen(palette.material));
  await supervisor.dispose();
});
