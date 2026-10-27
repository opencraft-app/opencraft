import assert from "node:assert/strict";
import test from "node:test";
import { defaultThemePreference } from "@opencraft/design-system/theme";

import { ExtensionContributionStore } from "@opencraft/extension-runtime";
import {
  buildOpenCraftThemeCssProperties,
  opencraftNeutralThemePalette,
  frostThemePalette,
  longingThemePalette,
  lavenderThemePalette,
  graphiteThemePalette,
  opencraftCanvasThemePalette,
} from "@opencraft/design-system/theme-engine";

let preferenceReadCase = 0;
async function readInitialPreferences(stored: Map<string, string>, options: { unreadable?: readonly string[]; denyWrites?: boolean } = {}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window"), writes: Array<[string, string]> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => { if (options.unreadable?.includes(key)) throw new Error("Storage unavailable"); return stored.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (options.denyWrites) throw new Error("Storage unavailable"); writes.push([key, value]); stored.set(key, value); },
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  } });
  try {
    const appearance = await import(`../../apps/workbench-web/src/appearance-theme.ts?initial-preferences=${++preferenceReadCase}`);
    return { snapshot: appearance.getAppearanceThemeSnapshot(), writes };
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

test("current preferences load without additional writes", async () => {
  const stored = new Map([["opencraft.appearance-theme", "dark"], ["opencraft.appearance-theme-id", "opencraft.core.canvas"]]);
  const { snapshot, writes } = await readInitialPreferences(stored);
  assert.equal(snapshot.preference, "dark"); assert.equal(snapshot.requestedThemeId, "opencraft.core.canvas"); assert.deepEqual(writes, []);
});

test("fresh or explicitly empty current selection does not persist a product default", async () => {
  assert.deepEqual((await readInitialPreferences(new Map())).writes, []);
  const stored = new Map([["opencraft.appearance-theme", "invalid"], ["opencraft.appearance-theme-id", ""]]);
  const { snapshot, writes } = await readInitialPreferences(stored);
  assert.equal(snapshot.preference, defaultThemePreference); assert.equal(snapshot.requestedThemeId, "opencraft.core.neutral"); assert.deepEqual(writes, []);
});

test("unreadable current keys are not overwritten", async () => {
  const stored = new Map([["opencraft.appearance-theme", "dark"], ["opencraft.appearance-theme-id", "opencraft.core.canvas"]]);
  const before = [...stored];
  const { writes } = await readInitialPreferences(stored, { unreadable: ["opencraft.appearance-theme", "opencraft.appearance-theme-id"] });
  assert.deepEqual(writes, []); assert.deepEqual([...stored], before);
});

test("keyboard focus is neutral and independent of brand accent, including legacy aliases", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const base of [opencraftNeutralThemePalette[mode], opencraftCanvasThemePalette[mode], lavenderThemePalette[mode]]) {
      const css = buildOpenCraftThemeCssProperties(mode, base);
      const recolored = buildOpenCraftThemeCssProperties(mode, { ...base, accent: "#ff0088" });
      const focus = css["--color-border-focus"];
      assert.match(focus, mode === "light" ? /^rgba\(0, 0, 0, /u : /^rgba\(255, 255, 255, /u);
      assert.equal(recolored["--color-border-focus"], focus);
      assert.equal(css["--color-focus-ring"], focus);
      assert.equal(css["--focus-ring"], focus);
      assert.equal(css["--color-accent-blue"], base.accent);
    }
  }
});

test("utility controls receive semantic status colors in both themes and accept theme overrides", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const definition of [opencraftNeutralThemePalette[mode], opencraftCanvasThemePalette[mode], frostThemePalette[mode], longingThemePalette[mode], lavenderThemePalette[mode]]) {
      const css = buildOpenCraftThemeCssProperties(mode, definition);
      for (const key of ["--color-text-warning", "--color-text-danger", "--color-status-success", "--color-usage-track", "--color-dialog-scrim", "--elevation-dialog-utility"]) {
        assert.ok(css[key], `${mode} must define ${key}`);
      }
    }
    const custom = buildOpenCraftThemeCssProperties(mode, {
      ...opencraftNeutralThemePalette[mode], semanticColors: { ...opencraftNeutralThemePalette[mode].semanticColors, warning: "#9b4a00", error: "#b42318", success: "#18743b" },
    });
    assert.equal(custom["--color-text-warning"], "#9b4a00");
    assert.equal(custom["--color-text-danger"], "#b42318");
    assert.equal(custom["--color-status-success"], "#18743b");
  }
});

