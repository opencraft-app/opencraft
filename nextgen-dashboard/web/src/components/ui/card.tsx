import * as React from "react";

import { cn } from "../../lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-[0_12px_36px_rgba(17,24,39,0.08)]",
          className,
        )}
        {...props}
      />
    );
  },
);

Card.displayName = "Card";

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn("flex flex-col gap-2 p-5 pb-0", className)} {...props} />;
  },
);

CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => {
    return (
      <h2
        ref={ref}
        className={cn("text-sm font-semibold tracking-[0.18em] text-[var(--text-secondary)] uppercase", className)}
        {...props}
      />
    );
  },
);

CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    return <p ref={ref} className={cn("text-sm text-[var(--text-secondary)]", className)} {...props} />;
  },
);

CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return <div ref={ref} className={cn("p-5", className)} {...props} />;
  },
);

CardContent.displayName = "CardContent";
