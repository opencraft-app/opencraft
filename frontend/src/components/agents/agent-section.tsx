import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { agentPanelClassName } from "./styles";

export interface AgentSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  contentClassName?: string;
}

export function AgentSection({ title, description, actions, headingLevel = 2, className, contentClassName, children, ...props }: AgentSectionProps) {
  const titleId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section aria-labelledby={titleId} className={cn(agentPanelClassName, "min-w-0 p-4 sm:p-5", className)} {...props}>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Heading id={titleId} className="text-balance text-base font-semibold text-[var(--text-primary)]">{title}</Heading>
          {description && <div className="mt-1 text-pretty text-sm leading-6 text-[var(--text-secondary)]">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("min-w-0", contentClassName)}>{children}</div>
    </section>
  );
}
