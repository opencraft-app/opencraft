import type { PropsWithChildren, ReactNode } from "react";
import { GrammarPanel } from "@/components/site/homepage-grammar";
import { DisplayTitle } from "@/components/ui/display-title";

interface ConfigSectionProps extends PropsWithChildren {
  title: string;
  description: string;
  icon?: ReactNode;
}

export const ConfigSection = ({ title, description, icon, children }: ConfigSectionProps) => {
  return (
    <GrammarPanel className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {icon}
          <DisplayTitle as="span" size="section" className="text-lg sm:text-xl">
            {title}
          </DisplayTitle>
        </div>
        <p className="text-sm leading-7 text-[var(--text-secondary)]">{description}</p>
      </div>
      <div className="space-y-4">{children}</div>
    </GrammarPanel>
  );
};
