// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all duration-250 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--text-primary)] text-white shadow-[var(--shadow-soft)] hover:translate-y-[-1px] hover:bg-[color-mix(in_oklab,var(--text-primary)_88%,white)]",
        secondary:
          "bg-[var(--surface-contrast)] text-[var(--text-primary)] shadow-[0_18px_38px_-22px_rgba(0,0,0,0.42)] hover:translate-y-[-1px] hover:bg-[color-mix(in_oklab,var(--surface-contrast)_92%,white)]",
        outline:
          "border border-[var(--border-strong)] bg-[color-mix(in_oklab,var(--surface-base)_90%,white)] text-[var(--text-primary)] hover:border-[var(--text-primary)] hover:bg-[var(--surface-muted)]",
        hero:
          "border border-white/18 bg-white/4 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:border-white/28 hover:bg-white/10",
        ghost: "text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]",
        destructive: "bg-[var(--danger)] text-white hover:brightness-95",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-6 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

const buttonColorStyles: Record<NonNullable<ButtonProps["variant"]>, React.CSSProperties> = {
  default: { color: "white" },
  secondary: { color: "var(--text-primary)" },
  outline: { color: "var(--text-primary)" },
  hero: { color: "white" },
  ghost: { color: "var(--text-secondary)" },
  destructive: { color: "white" },
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, style, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const resolvedVariant = variant ?? "default";

    return (
      <Comp
        className={cn(buttonVariants({ variant: resolvedVariant, size, className }))}
        ref={ref}
        style={{ ...buttonColorStyles[resolvedVariant], ...style }}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
