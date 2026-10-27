import React, { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import {
  defaultButtonSize, defaultButtonVariant,
  type ButtonSize, type ButtonVariant, type ButtonContentLayout, type ControlSurface,
} from "@opencraft/design-system/button";
import { LoadingRingIcon } from "./action-icons";
import { LiquidGlassBackdrop } from "./liquid-glass";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly children: ReactNode;
  readonly loading?: boolean;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  readonly density?: "default" | "compact";
  readonly surface?: ControlSurface;
  readonly contentLayout?: ButtonContentLayout;
}

/** Stable DOM and focus across visual changes; operation state stays with callers. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children, className, disabled = false, loading = false, density = "default",
  size = defaultButtonSize, variant = defaultButtonVariant, surface = "integrated",
  contentLayout = "label", type = "button", ...props
}, ref) {
  return <button {...props} ref={ref} type={type}
    className={["ui-button", className].filter(Boolean).join(" ")}
    data-size={size} data-density={density} data-variant={variant}
    data-control-surface={surface} data-content-layout={contentLayout}
    data-control-loading={loading || undefined}
    aria-busy={loading || props["aria-busy"]} disabled={disabled || loading}>
    <LiquidGlassBackdrop active={surface === "floating"} />
    {loading ? <LoadingRingIcon size={14} className="ui-button__spinner" aria-hidden="true" /> : null}
    {contentLayout === "row" ? children : <span className="ui-button__label">{children}</span>}
  </button>;
});

export interface IconButtonProps extends Omit<ButtonProps, "contentLayout"> {
  readonly "aria-label": string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  size = "chrome", variant = "ghost", ...props
}, ref) {
  return <Button {...props} ref={ref} size={size} variant={variant} contentLayout="icon" />;
});

export type DisclosureButtonProps = Omit<ButtonProps, "variant" | "surface" | "contentLayout">;

/** Menu/popover owners supply open state; every quiet disclosure shares feedback. */
export const DisclosureButton = forwardRef<HTMLButtonElement, DisclosureButtonProps>(function DisclosureButton({
  size = "accessory", className, ...props
}, ref) {
  return <Button {...props} ref={ref} className={["ui-disclosure-button", className].filter(Boolean).join(" ")}
    size={size} variant="ghost" surface="integrated" contentLayout="row" />;
});

/** Non-interactive measurement twin consumes the same geometry as the real action. */
export const ButtonPlaceholder = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & {
  size?: ButtonSize; contentLayout?: ButtonContentLayout;
}>(function ButtonPlaceholder({ className, size = "chrome", contentLayout = "icon", children, ...props }, ref) {
  return <span {...props} ref={ref} aria-hidden="true" className={["ui-button", className].filter(Boolean).join(" ")}
    data-size={size} data-density="default" data-variant="ghost"
    data-content-layout={contentLayout} data-control-surface="integrated">{children}</span>;
});
