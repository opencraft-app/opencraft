import { Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  to: string;
  className?: string;
  labelClassName?: string;
}

export const BrandMark = ({ to, className, labelClassName }: BrandMarkProps) => {
  return (
    <Link to={to} className={cn("flex shrink-0 items-center gap-2", className)}>
      <span className="flex size-8 items-center justify-center rounded-2xl bg-[var(--text-primary)] text-white shadow-[var(--shadow-soft)]">
        <Sparkles className="size-4" />
      </span>
      <span className={cn("font-heading text-sm font-semibold tracking-tight", labelClassName)}>Lightclaw</span>
    </Link>
  );
};
