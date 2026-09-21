import { createContext, useContext, type ReactNode } from "react";

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
