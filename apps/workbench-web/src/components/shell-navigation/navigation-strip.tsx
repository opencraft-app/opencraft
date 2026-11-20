import type { ReactNode } from "react";

/** One footer row; the host scrolls excess destinations without paging/remounts. */
export function NavigationStrip({ children }: { children: ReactNode }) {
  return <div className="shell-navigation-strip">{children}</div>;
}
