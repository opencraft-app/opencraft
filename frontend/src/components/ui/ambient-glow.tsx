import * as React from "react";
import { cn } from "@/lib/utils";

interface AmbientGlowProps extends React.HTMLAttributes<HTMLDivElement> {
  color?: "red-yellow" | "purple" | "green" | "orange";
}

export const AmbientGlow = React.forwardRef<HTMLDivElement, AmbientGlowProps>(
  ({ className, color = "red-yellow", ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "absolute rounded-full pointer-events-none filter blur-[100px]",
          {
            "bg-gradient-to-b from-transparent to-[#FF3E3E] mix-blend-multiply opacity-30": color === "red-yellow", // Simulated red-yellow glow
            "bg-[#DCC6FF] opacity-40": color === "purple",
            "bg-[#90FFFD] opacity-40": color === "green",
            "bg-[#FFEED8] opacity-60": color === "orange",
          },
          className
        )}
        {...props}
      />
    );
  }
);
AmbientGlow.displayName = "AmbientGlow";
