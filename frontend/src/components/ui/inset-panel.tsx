import type { HTMLAttributes } from "react";
import { Card } from "@/components/ui/card";
import { insetPanelToneClass } from "@/components/ui/control-shell";
import { cn } from "@/lib/utils";

export const InsetPanel = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <Card className={cn("rounded-[1.5rem]", insetPanelToneClass, className)} {...props} />
);
