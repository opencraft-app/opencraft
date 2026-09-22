import type { OpenCraftExtensionDefinition } from "@opencraft/extension-contract";

/** A real public contribution that exercises registration, selection and unload. */
export const BuiltinThemePackExtension: OpenCraftExtensionDefinition = {
  manifest: {
    manifestVersion: 1,
    id: "vela.theme-pack",
    name: "OpenCraft Theme Pack",
    description: "Optional semantic palettes for the OpenCraft workbench.",
    version: "1.0.0",
    apiVersion: 1,
    trust: "trusted",
    platforms: ["web", "electron", "expo"],
    activationEvents: ["onStartupFinished"],
  },
  activate(api) {
    api.themes.register({
      id: "vela.theme-pack.paper",
      label: "Paper",
      description: "A warmer, softer work surface with the same Codex contrast model.",
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
    });
  },
};
