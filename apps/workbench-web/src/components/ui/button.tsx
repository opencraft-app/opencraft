import { LoadingRingIcon } from "@opencraft/design-system-web/action-icons";
import {
  defaultButtonSize,
  defaultButtonVariant,
  type ButtonSize,
  type ButtonVariant,
} from "@opencraft/design-system/button";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  readonly children: ReactNode;
  readonly loading?: boolean;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  /** Web presentation density; shared geometry lives in the design system. */
  readonly density?: "default" | "compact";
}

/** Web adapter for the same button contract used by the Expo renderer. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
    children,
    className,
    disabled = false,
    loading = false,
    density = "default",
    size = defaultButtonSize,
    type = "button",
    variant = defaultButtonVariant,
    ...props
  }, ref) {
    const classes = className === undefined ? "ui-button" : `ui-button ${className}`;
    return (
      <button
        {...props}
        ref={ref}
        aria-busy={loading || undefined}
        className={classes}
        data-size={size}
        data-density={density}
        data-variant={variant}
        disabled={disabled || loading}
        type={type}
      >
        {loading ? <LoadingRingIcon size={14} className="ui-button__spinner" /> : null}
        <span className="ui-button__label">{children}</span>
      </button>
    );
  });
