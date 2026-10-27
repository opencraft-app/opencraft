import { typographyRole } from "./typography/typography.shared";

/**
 * Platform-neutral button contract.
 *
 * Product code chooses intent and size. Web and native renderers own the
 * concrete CSS/Unistyles mapping, interaction feedback, and accessibility.
 */
export const buttonVariantNames = [
  "primary",
  "secondary",
  "outline",
  "ghost",
  "link",
  "destructive",
  "hero",
] as const;

export type ButtonVariant = (typeof buttonVariantNames)[number];

export const buttonSizeNames = ["sm", "md", "lg", "toolbar"] as const;

export type ButtonSize = (typeof buttonSizeNames)[number];

export const defaultButtonVariant: ButtonVariant = "primary";
export const defaultButtonSize: ButtonSize = "md";

export const buttonTypography = {
  sm: typographyRole("controlSmall", "native"),
  md: typographyRole("control", "native"),
  lg: typographyRole("controlLarge", "native"),
  toolbar: typographyRole("controlCompact", "native"),
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
} as const satisfies Record<
  ButtonSize,
  { readonly height: number; readonly horizontalPadding: number; readonly fontSize: number; readonly lineHeight: number }
>;
