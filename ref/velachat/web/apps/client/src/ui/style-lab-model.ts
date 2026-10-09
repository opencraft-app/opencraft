export const STYLE_LAB_THEMES = ["light", "dark"] as const;
export type StyleLabTheme = (typeof STYLE_LAB_THEMES)[number];

export const STYLE_LAB_DENSITIES = ["pointer", "touch"] as const;
export type StyleLabDensity = (typeof STYLE_LAB_DENSITIES)[number];

export const STYLE_LAB_INTERACTION_STATES = [
  "idle",
  "hovered",
  "focused",
  "pressed",
  "disabled",
] as const;
export type StyleLabInteractionState =
  (typeof STYLE_LAB_INTERACTION_STATES)[number];

export interface StyleLabMatrixCell {
  density: StyleLabDensity;
  interaction: StyleLabInteractionState;
  theme: StyleLabTheme;
}

export const STYLE_LAB_VISUAL_BASELINES = [
  {
    density: "pointer",
    fileName: "style-lab.light-pointer.png",
    theme: "light",
    viewport: {height: 720, width: 1_280},
  },
  {
    density: "touch",
    fileName: "style-lab.dark-touch.png",
    theme: "dark",
    viewport: {height: 720, width: 1_280},
  },
] as const satisfies ReadonlyArray<{
  density: StyleLabDensity;
  fileName: string;
  theme: StyleLabTheme;
  viewport: {height: number; width: number};
}>;

/** Exhaustive review coordinates; screenshots may not silently skip a state. */
export function buildStyleLabMatrix(): StyleLabMatrixCell[] {
  return STYLE_LAB_THEMES.flatMap((theme) =>
    STYLE_LAB_DENSITIES.flatMap((density) =>
      STYLE_LAB_INTERACTION_STATES.map((interaction) => ({
        density,
        interaction,
        theme,
      })),
    ),
  );
}
