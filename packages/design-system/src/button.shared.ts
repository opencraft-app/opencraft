import { typographyRole } from "./typography/typography.shared";

/**
 * Platform-neutral button contract.
 *
 * Product code chooses intent and size. Web and native renderers own the
 * concrete styles, interaction feedback, and accessibility.
 */
export const buttonVariantNames = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "link",
  "destructive",
  "danger",
  "hero",
] as const;

export type ButtonVariant = (typeof buttonVariantNames)[number];

export const buttonSizeNames = ["sm", "md", "lg", "toolbar", "chrome", "navigation", "accessory"] as const;

export type ButtonSize = (typeof buttonSizeNames)[number];

export const defaultButtonVariant: ButtonVariant = "primary";
export const defaultButtonSize: ButtonSize = "md";

export const buttonTypography = {
  sm: typographyRole("controlSmall", "native"),
  md: typographyRole("control", "native"),
  lg: typographyRole("controlLarge", "native"),
  toolbar: typographyRole("controlCompact", "native"),
  chrome: typographyRole("controlCompact", "native"),
  navigation: typographyRole("navigationAction", "native"),
  accessory: typographyRole("controlCompact", "native"),
} as const;

/**
 * Shared visual geometry. Native renderers retain a 44pt hit target even when
 * the visible control is compact.
 */
export const buttonSizeMetrics = {
  sm: { ...buttonTypography.sm, height: 32, horizontalPadding: 12 },
  md: { ...buttonTypography.md, height: 40, horizontalPadding: 16 },
  lg: { ...buttonTypography.lg, height: 44, horizontalPadding: 24 },
  toolbar: { ...buttonTypography.toolbar, height: 32, horizontalPadding: 8 },
  chrome: { ...buttonTypography.chrome, height: 28, horizontalPadding: 0 },
  navigation: { ...buttonTypography.navigation, height: 36, horizontalPadding: 8 },
  accessory: { ...buttonTypography.accessory, height: 28, horizontalPadding: 7 },
} as const satisfies Record<
  ButtonSize,
  { readonly height: number; readonly horizontalPadding: number; readonly fontSize: number; readonly lineHeight: number }
>;

/** Surface belongs to placement; density and input modality remain independent. */
export type ControlSurface = "integrated" | "floating";
export type ButtonContentLayout = "label" | "icon" | "row";
