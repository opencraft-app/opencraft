import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default:
          "border-[var(--primary)] bg-[var(--primary)] px-4 py-2 text-[var(--primary-foreground)] hover:bg-[var(--primary-dark)]",
        ghost:
          "border-transparent px-3 py-2 text-[var(--text-secondary)] hover:border-[var(--border)] hover:bg-[var(--muted)] hover:text-[var(--text-primary)]",
      },
      size: {
        default: "h-10",
        sm: "h-8 px-3 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);

Button.displayName = "Button";

export { Button, buttonVariants };
