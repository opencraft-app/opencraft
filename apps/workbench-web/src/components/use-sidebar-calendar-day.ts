import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";

export function sidebarCalendarDay(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function sidebarNextCalendarDay(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

/** One presentation clock per Sidebar, never per row or catalog request.
 * Calendar constructors respect local DST; resume reconciles suspended tabs.
 * A midnight commit changes headings only, not catalog order or row identity. */
function useCalendarDayClock(): number {
  const [day, setDay] = useState(() => sidebarCalendarDay(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (timer !== undefined) clearTimeout(timer);
      const now = Date.now();
      setDay(sidebarCalendarDay(now));
      timer =
        document.visibilityState === "hidden"
          ? undefined
          : setTimeout(refresh, Math.max(1, sidebarNextCalendarDay(now) - now));
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return day;
}

const SidebarCalendarDayContext = createContext<number | null>(null);

/** The clock updates only date-heading consumers, not the catalog/summary owner. */
export function SidebarCalendarDayProvider({ children }: { readonly children: ReactNode }) {
  const day = useCalendarDayClock();
  return createElement(SidebarCalendarDayContext.Provider, { value: day }, children);
}

export function useSidebarCalendarDay(): number {
  const day = useContext(SidebarCalendarDayContext);
  if (day === null) throw new Error("SidebarCalendarDayProvider is missing");
  return day;
}
