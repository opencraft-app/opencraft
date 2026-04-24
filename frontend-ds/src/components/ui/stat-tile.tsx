import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
  valueClassName?: string;
}

export const StatTile = ({ label, value, hint, className, valueClassName }: StatTileProps) => {
  return (
    <div
      className={cn("rounded-[1.25rem] border p-4", className)}
      style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.78)", boxShadow: "var(--lw-shadow-base)" }}
    >
        <p className="text-xs tracking-[0.12em] text-[var(--text-tertiary)]">{label}</p>
        <p className={cn("mt-2 font-heading text-xl font-semibold text-[var(--text-primary)]", valueClassName)}>{value}</p>
        {hint ? <p className="mt-1 text-sm text-[var(--text-secondary)]">{hint}</p> : null}
    </div>
  );
};
