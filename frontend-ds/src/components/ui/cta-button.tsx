import * as React from "react";
import { cn } from "@/lib/utils";

interface CtaButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  icon?: React.ReactNode;
}

export const CtaButton = React.forwardRef<HTMLButtonElement, CtaButtonProps>(
  ({ className, children, icon, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-full font-bold transition-all",
          "h-16 px-8 text-base bg-[#1D1D1D] text-white",
          "hover:bg-black hover:-translate-y-[1px] hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#1D1D1D]/20",
          className
        )}
        {...props}
      >
        {children}
        {icon && <span className="flex items-center">{icon}</span>}
      </button>
    );
  }
);
CtaButton.displayName = "CtaButton";
