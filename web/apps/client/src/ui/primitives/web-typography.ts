import type {CSSProperties} from "react";

type CrossPlatformTypography = CSSProperties & {
  lineHeight?: number | string;
};

/**
 * React Native treats numeric line heights as device pixels. CSS treats a
 * unitless number as a multiplier, so raw typography tokens must cross this
 * adapter before they are applied to a DOM element.
 */
export function webTypography(
  typography: CrossPlatformTypography,
): CSSProperties {
  const cssLineHeight: keyof CSSProperties = "lineHeight";
  return {
    ...typography,
    [cssLineHeight]: typeof typography.lineHeight === "number"
      ? `${typography.lineHeight}px`
      : typography.lineHeight,
  };
}
