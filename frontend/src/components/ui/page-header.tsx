import type { ReactNode } from "react";
import { DisplayTitle, type DisplayTitleSize } from "@/components/ui/display-title";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
  titleSize?: DisplayTitleSize;
}

export const PageHeader = ({
  title,
  description,
  action,
  eyebrow,
  className,
  titleClassName,
  descriptionClassName,
  titleSize = "page",
}: PageHeaderProps) => {
  return (
    <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="space-y-1.5">
        {eyebrow ? <div>{eyebrow}</div> : null}
        <DisplayTitle size={titleSize} className={titleClassName}>
          {title}
        </DisplayTitle>
        {description ? (
          <p className={cn("max-w-2xl text-sm leading-6 text-[var(--text-secondary)]", descriptionClassName)}>{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
};