test("badge pairs stay readable across palettes, overridden surfaces and brand accents", () => {
  const luminance = (hex: string) => {
    assert.match(hex, /^#[0-9a-f]{6}$/iu);
    const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  for (const mode of ["light", "dark"] as const) {
    for (const palette of [opencraftNeutralThemePalette, opencraftCanvasThemePalette, frostThemePalette, longingThemePalette, lavenderThemePalette, graphiteThemePalette]) {
      for (const panel of [undefined, "#ffffff", "#101020", "#777777"]) {
        const definition = { ...palette[mode], surfaces: { ...palette[mode].surfaces, ...(panel ? { panel } : {}) } };
        const css = buildOpenCraftThemeCssProperties(mode, definition);
        const recolored = buildOpenCraftThemeCssProperties(mode, { ...definition, accent: "#ff0088" });
        for (const tone of ["blue", "cyan", "red", "indigo", "green", "purple", "orange", "neutral"]) {
          const foregroundKey = `--color-badge-${tone}-foreground` as const;
          const backgroundKey = `--color-badge-${tone}-background` as const;
          const foreground = luminance(css[foregroundKey]!);
          const background = luminance(css[backgroundKey]!);
          const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
          assert.ok(contrast >= 4.5, `${mode}/${tone}/${panel ?? "default"}: ${contrast}`);
          assert.equal(css[foregroundKey], recolored[foregroundKey]);
          assert.equal(css[backgroundKey], recolored[backgroundKey]);
        }
      }
    }
  }
});

test("Graphite uses layered neutral surfaces without changing shared geometry", () => {
  const light = buildOpenCraftThemeCssProperties("light", graphiteThemePalette.light);
  const dark = buildOpenCraftThemeCssProperties("dark", graphiteThemePalette.dark);
  assert.equal(light["--color-background-surface"], "#f8f8f8");
  assert.equal(light["--opencraft-sidebar-material-background"], "#f0f0f0");
  assert.equal(light["--color-background-panel"], "#ffffff");
  assert.equal(dark["--color-background-surface"], "#161616");
  assert.equal(dark["--color-background-panel"], "#202020");
  assert.equal(dark["--color-background-input"], "#2b2b2b");
  assert.equal(dark["--color-background-elevated-primary-opaque"], "#2b2b2b");
  for (const css of [light, dark]) {
    assert.equal(css["--opencraft-sidebar-material-filter"], "none");
    assert.equal(css["--opencraft-main-surface-elevation"], "none");
    assert.ok(Object.keys(css).every(key => !/height|width|font-size/u.test(key)));
  }
});

test("Frost owns a fixed half-opacity cool Sidebar material", () => {
  const light = buildOpenCraftThemeCssProperties("light", frostThemePalette.light);
  const dark = buildOpenCraftThemeCssProperties("dark", frostThemePalette.dark);
  assert.equal(light["--opencraft-sidebar-material-background"], "rgb(226 244 250 / 35%)");
  assert.equal(dark["--opencraft-sidebar-material-background"], "rgb(20 37 46 / 35%)");
  assert.equal(light["--opencraft-sidebar-material-filter"], "blur(28px) saturate(145%)");
  assert.doesNotMatch(light["--opencraft-sidebar-material-background"], /color-mix|calc|var\(/u);
});

test("Lavender projects a complete soft-purple surface hierarchy without geometry", () => {
  const light = buildOpenCraftThemeCssProperties("light", lavenderThemePalette.light);
  const dark = buildOpenCraftThemeCssProperties("dark", lavenderThemePalette.dark);
  assert.equal(light["--opencraft-window-material"], "#f8f6ff");
  assert.equal(light["--opencraft-sidebar-material-background"], "#f1ecff");
  assert.equal(light["--color-background-panel"], "#ffffff");
  assert.equal(light["--color-background-input"], "#f7f4ff");
  assert.equal(light["--color-accent-blue"], "#6d5ce7");
  assert.equal(dark["--opencraft-window-material"], "#17141f");
  assert.equal(dark["--opencraft-sidebar-material-background"], "#1d1828");
  assert.equal(dark["--color-background-panel"], "#221d2e");
  for (const css of [light, dark]) {
    assert.equal(css["--opencraft-sidebar-material-filter"], "none");
    assert.ok(Object.keys(css).every(key => !/height|width|font-size/u.test(key)));
  }
});

test("The canvas theme defines a web-native shell material without changing the neutral fallback", () => {
  const canvas = buildOpenCraftThemeCssProperties("light", opencraftCanvasThemePalette.light);
  const extensionCompatible = buildOpenCraftThemeCssProperties("light", {
    accent: "#3478f6",
    contrast: 46,
    fonts: { code: null, ui: null },
    ink: "#202124",
    opaqueWindows: false,
    semanticColors: {
      diffAdded: "#18864b",
      diffRemoved: "#c13a35",
      skill: "#8457c5",
    },
    surface: "#fbfaf7",
  });

  assert.equal(canvas["--opencraft-sidebar-material-background"], "#ffffff");
  assert.equal(canvas["--opencraft-sidebar-material-filter"], "none");
  assert.equal(canvas["--opencraft-window-highlight"], "none");
  assert.equal(canvas["--opencraft-main-surface-elevation"], "-0.5px 0 0 rgb(0 0 0 / 5%)");
  assert.match(extensionCompatible["--opencraft-sidebar-material-background"], /color-mix/u);
  assert.equal(extensionCompatible["--opencraft-sidebar-material-filter"], "blur(28px) saturate(145%)");
});

test("extension theme selection is root-owned and unload falls back atomically", async () => {
  const stored = new Map<string, string>([["opencraft.appearance-theme", "light"], ["opencraft.appearance-theme-id", "opencraft.core.neutral"]]);
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const classes = new Set<string>();
  let metaColor = "";
  const desktopAppearances: unknown[] = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousDesktopBridge = (
    globalThis as typeof globalThis & { opencraftDesktop?: unknown }
  ).opencraftDesktop;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: {
        dataset,
        classList: {
          toggle(name: string, enabled: boolean) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
        style: {
          colorScheme: "",
          getPropertyValue: (name: string) => properties.get(name) ?? "",
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => { const old = properties.get(name) ?? ""; properties.delete(name); return old; },
        },
      },
      querySelector: (selector: string) => selector.includes('name="theme-color"') ? ({
        setAttribute: (_name: string, value: string) => { metaColor = value; },
      }) : null,
    },
  });
  Object.defineProperty(globalThis, "opencraftDesktop", {
    configurable: true,
    value: {
      setWindowAppearance: (appearance: unknown) => desktopAppearances.push(appearance),
    },
  });

  Object.assign(window, { top: window, navigator: {}, opencraftDesktop: {
    kind: "electron", setWindowAppearance: (appearance: unknown) => desktopAppearances.push(appearance),
  } });
  Object.assign(document, { defaultView: window });

  try {
    const appearance = await import("../../apps/workbench-web/src/appearance-theme.ts");
    assert.equal(stored.get("opencraft.appearance-theme-id"), appearance.coreThemeId);
    assert.equal(stored.get("opencraft.appearance-theme"), "light");
    assert.equal(appearance.defaultAppearanceThemeId({defaultThemeId: appearance.canvasThemeId}), appearance.canvasThemeId);
    assert.equal(appearance.defaultAppearanceThemeId({}), appearance.coreThemeId);
    appearance.initializeAppearanceTheme();
    assert.equal(dataset.themeId, appearance.coreThemeId);
    assert.deepEqual(
      appearance.getAppearanceThemeSnapshot().availableThemes.slice(0, 6).map(({ label }) => label),
      ["Neutral", "Canvas", "Frost", "Longing", "Lavender", "Graphite"],
    );
    assert.equal(appearance.getAppearanceThemeSnapshot().availableThemes.find(theme => theme.id === appearance.graphiteThemeId)?.label, "Graphite");
    assert.equal(properties.get("--opencraft-base-surface"), "#ffffff");
    assert.deepEqual(desktopAppearances.at(-1), {
      themeSource: "light",
      resolvedTheme: "light",
      opaqueWindows: false,
      backgroundColor: "#ffffff",
    });

    appearance.setThemePreference("dark");
    assert.deepEqual(desktopAppearances.at(-1), {
      themeSource: "dark",
      resolvedTheme: "dark",
      opaqueWindows: false,
      backgroundColor: "#181818",
    });
    appearance.setThemePreference("light");

    appearance.setAppearanceThemeId(appearance.graphiteThemeId);
    assert.equal(properties.get("--color-background-surface"), "#f8f8f8");
    assert.equal(appearance.getAppearanceThemePreviewProperties(appearance.graphiteThemeId)["--color-background-panel"], "#ffffff");
    assert.deepEqual(desktopAppearances.at(-1), {themeSource:"light",resolvedTheme:"light",opaqueWindows:true,backgroundColor:"#f8f8f8"});
    appearance.setThemePreference("dark");
    assert.equal(properties.get("--color-background-input"), "#2b2b2b");
    assert.equal(appearance.getAppearanceThemePreviewProperties(appearance.graphiteThemeId)["--color-background-panel"], "#202020");
    appearance.setThemePreference("light");

    appearance.setAppearanceThemeId(appearance.canvasThemeId);
    assert.equal(dataset.themeId, appearance.canvasThemeId);
    assert.equal(stored.get("opencraft.appearance-theme-id"), appearance.canvasThemeId);
    assert.equal(stored.get("opencraft.appearance-theme"), "light");
    appearance.setAppearanceThemeId(appearance.canvasThemeId);
    assert.equal(dataset.themeId, appearance.canvasThemeId);
    assert.equal(properties.get("--opencraft-sidebar-material-background"), "#ffffff");
    assert.equal(properties.get("--opencraft-sidebar-material-filter"), "none");
    assert.deepEqual(desktopAppearances.at(-1), { themeSource: "light", resolvedTheme: "light", opaqueWindows: true, backgroundColor: "#ffffff" });
    appearance.setAppearanceThemeId(appearance.coreThemeId);
    assert.equal(properties.get("--opencraft-sidebar-material-filter"), "blur(28px) saturate(145%)");
    assert.equal(appearance.getAppearanceThemeShellMaterial()?.recessedHeaderBackground, undefined);
    appearance.setAppearanceThemeId(appearance.longingThemeId);
    for (const mode of ["light", "dark"] as const) {
      appearance.setThemePreference(mode);
      assert.equal(appearance.getAppearanceThemeShellMaterial()?.recessedHeaderBackground,
        longingThemePalette[mode].shellMaterial?.recessedHeaderBackground);
      assert.ok(appearance.getAppearanceThemeShellMaterial()?.recessedHeaderBackground);
    }
    appearance.setThemePreference("light");
    appearance.setAppearanceThemeId(appearance.frostThemeId);
    assert.equal(dataset.themeId, appearance.frostThemeId);
    assert.equal(properties.get("--opencraft-sidebar-material-background"), "rgb(226 244 250 / 35%)");
    appearance.setAppearanceThemeId(appearance.lavenderThemeId);
    assert.equal(dataset.themeId, appearance.lavenderThemeId);
    assert.equal(properties.get("--opencraft-sidebar-material-background"), "#f1ecff");
    assert.equal(properties.get("--color-background-input"), "#f7f4ff");
    assert.deepEqual(desktopAppearances.at(-1), { themeSource: "light", resolvedTheme: "light", opaqueWindows: true, backgroundColor: "#f8f6ff" });
    appearance.setAppearanceThemeId(appearance.coreThemeId);

    const contributions = new ExtensionContributionStore();
    const disconnect = appearance.connectAppearanceThemeContributions(contributions);
    const owner = {
      extensionId: "opencraft.test-theme",
      activationId: "theme-activation",
      generation: 1,
    };
    contributions.prepare(owner, {
      commands: [],
      settingsSchemas: [],
      views: [],
      navigation: [],
      sidebarCatalogs: [],
      settingsPages: [],
      workbenchSurfaces: [],
      themes: [{
        id: "opencraft.test-theme.paper",
        label: "Paper",
        palettes: {
          light: {
            accent: "#3478f6",
            contrast: 46,
            ink: "#202124",
            surface: "#fbfaf7",
            surfaces: { window: "#eeeeee", sidebar: "#f0f0f0", panel: "#ffffff", input: "#f8f8f8", popover: "#fafafa" },
            material: { window: "opaque", elevation: "flat" },
            semanticColors: {
              diffAdded: "#18864b",
              diffRemoved: "#c13a35",
              skill: "#8457c5",
            },
          },
          dark: {
            accent: "#6ea8ff",
            contrast: 58,
            ink: "#f2f1ed",
            surface: "#1b1b1a",
            semanticColors: {
              diffAdded: "#55bd82",
              diffRemoved: "#f06b65",
              skill: "#b693ef",
            },
          },
        },
      }],
      bots: [],
    })();

    appearance.setAppearanceThemeId("opencraft.test-theme.paper");
    assert.equal(dataset.themeId, "opencraft.test-theme.paper");
    assert.equal(properties.get("--opencraft-base-surface"), "#fbfaf7");
    assert.equal(metaColor, "#fbfaf7");
    assert.equal(properties.get("--color-background-input"), "#f8f8f8");
    assert.equal(properties.get("--color-background-panel"), "#ffffff");
    assert.equal(properties.get("--color-background-elevated-primary-opaque"), "#fafafa");
    assert.equal(properties.get("--opencraft-sidebar-material-filter"), "none");
    assert.deepEqual(desktopAppearances.at(-1), { themeSource: "light", resolvedTheme: "light", opaqueWindows: true, backgroundColor: "#eeeeee" });

    contributions.removeOwner(owner);
    const fallback = appearance.getAppearanceThemeSnapshot();
    assert.equal(fallback.requestedThemeId, "opencraft.test-theme.paper");
    assert.equal(fallback.themeId, appearance.coreThemeId);
    assert.equal(dataset.themeId, appearance.coreThemeId);
    assert.equal(properties.get("--opencraft-base-surface"), "#ffffff");

    disconnect();
    assert.equal(properties.get("--color-background-input"), buildOpenCraftThemeCssProperties("light")["--color-background-input"]);
    assert.equal(properties.get("--opencraft-sidebar-material-filter"), "blur(28px) saturate(145%)");
    contributions.close();
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
    Object.defineProperty(globalThis, "opencraftDesktop", {
      configurable: true,
      value: previousDesktopBridge,
    });
  }
});
