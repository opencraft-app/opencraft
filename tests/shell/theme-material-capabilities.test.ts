import { readFileSync } from "node:fs";
import * as sass from "sass";
import { transform } from "lightningcss";
import assert from "node:assert/strict";
import test from "node:test";
import { validateThemeOptions } from "@opencraft/design-system/theme-options";
import { buildOpenCraftThemeCssProperties as build, opencraftNeutralThemePalette, opencraftCanvasThemePalette, frostThemePalette, longingThemePalette } from "@opencraft/design-system/theme-engine";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { isWindowAppearanceMessage, resolveWindowAppearance } from "../../apps/workbench-electron/src/window-appearance";

test("secondary button labels remain readable on both neutral theme surfaces", () => {
  const rgb = (value: string) => value.startsWith('#')
    ? [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16))
    : value.match(/[\d.]+/g)!.map(Number);
  const luminance = (color: number[]) => color.slice(0, 3).map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index]!, 0);
  for (const mode of ['light', 'dark'] as const) {
    const properties = build(mode);
    const surface = rgb(properties['--color-background-surface']!);
    const fill = rgb(properties['--color-background-button-secondary']!);
    const alpha = fill[3] ?? 1;
    const background = fill.slice(0, 3).map((channel, index) => channel * alpha + surface[index]! * (1 - alpha));
    const foreground = rgb(properties['--color-text-button-secondary']!);
    const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
    assert((values[1]! + .05) / (values[0]! + .05) >= 4.5, `${mode}: secondary button contrast`);
  }
});

test("optional theme surfaces override only named semantic roles and reset to defaults", () => {
  for (const mode of ["light", "dark"] as const) {
    const base = opencraftNeutralThemePalette[mode];
    const defaults = build(mode, base);
    const themed = build(mode, { ...base,
      surfaces: { window: "#111111", sidebar: "#222222", panel: "#333333", input: "#444444", popover: "#555555" },
      material: { window: "opaque", elevation: "flat" },
    });
    assert.equal(themed["--opencraft-window-material"], "#111111");
    assert.equal(themed["--opencraft-sidebar-material-background"], "#222222");
    assert.equal(themed["--opencraft-sidebar-material-filter"], "none");
    assert.equal(themed["--opencraft-main-surface-elevation"], "none");
    assert.equal(themed["--color-background-panel"], "#333333");
    assert.equal(themed["--color-background-input"], "#444444");
    assert.equal(themed["--color-background-elevated-primary-opaque"], "#555555");
    assert.equal(themed["--color-text"], defaults["--color-text"]);
    // A registered popover surface is an explicit readable override, not a tint.
    for (const role of ["base", "panel", "menu", "floating"]) {
      assert.equal(themed[`--material-glass-${role}`], "#555555");
    }
    assert.notEqual(defaults["--material-glass-panel"], themed["--material-glass-panel"]);
    assert.deepEqual(build(mode, { ...base, surfaces: {}, material: {} }), defaults);
    assert.equal(build(mode, opencraftCanvasThemePalette[mode])["--opencraft-sidebar-material-filter"], "none");
    assert.equal(build(mode, { ...base, opaqueWindows: true })["--opencraft-sidebar-material-filter"], "none");
  }
});

test("theme options reject arbitrary CSS and unknown configuration", () => {
  for (const surfaces of [null, [], {panel:"url(https://example.test)"}, {input:"red"}, {selector:"#ffffff"}, {panel:123}]) assert.throws(()=>validateThemeOptions(surfaces,undefined));
  for (const material of [null, [], {window:"blur(20px)"}, {elevation:"huge"}, {css:"none"}]) assert.throws(()=>validateThemeOptions(undefined,material));
});

test("native Sidebar shares vibrancy while opaque themes and explicit Sidebar surfaces stay authoritative", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const palette of [opencraftNeutralThemePalette, frostThemePalette, longingThemePalette]) {
      const css = build(mode, palette[mode]);
      assert.equal(css["--opencraft-native-sidecar-background"], "transparent");
      assert.equal(css["--opencraft-native-sidebar-context-background"], "transparent");
      assert.equal(css["--opencraft-native-sidebar-heading-background"], "transparent");
      assert.notEqual(css["--opencraft-sidebar-material-background"], "transparent", "browser retains its independent material");
    }
    for (const definition of [opencraftCanvasThemePalette[mode], { ...opencraftNeutralThemePalette[mode], opaqueWindows: true }]) {
      assert.notEqual(build(mode, definition)["--opencraft-native-sidecar-background"], "transparent");
    }
    const explicit = build(mode, { ...opencraftNeutralThemePalette[mode], surfaces: { sidebar: "#234567" } });
    for (const key of ["--opencraft-native-sidecar-background", "--opencraft-native-sidebar-context-background", "--opencraft-native-sidebar-heading-background"] as const) assert.equal(explicit[key], "#234567");
  }
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
  const definition=(bad=false)=>({manifest:{manifestVersion:1 as const,id:"opencraft.theme-test",name:"Theme test",version:"1.0.0",apiVersion:1 as const,trust:"trusted" as const,platforms:["web" as const],activationEvents:["onStartupFinished"]},activate(api: any){
    api.commands.register({id:"opencraft.theme-test.command",title:"Test"},()=>{});
    api.themes.register({id:"opencraft.theme-test.palette",label:"Theme",palettes:{light:{...opencraftNeutralThemePalette.light,surfaces:bad?{panel:"url(x)"}:surfaces,material},dark:opencraftNeutralThemePalette.dark}});
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

test("release material preserves standard blur and opacity overrides after minification", () => {
  const material = readFileSync(new URL("../../packages/design-system/src/material.web.scss", import.meta.url), "utf8");
  const compiled = sass.compileString(material + "\n.release-material{@include surface;} .opaque-material{@include opaque;}").css;
  const css = transform({filename:"material.css",code:Buffer.from(compiled),minify:true,
    targets:{safari:(16<<16)+(6<<8),chrome:116<<16,firefox:115<<16}}).code.toString();
  const surface = css.match(/\.release-material\{([^}]+)\}/u)?.[1] ?? "";
  assert.match(surface, /(?:^|;)backdrop-filter:var\(--material-backdrop-filter\)/u);
  assert.match(surface, /-webkit-backdrop-filter:var\(--material-backdrop-filter\)/u);
  const opaque = css.match(/\.opaque-material\{([^}]+)\}/u)?.[1] ?? "";
  assert.match(opaque, /(?:^|;)backdrop-filter:none/u);
});
