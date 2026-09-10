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

export const buttonSizeNames = ["sm", "md", "lg"] as const;

export type ButtonSize = (typeof buttonSizeNames)[number];

export const defaultButtonVariant: ButtonVariant = "primary";
export const defaultButtonSize: ButtonSize = "md";

/**
 * Shared visual geometry. Native renderers retain a 44pt hit target even when
 * the visible control is compact.
 */
export const buttonSizeMetrics = {
  sm: { height: 32, horizontalPadding: 12, fontSize: 12, lineHeight: 16 },
  md: { height: 40, horizontalPadding: 16, fontSize: 14, lineHeight: 20 },
  lg: { height: 44, horizontalPadding: 24, fontSize: 16, lineHeight: 22 },
} as const satisfies Record<
  ButtonSize,
  { readonly height: number; readonly horizontalPadding: number; readonly fontSize: number; readonly lineHeight: number }
>;
