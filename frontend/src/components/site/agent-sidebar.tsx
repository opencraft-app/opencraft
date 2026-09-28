import { useEffect, useRef, useState, type ReactNode } from "react";

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
      className="lv-agents-sidebar lv-agents-sidebar-scroll-isolated"
      data-scroll-above={edges.above}
      data-scroll-below={edges.below}
    >
      {children}
    </aside>
  );
}
