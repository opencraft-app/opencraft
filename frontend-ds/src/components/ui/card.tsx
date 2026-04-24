import type { HTMLAttributes } from "react";
import { floatingPanelClass } from "@/components/ui/control-shell";
import { displayTitleClass } from "@/components/ui/display-title";
import { cn } from "@/lib/utils";

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "rounded-[1.75rem]",
      floatingPanelClass,
      className,
    )}
    {...props}
  />
);

export const CardHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("space-y-1.5 p-5", className)} {...props} />
);

export const CardTitle = ({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
  <h3
    className={displayTitleClass("card", className)}
    {...props}
  />
);

export const CardDescription = ({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("text-sm text-[var(--text-secondary)]", className)} {...props} />
);

export const CardContent = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-5 pb-5", className)} {...props} />
);

export const CardFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center p-5 pt-0", className)} {...props} />
);
