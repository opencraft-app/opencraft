// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

interface AgentSectionHeaderProps {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
  actionsClassName?: string;
}

export const AgentSectionHeader = ({
  title,
  description,
  actions,
  className,
  actionsClassName,
}: AgentSectionHeaderProps) => {
  return (
    <header className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        <h2 className="text-[18px] font-semibold leading-6 tracking-normal text-black/[0.95]">{title}</h2>
        <p className="mt-1 text-sm font-medium leading-6 text-black/50">{description}</p>
      </div>
      {actions ? <div className={cn("shrink-0", actionsClassName)}>{actions}</div> : null}
    </header>
  );
};
