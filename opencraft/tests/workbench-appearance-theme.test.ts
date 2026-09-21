import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionContributionStore } from "@opencraft/extension-runtime";
import {
  buildCodexThemeCssProperties,
  codexThemePalette,
  velaThemePalette,
} from "@opencraft/design-system/theme-engine";

test("utility controls receive semantic status colors in both themes and accept theme overrides", () => {
  for (const mode of ["light", "dark"] as const) {
    for (const definition of [codexThemePalette[mode], velaThemePalette[mode]]) {
      const css = buildCodexThemeCssProperties(mode, definition);
      for (const key of ["--color-text-warning", "--color-text-danger", "--color-status-success", "--color-usage-track", "--color-dialog-scrim", "--elevation-dialog-utility"]) {
        assert.ok(css[key], `${mode} must define ${key}`);
      }
    }
    const custom = buildCodexThemeCssProperties(mode, {
      ...codexThemePalette[mode], semanticColors: { ...codexThemePalette[mode].semanticColors, warning: "#9b4a00", error: "#b42318", success: "#18743b" },
    });
    assert.equal(custom["--color-text-warning"], "#9b4a00");
    assert.equal(custom["--color-text-danger"], "#b42318");
    assert.equal(custom["--color-status-success"], "#18743b");
  }
});

test("Vela defines a web-native shell material without changing the Codex fallback", () => {
  const vela = buildCodexThemeCssProperties("light", velaThemePalette.light);
  const extensionCompatible = buildCodexThemeCssProperties("light", {
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

  assert.equal(vela["--codex-sidebar-material-background"], "#ffffff");
  assert.equal(vela["--codex-sidebar-material-filter"], "none");
  assert.equal(vela["--codex-window-highlight"], "none");
  assert.equal(vela["--codex-main-surface-elevation"], "-0.5px 0 0 rgb(0 0 0 / 5%)");
  assert.match(extensionCompatible["--codex-sidebar-material-background"], /color-mix/u);
  assert.equal(extensionCompatible["--codex-sidebar-material-filter"], "blur(28px) saturate(145%)");
});

test("extension theme selection is root-owned and unload falls back atomically", async () => {
  const stored = new Map<string, string>();
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
        },
      },
      querySelector: () => ({
        setAttribute: (_name: string, value: string) => { metaColor = value; },
      }),
    },
  });
  Object.defineProperty(globalThis, "opencraftDesktop", {
    configurable: true,
    value: {
      setWindowAppearance: (appearance: unknown) => desktopAppearances.push(appearance),
    },
  });

  try {
    const appearance = await import("../apps/workbench-web/src/appearance-theme.ts");
    assert.equal(appearance.defaultAppearanceThemeId("lightvela-web"), appearance.velaThemeId);
    assert.equal(appearance.defaultAppearanceThemeId("opencraft"), appearance.coreThemeId);
    appearance.initializeAppearanceTheme();
    assert.equal(dataset.themeId, appearance.coreThemeId);
    assert.deepEqual(
      appearance.getAppearanceThemeSnapshot().availableThemes.slice(0, 2).map(({ label }) => label),
      ["Codex", "Vela"],
    );
    assert.equal(properties.get("--codex-base-surface"), "#ffffff");
    assert.deepEqual(desktopAppearances.at(-1), {
      themeSource: "light",
      resolvedTheme: "light",
    });

    appearance.setThemePreference("dark");
    assert.deepEqual(desktopAppearances.at(-1), {
      themeSource: "dark",
      resolvedTheme: "dark",
    });
    appearance.setThemePreference("light");

    appearance.setAppearanceThemeId(appearance.velaThemeId);
    assert.equal(dataset.themeId, appearance.velaThemeId);
    assert.equal(properties.get("--codex-sidebar-material-background"), "#ffffff");
    assert.equal(properties.get("--codex-sidebar-material-filter"), "none");
    appearance.setAppearanceThemeId(appearance.coreThemeId);
    assert.equal(properties.get("--codex-sidebar-material-filter"), "blur(28px) saturate(145%)");

    const contributions = new ExtensionContributionStore();
    const disconnect = appearance.connectAppearanceThemeContributions(contributions);
    const owner = {
      extensionId: "vela.test-theme",
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
        id: "vela.test-theme.paper",
        label: "Paper",
        palettes: {
          light: {
            accent: "#3478f6",
            contrast: 46,
            ink: "#202124",
            surface: "#fbfaf7",
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

    appearance.setAppearanceThemeId("vela.test-theme.paper");
    assert.equal(dataset.themeId, "vela.test-theme.paper");
    assert.equal(properties.get("--codex-base-surface"), "#fbfaf7");
    assert.equal(metaColor, "#fbfaf7");

    contributions.removeOwner(owner);
    const fallback = appearance.getAppearanceThemeSnapshot();
    assert.equal(fallback.requestedThemeId, "vela.test-theme.paper");
    assert.equal(fallback.themeId, appearance.coreThemeId);
    assert.equal(dataset.themeId, appearance.coreThemeId);
    assert.equal(properties.get("--codex-base-surface"), "#ffffff");

    disconnect();
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
