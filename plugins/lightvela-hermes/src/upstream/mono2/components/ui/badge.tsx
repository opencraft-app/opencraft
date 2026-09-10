// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium leading-none",
  {
    variants: {
      variant: {
        neutral: "bg-[var(--surface-muted)] text-[var(--text-secondary)]",
        success: "bg-[color-mix(in_oklab,var(--success)_14%,white)] text-[var(--success)]",
        warning: "bg-[color-mix(in_oklab,var(--warning)_20%,white)] text-[var(--warning)]",
        danger: "bg-[color-mix(in_oklab,var(--danger)_16%,white)] text-[var(--danger)]",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export const Badge = ({ className, variant, ...props }: BadgeProps) => {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
};
