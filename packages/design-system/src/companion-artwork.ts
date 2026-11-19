import type { ActionShape } from "./action-artwork";

/** Original companion artwork. v1 selection is identity-derived, never render-time random.
 * Geometry is shared by Web/native; renderers own SVG elements and theme selection. */
export const companionKinds = ["bean", "sprout", "bun", "lamp", "cloud", "star"] as const;
export type CompanionKind = (typeof companionKinds)[number];
export const companionPalettes = {
  peach: { light: ["#FBEAE2", "#EEAE91", "#512F29"], dark: ["#382B29", "#E8A98E", "#472820"] },
  sage: { light: ["#E8F1E9", "#A8C9AD", "#253E31"], dark: ["#25362F", "#A2C4A8", "#20392B"] },
  honey: { light: ["#F7EED8", "#E8C67B", "#4C3A1F"], dark: ["#393222", "#DDC07C", "#40301B"] },
  lilac: { light: ["#EFEAF8", "#C4B2E6", "#3C3155"], dark: ["#302B40", "#BDACE0", "#342B4A"] },
  sky: { light: ["#E4EFF6", "#A4C8DF", "#294051"], dark: ["#253440", "#A0C2D8", "#243A49"] },
  rose: { light: ["#F6E7ED", "#E4ADBF", "#512D3C"], dark: ["#3B2932", "#DFA8BB", "#462534"] },
} as const;
export type CompanionPalette = keyof typeof companionPalettes;
export interface CompanionIdentity {
  version: 1;
  kind: CompanionKind;
  palette: CompanionPalette;
}
export function companionIdentity(id: string): CompanionIdentity {
  // Separate salts keep outline and colour independent. Keep v1 stable for old identities.
  const hash = (salt: string) => {
    let value = 2166136261;
    for (const char of salt + id) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
    return value;
  };
  const colours = Object.keys(companionPalettes) as CompanionPalette[];
  return {
    version: 1,
    kind: companionKinds[hash("shape/v1:") % companionKinds.length]!,
    palette: colours[hash("colour/v1:") % colours.length]!,
  };
}
export function companionScene(identity: CompanionIdentity, theme: "light" | "dark" = "light"): CompanionScene {
  const [background, body, ink] = companionPalettes[identity.palette][theme];
  const surface: ActionShape[] = [],
    figure: ActionShape[] = [],
    eyes: ActionShape[] = [],
    expression: ActionShape[] = [];
  let result = surface;
  const shape = (tag: ActionShape["tag"], attributes: Record<string, string | number>) =>
    result.push({ tag, attributes });
  const path = (d: string, fill = body) => shape("path", { d, fill });
  const stroke = (d: string, width = 2.3) =>
    shape("path", {
      d,
      fill: "none",
      stroke: ink,
      strokeWidth: width,
      strokeLinecap: "round",
      strokeLinejoin: "round",
    });
  shape("rect", { width: 80, height: 80, rx: 26, fill: background });
  result = figure;
  let eyeY = 42;
  switch (identity.kind) {
    case "bean":
      path("M56 19c12 7 14 25 4 38S31 70 21 59C10 46 22 38 27 27c5-12 17-15 29-8Z");
      stroke("M22 48q-5 0-7-4M60 48q5-1 6-6");
      break;
    case "sprout":
      path("M17 47c0-13 10-22 23-22s23 9 23 22c0 15-10 21-23 21S17 62 17 47Z");
      stroke("M40 28V17", 2.5);
      path("M40 22C27 23 23 14 24 10c10-1 18 3 16 12Z");
      path("M40 20c0-11 9-15 17-12 0 9-7 14-17 12Z");
      eyeY = 45;
      break;
    case "bun":
      path("M13 49c0-17 12-31 27-31s27 14 27 31c0 13-11 18-27 18S13 62 13 49Z");
      stroke("M31 21l3 7m6-9v8m9-6-3 7", 2);
      eyeY = 45;
      break;
    case "lamp":
      path("M25 63h30l-4-12H29Z");
      path("M40 16c-15 0-23 11-23 23 0 9 8 15 23 15s23-6 23-15c0-12-8-23-23-23Z");
      stroke("M35 64h10", 2.5);
      shape("path", {
        d: "M12 22l-3-3m62 0-3 3M40 8V5",
        fill: "none",
        stroke: body,
        strokeWidth: 2.5,
        strokeLinecap: "round",
      });
      eyeY = 36;
      break;
    case "cloud":
      path("M22 61C8 61 7 43 17 38c-4-13 11-23 21-15 8-13 26-6 26 7 16 0 18 27 2 30-13 3-29 1-44 1Z");
      eyeY = 43;
      break;
    case "star":
      path("M35 16q5-8 10 0l7 12 14 2q10 1 4 10l-9 11 2 14q1 10-9 6l-14-7-14 7q-10 4-9-6l2-14-9-11q-6-9 4-10l14-2Z");
      break;
  }
  result = eyes;
  shape("ellipse", { cx: 31, cy: eyeY, rx: 2.2, ry: 3.1, fill: ink });
  shape("ellipse", { cx: 49, cy: eyeY, rx: 2.2, ry: 3.1, fill: ink });
  result = expression;
  stroke(`M36 ${eyeY + 7}q4 4 8 0`, 2);
  // Small blush without extra colours; legible at 24px and no status-colour meaning.
  shape("ellipse", { cx: 25, cy: eyeY + 5, rx: 3.8, ry: 2, fill: ink, opacity: 0.12 });
  shape("ellipse", { cx: 55, cy: eyeY + 5, rx: 3.8, ry: 2, fill: ink, opacity: 0.12 });
  return { surface, figure, eyes, expression, eyeY };
}

export interface CompanionScene {
  surface: ActionShape[];
  figure: ActionShape[];
  eyes: ActionShape[];
  expression: ActionShape[];
  eyeY: number;
}
/** Original flat API stays stable for existing native and image consumers. */
export function companionArtwork(identity: CompanionIdentity, theme: "light" | "dark" = "light"): ActionShape[] {
  const scene = companionScene(identity, theme);
  return [...scene.surface, ...scene.figure, ...scene.eyes, ...scene.expression];
}
