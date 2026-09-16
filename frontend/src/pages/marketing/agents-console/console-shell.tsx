import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { agentButtonClassName, agentPortalClassName } from "@/components/agents";

export interface AgentConsoleShellProps {
  desktop: boolean;
  navigationOpen: boolean;
  onNavigationOpenChange: (open: boolean) => void;
  title: string;
  navigationLabel: string;
  closeLabel: string;
  profile: ReactNode;
  navigation: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

export function AgentConsoleShell({ desktop, navigationOpen, onNavigationOpenChange, title, navigationLabel, closeLabel, profile, navigation, footer, children }: AgentConsoleShellProps) {
  const middleRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const middle = middleRef.current;
    const content = navigationRef.current;
    if (!desktop || !middle || !content) return;
    let active = true;
    const measure = () => {
      if (!active) return;
      const remaining = middle.scrollHeight - middle.clientHeight;
      const above = remaining > 1 && middle.scrollTop > 1;
      const below = remaining > 1 && remaining - middle.scrollTop > 1;
      setScrollEdges((current) => current.above === above && current.below === below ? current : { above, below });
    };
    measure();
    middle.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(middle);
    observer?.observe(content);
    return () => {
      active = false;
      middle.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [desktop]);
  return (
    <div className="lv-agent-settings-grid grid items-start gap-6 lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="lv-agents-sidebar lv-agents-sidebar-scroll-isolated" data-scroll-above={desktop && scrollEdges.above} data-scroll-below={desktop && scrollEdges.below}>
        <div className="lv-agents-sidebar-profile">{profile}</div>
        {desktop ? <>
          <div ref={middleRef} className="lv-agents-sidebar-middle"><div ref={navigationRef} className="flow-root">{navigation}</div></div>
          {footer && <div className="lv-agents-sidebar-footer">{footer}</div>}
        </> : (
          <div className="flex min-w-0 items-center gap-3 border-t border-[var(--border-subtle)] pt-3">
            <Sheet open={navigationOpen} onOpenChange={onNavigationOpenChange}>
              <SheetTrigger asChild><Button type="button" variant="outline" className={agentButtonClassName} aria-label={navigationLabel}><Menu className="size-4" aria-hidden="true" /></Button></SheetTrigger>
              <SheetContent side="left" portalClassName={agentPortalClassName} closeLabel={closeLabel} aria-describedby={undefined} className="lv-agents-navigation-sheet">
                <SheetTitle className="mb-2 pr-9 text-lg tracking-normal">{navigationLabel}</SheetTitle>
                {navigation}
                {footer}
              </SheetContent>
            </Sheet>
            <h1 className="min-w-0 text-balance text-base font-semibold">{title}</h1>
          </div>
        )}
      </aside>
      <section className="lv-agent-settings-content min-w-0 lg:col-start-2">{children}</section>
    </div>
  );
}
