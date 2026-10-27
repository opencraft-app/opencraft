import rawRegistry from "./typography.tokens.json";

export type TypographyPlatform = keyof typeof rawRegistry.platforms;
export type TypographyRoleName = keyof typeof rawRegistry.platforms.web.roles;
export type TypographyFamilyName = keyof typeof rawRegistry.families;
export type TypographyWeightName = keyof typeof rawRegistry.weights;
export type TypographyFontWeight = "400" | "500" | "600" | "700";

interface TypographyRegistryShape {
  readonly version: number;
  readonly families: Record<TypographyFamilyName, { readonly web: string; readonly native: string }>;
  readonly weights: Record<TypographyWeightName, number>;
  readonly tracking: typeof rawRegistry.tracking;
  readonly platforms: Record<TypographyPlatform, {
    readonly scales: Record<string, { readonly fontSize: number; readonly lineHeight: number }>;
    readonly roles: Record<TypographyRoleName, {
      readonly family: TypographyFamilyName;
      readonly scale: string;
      readonly weight: TypographyWeightName;
    }>;
  }>;
}

const registry = rawRegistry as unknown as TypographyRegistryShape;

export interface ResolvedTypographyRole {
  readonly family: TypographyFamilyName;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: TypographyFontWeight;
}

export const typographyRegistry = registry;

export function typographyRole(
  role: TypographyRoleName,
  platform: TypographyPlatform,
): ResolvedTypographyRole {
  const platformRegistry = registry.platforms[platform];
  const definition = platformRegistry.roles[role];
  const scale = platformRegistry.scales[definition.scale];
  return Object.freeze({
    family: definition.family,
    fontSize: scale.fontSize,
    lineHeight: scale.lineHeight,
    fontWeight: String(registry.weights[definition.weight]) as TypographyFontWeight,
  });
}

function legacyRole(role: TypographyRoleName, platform: TypographyPlatform) {
  const { family: _family, ...metrics } = typographyRole(role, platform);
  return metrics;
}

export const opencraftTypographyTokens = Object.freeze({
  family: {
    ui: registry.families.ui.native,
    content: registry.families.content.native,
    mono: registry.families.mono.native,
  },
  weight: Object.fromEntries(
    Object.entries(registry.weights).map(([name, value]) => [name, String(value)]),
  ) as Record<TypographyWeightName, TypographyFontWeight>,
  tracking: registry.tracking,
  body: legacyRole("body", "web"),
  chat: legacyRole("chat", "web"),
  composer: legacyRole("composer", "web"),
  modeTitle: legacyRole("modeTitle", "web"),
  toolbarTitle: legacyRole("toolbarTitle", "web"),
  toolbarMeta: legacyRole("toolbarMeta", "web"),
  sidebarAction: legacyRole("navigationAction", "web"),
  sidebarThread: legacyRole("threadTitle", "web"),
  sidebarMeta: legacyRole("metadata", "web"),
  label: legacyRole("label", "web"),
  code: legacyRole("code", "web"),
  disclaimer: legacyRole("disclaimer", "web"),
  emptyTitle: legacyRole("emptyTitle", "web"),
});

export const nativeTypographyTokens = Object.freeze({
  largeTitle: legacyRole("largeTitle", "native"),
  navigationTitle: legacyRole("navigationTitle", "native"),
  navigationMeta: legacyRole("navigationMeta", "native"),
  body: legacyRole("body", "native"),
  chat: legacyRole("chat", "native"),
  composer: legacyRole("composer", "native"),
  sidebarAction: legacyRole("navigationAction", "native"),
  sidebarThread: legacyRole("threadTitle", "native"),
  sidebarMeta: legacyRole("metadata", "native"),
  section: legacyRole("navigationLabel", "native"),
  label: legacyRole("label", "native"),
  code: legacyRole("code", "native"),
  caption: legacyRole("caption", "native"),
  emptyTitle: legacyRole("emptyTitle", "native"),
});

/** Pure platform adapter; callers supply Platform.OS, never import RN here. */
export function nativeMonoFontFamily(platform: string): string {
  const families = rawRegistry.families.mono.nativeByPlatform;
  return families[platform as keyof typeof families] ?? families.default;
}

/** Full Native text style, keeping platform system UI font and mono mapping. */
export function nativeTypographyStyle(role: TypographyRoleName, platform: string) {
  const { family, ...metrics } = typographyRole(role, "native");
  return { ...metrics, ...(family === "mono" ? { fontFamily: nativeMonoFontFamily(platform) } : {}) };
}
