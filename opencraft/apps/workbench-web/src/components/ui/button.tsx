import {
  defaultButtonSize,
  defaultButtonVariant,
  type ButtonSize,
  type ButtonVariant,
} from "@opencraft/design-system/button";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly children: ReactNode;
  readonly loading?: boolean;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
}

/** Web adapter for the same button contract used by the Expo renderer. */
export function Button({
  children,
  className,
  disabled = false,
  loading = false,
  size = defaultButtonSize,
  type = "button",
  variant = defaultButtonVariant,
  ...props
}: ButtonProps) {
  const classes = className === undefined ? "ui-button" : `ui-button ${className}`;
  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={classes}
      data-size={size}
      data-variant={variant}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <span aria-hidden="true" className="ui-button__spinner" /> : null}
      <span className="ui-button__label">{children}</span>
    </button>
  );
}
