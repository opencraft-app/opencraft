import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const LOGO_URL = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/5affb0c4-cfed-4614-aa34-6868d88f1717.svg";

interface BrandMarkProps {
  to: string;
  className?: string;
  labelClassName?: string;
}

export const BrandMark = ({ to, className, labelClassName }: BrandMarkProps) => {
  return (
    <Link to={to} className={cn("flex shrink-0 items-center gap-2", className)}>
      <img src={LOGO_URL} alt="LightClaw" className="h-8 w-auto object-contain" />
      <span className={cn("font-heading text-sm font-semibold tracking-tight", labelClassName)}>Lightclaw</span>
    </Link>
  );
};
