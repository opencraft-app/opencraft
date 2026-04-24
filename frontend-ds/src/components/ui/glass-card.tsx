import * as React from "react";
import { cn } from "@/lib/utils";

interface GlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const GlassCard = React.forwardRef<HTMLDivElement, GlassCardProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "bg-white/88 border border-black/5 shadow-[0_4px_24px_rgba(0,0,0,0.03),0_1px_2px_rgba(0,0,0,0.02)]",
          "backdrop-blur-2xl backdrop-saturate-150 rounded-2xl transition-all duration-300",
          "hover:bg-white/95 hover:shadow-[0_8px_32px_rgba(0,0,0,0.05),0_2px_8px_rgba(0,0,0,0.02)] hover:-translate-y-1 hover:border-black/10",
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);
GlassCard.displayName = "GlassCard";
