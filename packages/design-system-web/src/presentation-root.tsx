import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from "react";

/**
 * Physical DOM owner for every Workbench overlay, menu, dialog and drag layer.
 * Full-page Workbench uses the document root; embedded presentations provide a
 * Shadow-DOM-local element so primitives retain styles, focus and geometry.
 */
const WorkbenchPresentationRootContext = createContext<HTMLElement | null>(null);

export function WorkbenchPresentationRootProvider({
  children,
  target,
}: {
  readonly children: ReactNode;
  readonly target: HTMLElement;
}) {
  return (
    <WorkbenchPresentationRootContext.Provider value={target}>
      {children}
    </WorkbenchPresentationRootContext.Provider>
  );
}

export function useWorkbenchPresentationRoot(): HTMLElement | null {
  return useContext(WorkbenchPresentationRootContext);
}

const OverlayPresentationContext = createContext({ active: true, current: true });

/** Logical ownership survives portalling to a different DOM layer. */
export function OverlayPresentationScope({ active, children }: { active: boolean; children: ReactNode }) {
  const scopeActive = useOverlayPresentationActive() && active;
  const scope = useMemo(() => ({ active: scopeActive, current: scopeActive }), [scopeActive]);
  useLayoutEffect(() => {
    scope.current = scope.active;
    return () => { scope.current = false; };
  }, [scope]);
  return <OverlayPresentationContext.Provider value={scope}>{children}</OverlayPresentationContext.Provider>;
}

export function useOverlayPresentationScope() {
  return useContext(OverlayPresentationContext);
}

export function useOverlayPresentationActive(): boolean {
  return useOverlayPresentationScope().active;
}
