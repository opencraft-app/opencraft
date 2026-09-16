import { useId, type ReactNode } from "react";
import { AppLink } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";

export interface ConsoleNavigationItem { id: string; label: string; href: string; icon: ReactNode; badge?: string }
export interface ConsoleNavigationGroup { id: string; label: string; sections: readonly ConsoleNavigationItem[] }

export function ConsoleNavigation({ label, groups, extraItems = [], activeId, onNavigate }: { label: string; groups: readonly ConsoleNavigationGroup[]; extraItems?: readonly ConsoleNavigationItem[]; activeId: string; onNavigate?: () => void }) {
  const prefix = useId();
  const renderItem = (section: ConsoleNavigationItem) => <li key={section.id}>
    <AppLink to={section.href} onClick={onNavigate} aria-label={section.badge ? section.label : undefined} aria-current={section.id === activeId ? "page" : undefined} className={cn("lw-settings-nav-item lv-agents-nav-item", section.badge && "has-badge", section.id === activeId ? "is-active" : "text-black/70 hover:bg-black/[0.025]")}>
      <span className="lv-agents-nav-icon" aria-hidden="true">{section.icon}</span><span className="min-w-0 flex-1 text-left">{section.label}</span>
      {section.badge && <span className="shrink-0 rounded-full border border-black/[0.08] bg-black/[0.025] px-1.5 py-0.5 text-[9px] font-bold leading-none text-black/45">{section.badge}</span>}
    </AppLink>
  </li>;
  return <nav aria-label={label} className="lv-agents-nav">
    {extraItems.length > 0 && <div className="lv-agents-nav-group"><ul className="lv-agents-nav-group-items">{extraItems.map(renderItem)}</ul></div>}
    {groups.map((group) => <div key={group.id} className="lv-agents-nav-group" role="group" aria-labelledby={`${prefix}-${group.id}`}>
      <span id={`${prefix}-${group.id}`} className="lv-agents-nav-group-label">{group.label}</span><ul className="lv-agents-nav-group-items">{group.sections.map(renderItem)}</ul>
    </div>)}
  </nav>;
}
