import type { HTMLAttributes } from "react";
import { CardContent } from "@/components/ui/card";
import { InsetPanel } from "@/components/ui/inset-panel";
import { cn } from "@/lib/utils";

export const ComposerPanel = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <InsetPanel className={cn("rounded-2xl bg-white", className)}>
    <CardContent className="flex flex-col gap-2 p-3 sm:flex-row" {...props} />
  </InsetPanel>
);
