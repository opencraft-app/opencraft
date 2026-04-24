import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { assetUrl } from "@/lib/asset-url";

const LOGO_URL = assetUrl("/lightvela-logo.svg");

interface BrandMarkProps {
  to: string;
  className?: string;
}

export const BrandMark = ({ to, className }: BrandMarkProps) => {
  return (
    <Link to={to} className={cn("flex shrink-0 items-center", className)}>
      <img src={LOGO_URL} alt="LightVela" className="h-8 w-auto object-contain" />
    </Link>
  );
};
