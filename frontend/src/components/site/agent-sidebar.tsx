import { PanelLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useT } from "@/i18n/t";

const COLLAPSED_STORAGE_KEY = "lv-agent-sidebar-collapsed";

export function useAgentSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true");
    } catch {
      // Browser storage may be unavailable; the sidebar still works for this visit.
    }
  }, []);

  const toggle = () => setCollapsed((current) => {
    const next = !current;
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
    } catch {
      // Keep the in-memory setting when browser storage is unavailable.
    }
    return next;
  });

  return { collapsed, toggle };
}

export function AgentSidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const t = useT();
  const label = collapsed ? t("展开导航") : t("收起导航");

  return (
    <button
      type="button"
      className="lv-agent-sidebar-toggle hidden lg:inline-flex"
      aria-label={label}
      aria-controls="lv-agent-sidebar-navigation"
      aria-expanded={!collapsed}
      data-tooltip={label}
      onClick={onToggle}
    >
      <PanelLeft className="size-[18px]" strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

/** Owns only desktop sidebar scrolling; page controllers retain navigation and Bot actions. */
export function AgentSidebar({ children }: { children: ReactNode }) {
  const sidebarRef = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const middle = sidebar?.querySelector<HTMLElement>(".lv-agents-sidebar-middle");
    const content = middle?.firstElementChild;
    if (!middle || !content) return;
    const measure = () => {
      const remaining = middle.scrollHeight - middle.clientHeight;
      const above = remaining > 1 && middle.scrollTop > 1;
      const below = remaining > 1 && remaining - middle.scrollTop > 1;
      setEdges(current => current.above === above && current.below === below ? current : { above, below });
    };
    measure();
    middle.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(middle);
    observer?.observe(content);
    return () => {
      middle.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);
  return (
    <aside
      ref={sidebarRef}
      id="lv-agent-sidebar-navigation"
      className="lv-agents-sidebar lv-agents-sidebar-scroll-isolated"
      data-scroll-above={edges.above}
      data-scroll-below={edges.below}
    >
      {children}
    </aside>
  );
}
