import type { ReactNode } from "react";

export interface MobileMenuFocusProps {
  children: ReactNode;
  dismiss: () => void;
  allowReturnFocus: () => boolean;
}

// Native Menu owns the portal/accessibility window. The Web adapter supplies
// browser focus primitives without owning a second menu state or geometry.
export function MobileMenuFocus({ children }: MobileMenuFocusProps) { return <>{children}</>; }
export function MobileMenuFocusItem({ children }: { children: ReactNode; disabled?: boolean }) { return <>{children}</>; }
